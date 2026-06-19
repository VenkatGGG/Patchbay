import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverMigrations,
  migrateDatabase,
  sha256,
  validateMigrationSql
} from "./migrations.mjs";

test("discoverMigrations returns numerically ordered migrations with checksums", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchbay-migrations-"));
  await writeFile(join(directory, "0010_add_tasks.sql"), "SELECT 10;\n");
  await writeFile(join(directory, "0002_add_agents.sql"), "SELECT 2;\n");
  await writeFile(join(directory, "README.md"), "ignored");

  const migrations = await discoverMigrations(directory);

  assert.deepEqual(
    migrations.map(({ version, name, checksum }) => ({ version, name, checksum })),
    [
      {
        version: 2,
        name: "add_agents",
        checksum: sha256("SELECT 2;\n")
      },
      {
        version: 10,
        name: "add_tasks",
        checksum: sha256("SELECT 10;\n")
      }
    ]
  );
});

test("discoverMigrations rejects duplicate numeric versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchbay-migrations-"));
  await writeFile(join(directory, "0001_initial.sql"), "SELECT 1;\n");
  await writeFile(join(directory, "001_initial_copy.sql"), "SELECT 2;\n");

  await assert.rejects(
    discoverMigrations(directory),
    /duplicate migration version 1/i
  );
});

test("discoverMigrations rejects malformed SQL filenames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchbay-migrations-"));
  await writeFile(join(directory, "0001_initial.sql"), "SELECT 1;\n");
  await writeFile(join(directory, "second.sql"), "SELECT 2;\n");

  await assert.rejects(
    discoverMigrations(directory),
    /malformed migration filename second\.sql/i
  );
});

test("discoverMigrations rejects an empty migration directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchbay-migrations-"));
  await writeFile(join(directory, "README.md"), "ignored");

  await assert.rejects(discoverMigrations(directory), /no migrations found/i);
});

test("sha256 canonicalizes CRLF line endings", () => {
  assert.equal(sha256("SELECT 1;\r\nSELECT 2;\r\n"), sha256("SELECT 1;\nSELECT 2;\n"));
});

test("validateMigrationSql rejects transaction control statements", () => {
  for (const sql of [
    "BEGIN;",
    "COMMIT;",
    "ROLLBACK;",
    "SAVEPOINT before_change;",
    "RELEASE SAVEPOINT before_change;",
    "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;",
    "START TRANSACTION;",
    "ABORT;",
    "END TRANSACTION;",
    "PREPARE TRANSACTION 'migration';"
  ]) {
    assert.throws(() => validateMigrationSql(sql, "0001_test.sql"), /transaction control/i);
  }
});

test("validateMigrationSql ignores transaction words in comments and quoted text", () => {
  assert.doesNotThrow(() =>
    validateMigrationSql(
      `
        -- BEGIN;
        /* COMMIT; */
        SELECT 'ROLLBACK', "SAVEPOINT";
        SELECT E'quoted\\' text; COMMIT;';
        DO $body$
        BEGIN
          RAISE NOTICE 'SET TRANSACTION';
        END
        $body$;
      `,
      "0001_test.sql"
    )
  );
});

test("migrateDatabase applies each pending migration in its own transaction", async () => {
  const client = new RecordingClient();
  const migrations = [
    migration(1, "initial", "CREATE TABLE example (id text);"),
    migration(2, "seed", "INSERT INTO example VALUES ('one');")
  ];

  const result = await migrateDatabase(client, migrations);

  assert.deepEqual(result, { applied: [1, 2], currentVersion: 2 });
  assert.deepEqual(client.transactionStatements, [
    ["BEGIN", migrations[0].sql, "INSERT_LEDGER", "COMMIT"],
    ["BEGIN", migrations[1].sql, "INSERT_LEDGER", "COMMIT"]
  ]);
  assert.equal(client.locked, false);
});

test("migrateDatabase installs database-level immutable ledger protections", async () => {
  const client = new RecordingClient();

  await migrateDatabase(client, []);

  assert.equal(client.ledgerProtected, true);
});

test("migrateDatabase rejects changed content for an applied migration", async () => {
  const client = new RecordingClient([
    {
      version: 1,
      name: "initial",
      checksum: sha256("SELECT original;")
    }
  ]);

  await assert.rejects(
    migrateDatabase(client, [migration(1, "initial", "SELECT changed;")]),
    /checksum mismatch.*version 1/i
  );

  assert.deepEqual(client.transactionStatements, []);
  assert.equal(client.locked, false);
});

