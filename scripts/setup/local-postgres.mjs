import { spawnSync } from "node:child_process";

const expectedTables = [
  "agents",
  "audit_log",
  "environments",
  "session_tasks",
  "sessions",
  "syntheses",
  "task_events"
];

main();

function main() {
  run("docker", ["compose", "up", "-d", "postgres"], {
    dockerHint: true
  });

  waitForPostgres();

  run("pnpm", ["db:migrate"]);

  const tables = queryTables();
  const missingTables = expectedTables.filter((table) => !tables.includes(table));
  if (missingTables.length > 0) {
    fail(`Patchbay schema is missing table(s): ${missingTables.join(", ")}`);
  }

  console.log(`Patchbay local Postgres is ready with ${tables.length} table(s).`);
}

function waitForPostgres() {
  const attempts = 30;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(
      "docker",
      ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "patchbay", "-d", "patchbay"],
      {
        encoding: "utf8",
        stdio: attempt === attempts ? "inherit" : "pipe"
      }
    );

    if (result.status === 0) {
      return;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }

  fail("Timed out waiting for local Postgres to become ready.");
}

function queryTables() {
  const result = run(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "patchbay",
      "-d",
      "patchbay",
      "-Atc",
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
    ],
    {
      capture: true
    }
  );

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function run(command, args, options = {}) {
  const shouldCapture = options.capture || options.dockerHint;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: shouldCapture ? "pipe" : "inherit"
  });

  if (result.status === 0) {
    if (options.dockerHint) {
      printOutput(result);
    }
    return result;
  }

  printOutput(result);

  if (options.dockerHint && isDockerUnavailable(result)) {
    fail("Docker is not reachable. Start Docker Desktop, then rerun pnpm db:local.");
  }

  if (result.error?.code === "ENOENT") {
    fail(`Command not found: ${command}`);
  }

  const rendered = [command, ...args].join(" ");
  fail(`Command failed: ${rendered}`);
}

function isDockerUnavailable(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.includes("Cannot connect to the Docker daemon");
}

function printOutput(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
