import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(new URL("../../apps/web/db/schema.sql", import.meta.url));
const schema = readFileSync(schemaPath, "utf8");

const requiredConstraints = [
  "chk_environments_provider",
  "chk_agents_status",
  "chk_agents_capabilities",
  "chk_agents_tailscale_object",
  "chk_sessions_mode",
  "chk_sessions_status",
  "chk_sessions_allowed_capabilities",
  "chk_session_tasks_capability",
  "chk_session_tasks_status",
  "chk_task_events_level"
];

const requiredCapabilityLiterals = [
  "workload.discover",
  "cloud.metadata",
  "system.info",
  "process.list",
  "disk.usage",
  "network.connections",
  "logs.search",
  "docker.containers",
  "kubernetes.resources"
];

const requiredFragments = [
  "provider IN ('any', 'aws', 'gcp', 'kubernetes', 'vm', 'docker')",
  "status IN ('online', 'idle', 'offline')",
  "mode = 'read_only'",
  "status IN ('active', 'expired', 'closed')",
  "status IN ('queued', 'running', 'completed', 'failed', 'denied')",
  "level IN ('info', 'warning', 'error')",
  "jsonb_typeof(tailscale) = 'object'"
];

const failures = [];

for (const constraint of requiredConstraints) {
  if (!schema.includes(constraint)) {
    failures.push(`Missing schema constraint: ${constraint}`);
  }
}

for (const capability of requiredCapabilityLiterals) {
  if (!schema.includes(`'${capability}'`)) {
    failures.push(`Missing read-only capability in schema constraints: ${capability}`);
  }
}

for (const fragment of requiredFragments) {
  if (!schema.includes(fragment)) {
    failures.push(`Missing schema constraint fragment: ${fragment}`);
  }
}

if (!schema.includes("DO $$") || !schema.includes("pg_constraint")) {
  failures.push("Schema constraints should be idempotent through pg_constraint guards.");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Schema constraint check passed.");
