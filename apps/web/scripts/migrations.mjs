import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MIGRATION_PATTERN = /^(\d+)_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const MIGRATION_LOCK_ID = 7236849211831041n;

const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version BIGINT PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL,
    checksum CHAR(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE OR REPLACE FUNCTION prevent_schema_migration_change()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION 'schema_migrations rows are immutable';
  END;
  $$;

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgname = 'schema_migrations_immutable'
        AND tgrelid = 'schema_migrations'::regclass
        AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER schema_migrations_immutable
      BEFORE UPDATE OR DELETE ON schema_migrations
      FOR EACH ROW
      EXECUTE FUNCTION prevent_schema_migration_change();
    END IF;
  END;
  $$;
`;

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function discoverMigrations(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations = [];
  const versions = new Set();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const match = MIGRATION_PATTERN.exec(entry.name);
    if (!match) {
      continue;
    }

    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new Error(`Invalid migration version in ${entry.name}`);
    }
    if (versions.has(version)) {
      throw new Error(`Duplicate migration version ${version}`);
    }
    versions.add(version);

    const sql = await readFile(join(directory, entry.name), "utf8");
    migrations.push({
      version,
      name: match[2],
      filename: entry.name,
      sql,
      checksum: sha256(sql)
    });
  }

  return migrations.sort((left, right) => left.version - right.version);
}

export async function migrateDatabase(client, migrations) {
  let locked = false;

  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [
      MIGRATION_LOCK_ID.toString()
    ]);
    locked = true;

    await client.query(LEDGER_SQL);
    const appliedResult = await client.query(
      `
        SELECT version, name, checksum
        FROM schema_migrations
        ORDER BY version ASC
      `
    );
    const appliedByVersion = new Map(
      appliedResult.rows.map((row) => [Number(row.version), row])
    );
    const knownVersions = new Set(migrations.map(({ version }) => version));

    for (const applied of appliedResult.rows) {
      const version = Number(applied.version);
      if (!knownVersions.has(version)) {
        throw new Error(
          `Applied migration version ${version} is missing from the migrations directory`
        );
      }
    }

    const appliedVersions = [];
    for (const migration of migrations) {
      const applied = appliedByVersion.get(migration.version);
      if (applied) {
        if (applied.name !== migration.name) {
          throw new Error(
            `Name mismatch for applied migration version ${migration.version}`
          );
        }
        if (applied.checksum.trim() !== migration.checksum) {
          throw new Error(
            `Checksum mismatch for applied migration version ${migration.version}`
          );
        }
        continue;
      }

      await applyMigration(client, migration);
      appliedVersions.push(migration.version);
    }

    return {
      applied: appliedVersions,
      currentVersion: migrations.at(-1)?.version ?? 0
    };
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [
        MIGRATION_LOCK_ID.toString()
      ]);
    }
  }
}

async function applyMigration(client, migration) {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query(
      `
        INSERT INTO schema_migrations (version, name, checksum)
        VALUES ($1, $2, $3)
      `,
      [migration.version, migration.name, migration.checksum]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
