import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const currentDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(currentDir, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ??
  "postgres://patchbay:patchbay@localhost:5432/patchbay";

const expectedConstraints = [
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

const client = new Client({ connectionString });
let connected = false;
const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const ids = {
  environment: `env_schema_${suffix}`,
  agent: `agt_schema_${suffix}`,
  session: `sess_schema_${suffix}`,
  task: `task_schema_${suffix}`
};

try {
  await client.connect();
  connected = true;
  const schema = await readFile(schemaPath, "utf8");
  await client.query(schema);
  await client.query(schema);

  await assertConstraintsInstalled();
  await seedValidGraph();
  await assertRejectsConstraint(
    "invalid environment provider",
    "chk_environments_provider",
    `
      INSERT INTO environments (id, name, provider)
      VALUES ($1, 'Invalid provider', 'bare_metal')
    `,
    [`env_bad_provider_${suffix}`]
  );
  await assertRejectsConstraint(
    "invalid agent status",
    "chk_agents_status",
    `
      INSERT INTO agents (
        id,
        environment_id,
        name,
        version,
        status,
        capabilities,
        tailscale
      )
      VALUES ($1, $2, 'bad-status-agent', 'test', 'busy', $3, $4)
    `,
    [`agt_bad_status_${suffix}`, ids.environment, ["system.info"], "{}"]
  );
  await assertRejectsConstraint(
    "invalid agent capability",
    "chk_agents_capabilities",
    `
      INSERT INTO agents (
        id,
        environment_id,
        name,
        version,
        status,
        capabilities,
        tailscale
      )
      VALUES ($1, $2, 'bad-capability-agent', 'test', 'online', $3, $4)
    `,
    [`agt_bad_capability_${suffix}`, ids.environment, ["shell.exec"], "{}"]
  );
  await assertRejectsConstraint(
    "non-object tailscale state",
    "chk_agents_tailscale_object",
    `
      INSERT INTO agents (
        id,
        environment_id,
        name,
        version,
        status,
        capabilities,
        tailscale
      )
      VALUES ($1, $2, 'bad-tailscale-agent', 'test', 'online', $3, $4)
    `,
    [`agt_bad_tailscale_${suffix}`, ids.environment, ["system.info"], "[]"]
  );
  await assertRejectsConstraint(
    "invalid session mode",
    "chk_sessions_mode",
    `
      INSERT INTO sessions (
        id,
        environment_id,
        name,
        requested_by,
        mode,
        status,
        allowed_capabilities,
        expires_at
      )
      VALUES ($1, $2, 'bad-mode-session', 'schema-smoke', 'write', 'active', $3, now() + interval '1 hour')
    `,
    [`sess_bad_mode_${suffix}`, ids.environment, ["system.info"]]
  );
  await assertRejectsConstraint(
    "invalid session status",
    "chk_sessions_status",
    `
      INSERT INTO sessions (
        id,
        environment_id,
        name,
        requested_by,
        mode,
        status,
        allowed_capabilities,
        expires_at
      )
      VALUES ($1, $2, 'bad-status-session', 'schema-smoke', 'read_only', 'paused', $3, now() + interval '1 hour')
    `,
    [`sess_bad_status_${suffix}`, ids.environment, ["system.info"]]
  );
  await assertRejectsConstraint(
    "invalid session capability",
    "chk_sessions_allowed_capabilities",
    `
      INSERT INTO sessions (
        id,
        environment_id,
        name,
        requested_by,
        mode,
        status,
        allowed_capabilities,
        expires_at
      )
      VALUES ($1, $2, 'bad-capability-session', 'schema-smoke', 'read_only', 'active', $3, now() + interval '1 hour')
    `,
    [`sess_bad_capability_${suffix}`, ids.environment, ["shell.exec"]]
  );
  await assertRejectsConstraint(
    "invalid task capability",
    "chk_session_tasks_capability",
    `
      INSERT INTO session_tasks (
        id,
        session_id,
        agent_id,
        capability,
        params,
        status
      )
      VALUES ($1, $2, $3, 'shell.exec', '{}'::jsonb, 'queued')
    `,
    [`task_bad_capability_${suffix}`, ids.session, ids.agent]
  );
  await assertRejectsConstraint(
    "invalid task status",
    "chk_session_tasks_status",
    `
      INSERT INTO session_tasks (
        id,
        session_id,
        agent_id,
        capability,
        params,
        status
      )
      VALUES ($1, $2, $3, 'system.info', '{}'::jsonb, 'paused')
    `,
    [`task_bad_status_${suffix}`, ids.session, ids.agent]
  );
  await assertRejectsConstraint(
    "invalid task event level",
    "chk_task_events_level",
    `
      INSERT INTO task_events (
        id,
        task_id,
        session_id,
        agent_id,
        level,
        message,
        payload
      )
      VALUES ($1, $2, $3, $4, 'debug', 'bad level', '{}'::jsonb)
    `,
    [`evt_bad_level_${suffix}`, ids.task, ids.session, ids.agent]
  );

  console.log("Postgres schema smoke check passed.");
} finally {
  try {
    await cleanup();
  } finally {
    if (connected) {
      await client.end();
    }
  }
}

async function assertConstraintsInstalled() {
  const result = await client.query(
    `
      SELECT conname
      FROM pg_constraint
      WHERE conname = ANY($1::text[])
      ORDER BY conname ASC
    `,
    [expectedConstraints]
  );
  const installed = new Set(result.rows.map((row) => row.conname));
  const missing = expectedConstraints.filter((name) => !installed.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing Postgres constraints: ${missing.join(", ")}`);
  }
}

async function seedValidGraph() {
  await client.query(
    `
      INSERT INTO environments (id, name, provider)
      VALUES ($1, 'Schema smoke environment', 'any')
    `,
    [ids.environment]
  );
  await client.query(
    `
      INSERT INTO agents (
        id,
        environment_id,
        name,
        version,
        status,
        capabilities,
        tailscale
      )
      VALUES ($1, $2, 'schema-smoke-agent', 'test', 'online', $3, $4)
    `,
    [ids.agent, ids.environment, ["system.info"], "{}"]
  );
  await client.query(
    `
      INSERT INTO sessions (
        id,
        environment_id,
        name,
        requested_by,
        mode,
        status,
        allowed_capabilities,
        expires_at
      )
      VALUES ($1, $2, 'schema smoke session', 'schema-smoke', 'read_only', 'active', $3, now() + interval '1 hour')
    `,
    [ids.session, ids.environment, ["system.info"]]
  );
  await client.query(
    `
      INSERT INTO session_tasks (
        id,
        session_id,
        agent_id,
        capability,
        params,
        status
      )
      VALUES ($1, $2, $3, 'system.info', '{}'::jsonb, 'queued')
    `,
    [ids.task, ids.session, ids.agent]
  );
}

async function assertRejectsConstraint(label, constraintName, text, values) {
  try {
    await client.query(text, values);
  } catch (error) {
    if (error.code !== "23514" || error.constraint !== constraintName) {
      throw new Error(
        `${label} failed with ${error.code ?? "unknown"} ${error.constraint ?? "unknown"}, expected ${constraintName}`
      );
    }
    return;
  }
  throw new Error(`${label} was accepted, expected ${constraintName} to reject it`);
}

async function cleanup() {
  if (!connected) {
    return;
  }
  await client.query("DELETE FROM environments WHERE id = $1", [ids.environment]);
}
