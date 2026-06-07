import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const templatePath = fileURLToPath(new URL("../../.env.example", import.meta.url));

const requiredKeys = [
  "PATCHBAY_LLM_PROVIDER",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_TIMEOUT_MS",
  "GEMINI_API_BASE_URL",
  "DATABASE_URL",
  "PATCHBAY_STORAGE",
  "PATCHBAY_OPERATOR_TOKEN",
  "PATCHBAY_REQUIRE_ENROLLMENT_TOKEN",
  "PATCHBAY_ENROLLMENT_SECRET",
  "PATCHBAY_REQUIRE_AGENT_TOKEN",
  "PATCHBAY_AGENT_AUTH_SECRET",
  "PATCHBAY_AGENT_TOKEN_TTL_MINUTES",
  "PATCHBAY_TASK_TIMEOUT_SECONDS",
  "TAILSCALE_TAILNET",
  "TAILSCALE_OAUTH_CLIENT_ID",
  "TAILSCALE_OAUTH_CLIENT_SECRET",
  "PATCHBAY_CONTROL_PLANE_URL",
  "PATCHBAY_ENVIRONMENT_ID",
  "PATCHBAY_AGENT_NAME",
  "PATCHBAY_ENROLLMENT_TOKEN",
  "PATCHBAY_TAILSCALE_UP",
  "PATCHBAY_POLL_INTERVAL"
];

const secretKeysThatMustStayBlank = [
  "GEMINI_API_KEY",
  "PATCHBAY_OPERATOR_TOKEN",
  "PATCHBAY_ENROLLMENT_SECRET",
  "PATCHBAY_AGENT_AUTH_SECRET",
  "TAILSCALE_OAUTH_CLIENT_SECRET"
];

const template = readFileSync(templatePath, "utf8");
const values = new Map();
const duplicateKeys = new Set();

for (const line of template.split("\n")) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
  if (!match) {
    continue;
  }

  const [, key, value] = match;
  if (values.has(key)) {
    duplicateKeys.add(key);
  }
  values.set(key, value);
}

const failures = [];

for (const key of requiredKeys) {
  if (!values.has(key)) {
    failures.push(`Missing required key in .env.example: ${key}`);
  }
}

for (const key of duplicateKeys) {
  failures.push(`Duplicate key in .env.example: ${key}`);
}

for (const key of secretKeysThatMustStayBlank) {
  const value = values.get(key);
  if (value && !value.startsWith("<")) {
    failures.push(`Secret template key must stay blank or placeholder-only: ${key}`);
  }
}

if (values.get("PATCHBAY_REQUIRE_ENROLLMENT_TOKEN") !== "true") {
  failures.push("PATCHBAY_REQUIRE_ENROLLMENT_TOKEN should default to true in .env.example");
}

if (values.get("PATCHBAY_REQUIRE_AGENT_TOKEN") !== "true") {
  failures.push("PATCHBAY_REQUIRE_AGENT_TOKEN should default to true in .env.example");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Env template check passed.");
