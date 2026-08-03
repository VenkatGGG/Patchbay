import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import {
  discoverMigrations,
  migrateDatabase,
  sha256
} from "./migrations.mjs";

const { Client } = pg;
const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsPath = join(currentDir, "..", "db", "migrations");
const connectionString =
  process.env.DATABASE_URL ??
  "postgres://patchbay:patchbay@localhost:5432/patchbay";

const expectedConstraints = [
  "chk_environments_provider",
  "chk_agents_status",
  "chk_agents_capabilities",
  "chk_agents_tailscale_object",
  "chk_agents_capability_packs_array",
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
  const migrations = await discoverMigrations(migrationsPath);
  await migrateDatabase(client, migrations);
  const secondRun = await migrateDatabase(client, migrations);

  if (secondRun.applied.length !== 0) {
    throw new Error("Migration rerun should not apply already-recorded migrations");
  }
  await assertMigrationLedger(migrations);
  await assertFailedMigrationIsAtomic();
  await assertConcurrentMigrationsSerialize();

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
        capability_packs,
        tailscale
      )
      VALUES ($1, $2, 'bad-tailscale-agent', 'test', 'online', $3, $4, $5)
    `,
    [`agt_bad_tailscale_${suffix}`, ids.environment, ["system.info"], "{}", "[]"]
  );
  await assertRejectsConstraint(
    "non-array capability packs",
    "chk_agents_capability_packs_array",
    `
      INSERT INTO agents (
        id,
        environment_id,
        name,
        version,
        status,
        capabilities,
        capability_packs,
        tailscale
      )
      VALUES ($1, $2, 'bad-capability-packs-agent', 'test', 'online', $3, $4, $5)
    `,
    [`agt_bad_capability_packs_${suffix}`, ids.environment, ["system.info"], "{}", "{}"]
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

async function assertMigrationLedger(migrations) {
  const result = await client.query(
    `
      SELECT version, name, checksum, applied_at
      FROM schema_migrations
      ORDER BY version ASC
    `
  );
  const expected = migrations.map(({ version, name, checksum }) => ({
    version,
    name,
    checksum
  }));
  const actual = result.rows.map((row) => ({
    version: Number(row.version),
    name: row.name,
    checksum: row.checksum.trim()
  }));

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Migration ledger mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    );
  }
  if (result.rows.some((row) => !(row.applied_at instanceof Date))) {
    throw new Error("Migration ledger is missing applied_at timestamps");
  }

  const version = migrations[0]?.version;
  if (version === undefined) {
    throw new Error("Expected at least one migration");
  }
  await assertRejectsImmutableLedger(
    "update",
    "UPDATE schema_migrations SET name = name WHERE version = $1",
    [version]
  );
  await assertRejectsImmutableLedger(
    "delete",
    "DELETE FROM schema_migrations WHERE version = $1",
    [version]
  );
}

async function assertRejectsImmutableLedger(operation, text, values) {
  try {
    await client.query(text, values);
  } catch (error) {
    if (error.code !== "P0001") {
      throw new Error(
        `Migration ledger ${operation} failed with ${error.code ?? "unknown"}, expected P0001`
      );
    }
    return;
  }
  throw new Error(`Migration ledger accepted ${operation}, expected rejection`);
}

async function assertFailedMigrationIsAtomic() {
  const schema = `migration_atomic_${suffix}`;
  const migrationClient = await createSchemaClient(schema);

  try {
    await migrationClient.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrationClient.query(`SET search_path TO ${quoteIdentifier(schema)}`);

    await assertRejects(
      migrateDatabase(migrationClient, [
        smokeMigration(
          1,
          "atomic_failure",
          `
            CREATE TABLE atomic_marker (id INTEGER PRIMARY KEY);
            INSERT INTO atomic_marker VALUES (1);
            SELECT patchbay_missing_migration_function();
          `
        )
      ]),
      /patchbay_missing_migration_function/
    );

    const marker = await migrationClient.query(
      "SELECT to_regclass('atomic_marker') AS relation"
    );
    const ledger = await migrationClient.query(
      "SELECT count(*)::int AS count FROM schema_migrations"
    );
    if (marker.rows[0].relation !== null || ledger.rows[0].count !== 0) {
      throw new Error("Failed migration left schema changes or a ledger row behind");
    }
  } finally {
    await migrationClient.end();
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
  }
}

async function assertConcurrentMigrationsSerialize() {
  const schema = `migration_concurrent_${suffix}`;
  await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  const firstClient = await createSchemaClient(schema);
  const secondClient = await createSchemaClient(schema);
  const migrations = [
    smokeMigration(
      1,
      "concurrent",
      `
        CREATE TABLE concurrency_marker (id INTEGER PRIMARY KEY);
        SELECT pg_sleep(0.25);
        INSERT INTO concurrency_marker VALUES (1);
      `
    )
  ];

  try {
    const [firstResult, secondResult] = await Promise.all([
      migrateDatabase(firstClient, migrations),
      migrateDatabase(secondClient, migrations)
    ]);
    const appliedCounts = [firstResult, secondResult]
      .map((result) => result.applied.length)
      .sort();
    if (JSON.stringify(appliedCounts) !== JSON.stringify([0, 1])) {
      throw new Error(
        `Concurrent migrations should apply once, received ${JSON.stringify(appliedCounts)}`
      );
    }

    const ledger = await firstClient.query(
      "SELECT count(*)::int AS count FROM schema_migrations"
    );
    const markers = await firstClient.query(
      "SELECT count(*)::int AS count FROM concurrency_marker"
    );
    if (ledger.rows[0].count !== 1 || markers.rows[0].count !== 1) {
      throw new Error("Concurrent migration produced duplicate or missing state");
    }
  } finally {
    await Promise.all([firstClient.end(), secondClient.end()]);
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
  }
}

async function createSchemaClient(schema) {
  const schemaClient = new Client({ connectionString });
  await schemaClient.connect();
  await schemaClient.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  return schemaClient;
}

function smokeMigration(version, name, sql) {
  return {
    version,
    name,
    filename: `${String(version).padStart(4, "0")}_${name}.sql`,
    sql,
    checksum: sha256(sql)
  };
}

async function assertRejects(promise, expectedMessage) {
  try {
    await promise;
  } catch (error) {
    if (!expectedMessage.test(error.message)) {
      throw error;
    }
    return;
  }
  throw new Error(`Expected operation to reject with ${expectedMessage}`);
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
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
        capability_packs,
        tailscale
      )
      VALUES ($1, $2, 'schema-smoke-agent', 'test', 'online', $3, $4, $5)
    `,
    [ids.agent, ids.environment, ["system.info"], "[]", "{}"]
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
