import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const port = Number(process.env.PATCHBAY_INTEGRATION_PORT ?? 3100);
const baseUrl = `http://127.0.0.1:${port}`;
const storageMode = process.env.PATCHBAY_INTEGRATION_STORAGE ?? "memory";
const databaseUrl = process.env.PATCHBAY_INTEGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const children = [];

async function main() {
  if (storageMode === "postgres") {
    assert(databaseUrl, "PATCHBAY_INTEGRATION_DATABASE_URL or DATABASE_URL is required for postgres integration tests");
    await migrateDatabase(databaseUrl);
  }

  const web = spawnProcess(
    "pnpm",
    ["--filter", "@patchbay/web", "exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
      PATCHBAY_ENROLLMENT_SECRET: "integration-secret",
      PATCHBAY_STORAGE: storageMode,
      DATABASE_URL: databaseUrl ?? "",
      GEMINI_API_KEY: "",
      PATCHBAY_LLM_PROVIDER: "gemini"
    }
  );
  children.push(web);

  await waitForJson("/api/state");

  await expectStatus(
    "unauthenticated enrollment is rejected",
    postJson("/api/agent/enroll", {
      environmentId: "env_local",
      name: "rejected-agent",
      version: "test",
      capabilities: ["system.info"]
    }),
    401
  );

  const tokenResponse = await postJson("/api/environments/env_local/enrollment-token", {
    ttlMinutes: 15
  });
  assert(tokenResponse.status === 200, "expected token mint endpoint to return 200");
  assert(tokenResponse.body.token, "expected enrollment token");

  const agent = spawnProcess(
    "go",
    ["run", "./agent/cmd/patchbay-agent"],
    {
      PATCHBAY_CONTROL_PLANE_URL: baseUrl,
      PATCHBAY_ENVIRONMENT_ID: "env_local",
      PATCHBAY_AGENT_NAME: "integration-agent",
      PATCHBAY_POLL_INTERVAL: "1s",
      PATCHBAY_ENROLLMENT_TOKEN: tokenResponse.body.token
    }
  );
  children.push(agent);

  await waitForCondition("agent enrollment", async () => {
    const state = await getJson("/api/state");
    return state.agents.some((candidate) => candidate.name === "integration-agent");
  });

  const sessionResponse = await postJson("/api/sessions", {
    environmentId: "env_local",
    name: "integration latency session",
    requestedBy: "integration-test",
    ttlMinutes: 30
  });
  assert(sessionResponse.status === 201, "expected session creation to return 201");
  const sessionId = sessionResponse.body.id;
  assert(sessionId, "expected session id");

  const diagnosticResponse = await postJson(
    `/api/sessions/${sessionId}/diagnostics`,
    { scenario: "latency_spike" }
  );
  assert(diagnosticResponse.status === 201, "expected diagnostics creation to return 201");
  assert(diagnosticResponse.body.length === 8, "expected all 8 read-only tasks");

  await waitForCondition("all diagnostic tasks to complete", async () => {
    const state = await getJson("/api/state");
    const tasks = state.tasks.filter((task) => task.sessionId === sessionId);
    return tasks.length === 8 && tasks.every((task) => task.status === "completed");
  });

  const synthesisResponse = await postJson(`/api/sessions/${sessionId}/synthesize`, {});
  assert(synthesisResponse.status === 201, "expected synthesis to return 201");
  assert(
    synthesisResponse.body.provider === "gemini:offline",
    `expected gemini offline fallback, got ${synthesisResponse.body.provider}`
  );
  assert(
    synthesisResponse.body.summary.includes("integration latency session"),
    "expected synthesis summary to reference the session"
  );

  const providerResponse = await getResponse("/api/llm/providers");
  assert(providerResponse.status === 200, "expected provider registry endpoint to return 200");
  assert(
    providerResponse.body.some((provider) => provider.id === "gemini"),
    "expected Gemini provider to be listed"
  );

  const finalState = await getJson("/api/state");
  const finalTasks = finalState.tasks.filter((task) => task.sessionId === sessionId);
  console.log(
    JSON.stringify(
      {
        ok: true,
        storage: storageMode,
        agents: finalState.agents.length,
        tasks: finalTasks.length,
        completed: finalTasks.filter((task) => task.status === "completed").length,
        syntheses: finalState.syntheses.length
      },
      null,
      2
    )
  );
}

async function migrateDatabase(connectionString) {
  const { stdout, stderr } = await execFileAsync(
    "pnpm",
    ["--filter", "@patchbay/web", "db:migrate"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: connectionString
      }
    }
  );
  if (stdout.trim()) {
    process.stdout.write(`[migrate] ${stdout}`);
  }
  if (stderr.trim()) {
    process.stderr.write(`[migrate] ${stderr}`);
  }
}

function spawnProcess(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => process.stdout.write(prefix(command, chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(prefix(command, chunk)));
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      process.stderr.write(`${command} exited with code ${code}\n`);
    }
    if (signal) {
      process.stderr.write(`${command} exited with signal ${signal}\n`);
    }
  });

  return child;
}

function prefix(command, chunk) {
  return String(chunk)
    .split("\n")
    .filter(Boolean)
    .map((line) => `[${command}] ${line}\n`)
    .join("");
}

async function waitForJson(path) {
  return waitForCondition(`GET ${path}`, async () => {
    try {
      await getJson(path);
      return true;
    } catch {
      return false;
    }
  });
}

async function waitForCondition(label, check, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function getJson(path) {
  const response = await getResponse(path);
  assert(response.status >= 200 && response.status < 300, `GET ${path} returned ${response.status}`);
  return response.body;
}

async function getResponse(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      accept: "application/json"
    }
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

async function postJson(path, payload, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(payload)
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({}))
  };
}

async function expectStatus(label, promise, status) {
  const response = await promise;
  assert(response.status === status, `${label}: expected ${status}, got ${response.status}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function cleanup() {
  for (const child of children.reverse()) {
    if (!child.killed) {
      killProcessGroup(child, "SIGTERM");
    }
  }
  await delay(500);
  for (const child of children.reverse()) {
    if (!child.killed) {
      killProcessGroup(child, "SIGKILL");
    }
  }
}

function killProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

try {
  await main();
} finally {
  await cleanup();
}
