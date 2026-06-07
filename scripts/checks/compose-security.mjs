import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const composePath = fileURLToPath(new URL("../../docker-compose.yml", import.meta.url));
const compose = readFileSync(composePath, "utf8");

const requiredSnippets = [
  "path: ./apps/web/.env.local",
  "required: false",
  "PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: ${PATCHBAY_REQUIRE_ENROLLMENT_TOKEN:-true}",
  "PATCHBAY_REQUIRE_AGENT_TOKEN: ${PATCHBAY_REQUIRE_AGENT_TOKEN:-true}"
];

const forbiddenSnippets = [
  "PATCHBAY_OPERATOR_TOKEN: ${PATCHBAY_OPERATOR_TOKEN:-}",
  "PATCHBAY_ENROLLMENT_SECRET: ${PATCHBAY_ENROLLMENT_SECRET:-change-me-local-secret}",
  "PATCHBAY_AGENT_AUTH_SECRET: ${PATCHBAY_AGENT_AUTH_SECRET:-change-me-local-agent-secret}",
  "GEMINI_API_KEY: ${GEMINI_API_KEY:-}",
  "TAILSCALE_OAUTH_CLIENT_SECRET: ${TAILSCALE_OAUTH_CLIENT_SECRET:-}",
  "PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: ${PATCHBAY_REQUIRE_ENROLLMENT_TOKEN:-false}",
  "PATCHBAY_REQUIRE_AGENT_TOKEN: ${PATCHBAY_REQUIRE_AGENT_TOKEN:-false}",
  "change-me-local-secret",
  "change-me-local-agent-secret"
];

const failures = [];

for (const snippet of requiredSnippets) {
  if (!compose.includes(snippet)) {
    failures.push(`docker-compose.yml is missing required secure setting: ${snippet}`);
  }
}

for (const snippet of forbiddenSnippets) {
  if (compose.includes(snippet)) {
    failures.push(`docker-compose.yml contains forbidden insecure setting: ${snippet}`);
  }
}

try {
  execFileSync("docker", ["compose", "config", "--quiet", "--no-env-resolution"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: "pipe"
  });
} catch (error) {
  failures.push(
    `docker compose config validation failed: ${error instanceof Error ? error.message : String(error)}`
  );
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Compose security check passed.");