test("migrateDatabase requires applied migrations to be an exact prefix", async () => {
  const migrations = [
    migration(1, "initial", "SELECT 1;"),
    migration(2, "second", "SELECT 2;")
  ];
  const client = new RecordingClient([
    {
      version: 2,
      name: "second",
      checksum: migrations[1].checksum
    }
  ]);

  await assert.rejects(
    migrateDatabase(client, migrations),
    /exact prefix.*expected version 1.*found 2/i
  );

  assert.deepEqual(client.transactionStatements, []);
});

test("migrateDatabase rolls back a failed migration and releases the lock", async () => {
  const failedSql = "SELECT fail;";
  const client = new RecordingClient([], failedSql);

  await assert.rejects(
    migrateDatabase(client, [migration(1, "broken", failedSql)]),
    /migration failed/
  );

  assert.deepEqual(client.transactionStatements, [
    ["BEGIN", failedSql, "ROLLBACK"]
  ]);
  assert.equal(client.locked, false);
});

test("migrateDatabase preserves migration and rollback failures", async () => {
  const client = new RecordingClient([], "SELECT fail;", {
    rollback: new Error("rollback cleanup failed")
  });

  await assert.rejects(
    migrateDatabase(client, [migration(1, "broken", "SELECT fail;")]),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map(({ message }) => message),
        ["migration failed", "rollback cleanup failed"]
      );
      return true;
    }
  );
});

test("migrateDatabase preserves migration and unlock failures", async () => {
  const client = new RecordingClient([], "SELECT fail;", {
    unlock: new Error("unlock cleanup failed")
  });

  await assert.rejects(
    migrateDatabase(client, [migration(1, "broken", "SELECT fail;")]),
    (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors[0].message, "migration failed");
      assert.equal(error.errors[1].message, "unlock cleanup failed");
      return true;
    }
  );
});

function migration(version, name, sql) {
  return {
    version,
    name,
    filename: `${String(version).padStart(4, "0")}_${name}.sql`,
    sql,
    checksum: sha256(sql)
  };
}

class RecordingClient {
  constructor(applied = [], failedSql = null, cleanupFailures = {}) {
    this.applied = applied;
    this.failedSql = failedSql;
    this.cleanupFailures = cleanupFailures;
    this.locked = false;
    this.ledgerProtected = false;
    this.currentTransaction = null;
    this.transactionStatements = [];
  }

  async query(query, values = []) {
    const text = typeof query === "string" ? query : query.text;
    const normalized = text.replace(/\s+/g, " ").trim();

    if (normalized.includes("pg_advisory_lock")) {
      this.locked = true;
      return { rows: [] };
    }
    if (normalized.includes("pg_advisory_unlock")) {
      if (this.cleanupFailures.unlock) {
        throw this.cleanupFailures.unlock;
      }
      this.locked = false;
      return { rows: [] };
    }
    if (normalized.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) {
      this.ledgerProtected =
        normalized.includes("prevent_schema_migration_change") &&
        normalized.includes("BEFORE UPDATE OR DELETE");
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT version, name, checksum")) {
      return { rows: this.applied };
    }
    if (normalized === "BEGIN") {
      this.currentTransaction = ["BEGIN"];
      this.transactionStatements.push(this.currentTransaction);
      return { rows: [] };
    }
    if (normalized === "COMMIT" || normalized === "ROLLBACK") {
      this.currentTransaction.push(normalized);
      this.currentTransaction = null;
      if (normalized === "ROLLBACK" && this.cleanupFailures.rollback) {
        throw this.cleanupFailures.rollback;
      }
      return { rows: [] };
    }
    if (normalized.startsWith("INSERT INTO schema_migrations")) {
      this.currentTransaction.push("INSERT_LEDGER");
      this.applied.push({
        version: values[0],
        name: values[1],
        checksum: values[2]
      });
      return { rows: [] };
    }
    if (this.currentTransaction) {
      this.currentTransaction.push(text);
      if (text === this.failedSql) {
        throw new Error("migration failed");
      }
      return { rows: [] };
    }

    throw new Error(`Unexpected query: ${normalized}`);
  }
}
