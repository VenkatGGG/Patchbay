import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const files = {
  overlay: "docker-compose.production.yml",
  caddy: "ops/Caddyfile",
  backup: "scripts/ops/backup-postgres.mjs",
  restore: "scripts/ops/restore-postgres.mjs"
};
const failures = [];

for (const [label, relativePath] of Object.entries(files)) {
  if (!existsSync(`${root}/${relativePath}`)) {
    failures.push(`production deployment is missing ${label}: ${relativePath}`);
  }
}

if (failures.length === 0) {
  const overlay = readFileSync(`${root}/${files.overlay}`, "utf8");
  const caddy = readFileSync(`${root}/${files.caddy}`, "utf8");
  const backup = readFileSync(`${root}/${files.backup}`, "utf8");
  const restore = readFileSync(`${root}/${files.restore}`, "utf8");

  for (const snippet of [
    "127.0.0.1:3000:3000",
    "ports: !override",
    "healthcheck:",
    "caddy:2-alpine",
    "PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: ${PATCHBAY_REQUIRE_ENROLLMENT_TOKEN:-true}",
    "PATCHBAY_REQUIRE_AGENT_TOKEN: ${PATCHBAY_REQUIRE_AGENT_TOKEN:-true}",
    "./ops/Caddyfile:/etc/caddy/Caddyfile:ro",
    "condition: service_healthy"
  ]) {
    if (!overlay.includes(snippet)) {
      failures.push(`production overlay is missing required setting: ${snippet}`);
    }
  }

  for (const snippet of ["{$PATCHBAY_DOMAIN}", "reverse_proxy web:3000"]) {
    if (!caddy.includes(snippet)) {
      failures.push(`Caddyfile is missing required setting: ${snippet}`);
    }
  }

  for (const [label, script] of [["backup", backup], ["restore", restore]]) {
    for (const snippet of ["DATABASE_URL", "PGHOST", "never print"] ) {
      if (!script.includes(snippet)) {
        failures.push(`${label} script is missing credential-safe contract: ${snippet}`);
      }
    }
  }

  for (const relativePath of [files.backup, files.restore]) {
    if (readFileSync(`${root}/${relativePath}`, "utf8").includes("console.log(process.env.DATABASE_URL")) {
      failures.push(`${relativePath} must not print DATABASE_URL`);
    }
  }

  try {
    execFileSync(
      "docker",
      [
        "compose",
        "-f",
        `${root}/docker-compose.yml`,
        "-f",
        `${root}/docker-compose.production.yml`,
        "config",
        "--quiet",
        "--no-env-resolution"
      ],
      { cwd: root, stdio: "pipe" }
    );
  } catch (error) {
    failures.push(
      `production compose config validation failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Production deployment check passed.");
