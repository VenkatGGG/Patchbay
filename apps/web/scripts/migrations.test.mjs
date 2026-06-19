import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverMigrations,
  migrateDatabase,
  sha256
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
  constructor(applied = [], failedSql = null) {
    this.applied = applied;
    this.failedSql = failedSql;
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
