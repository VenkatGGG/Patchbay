import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MIGRATION_PATTERN = /^(\d+)_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const MIGRATION_LOCK_ID = 7236849211831041n;
const TRANSACTION_CONTROL_PATTERN =
  /^(?:begin|start\s+transaction|commit|end(?:\s+(?:work|transaction))?|rollback|abort|savepoint|release(?:\s+savepoint)?|prepare\s+transaction|set\s+transaction)\b/i;

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
  return createHash("sha256").update(canonicalizeLineEndings(content)).digest("hex");
}

export function validateMigrationSql(sql, filename = "migration") {
  const sanitized = stripSqlCommentsAndQuotedText(sql);
  const invalidStatement = sanitized
    .split(";")
    .map((statement) => statement.trim())
    .find((statement) => TRANSACTION_CONTROL_PATTERN.test(statement));

  if (invalidStatement) {
    const keyword = invalidStatement.match(TRANSACTION_CONTROL_PATTERN)?.[0];
    throw new Error(
      `Migration ${filename} contains transaction control statement ${keyword}`
    );
  }
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
    if (!match && entry.name.toLowerCase().endsWith(".sql")) {
      throw new Error(`Malformed migration filename ${entry.name}`);
    }
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
    validateMigrationSql(sql, entry.name);
    migrations.push({
      version,
      name: match[2],
      filename: entry.name,
      sql,
      checksum: sha256(sql)
    });
  }

  if (migrations.length === 0) {
    throw new Error(`No migrations found in ${directory}`);
  }

  return migrations.sort((left, right) => left.version - right.version);
}

export async function migrateDatabase(client, migrations) {
  let locked = false;
  let result;
  let migrationError;

  try {
    for (const migration of migrations) {
      validateMigrationSql(migration.sql, migration.filename);
    }

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
    assertAppliedPrefix(appliedResult.rows, migrations);

    const appliedVersions = [];
    for (const migration of migrations.slice(appliedResult.rows.length)) {
      await applyMigration(client, migration);
      appliedVersions.push(migration.version);
    }

    result = {
      applied: appliedVersions,
      currentVersion: migrations.at(-1)?.version ?? 0
    };
  } catch (error) {
    migrationError = error;
  }

  if (locked) {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [
        MIGRATION_LOCK_ID.toString()
      ]);
    } catch (unlockError) {
      if (migrationError) {
        throw new AggregateError(
          [migrationError, unlockError],
          "Migration failed and advisory lock cleanup also failed"
        );
      }
      throw unlockError;
    }
  }

  if (migrationError) {
    throw migrationError;
  }
  return result;
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
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Migration ${migration.filename} failed and rollback also failed`
      );
    }
    throw error;
  }
}

function assertAppliedPrefix(appliedRows, migrations) {
  if (appliedRows.length > migrations.length) {
    throw new Error(
      `Applied migrations are not an exact prefix: ledger has ${appliedRows.length} rows but only ${migrations.length} migrations exist`
    );
  }

  for (let index = 0; index < appliedRows.length; index += 1) {
    const applied = appliedRows[index];
    const migration = migrations[index];
    const appliedVersion = Number(applied.version);

    if (appliedVersion !== migration.version) {
      throw new Error(
        `Applied migrations are not an exact prefix: expected version ${migration.version} at position ${index + 1}, found ${appliedVersion}`
      );
    }
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
  }
}

function canonicalizeLineEndings(content) {
  return content.replace(/\r\n?/g, "\n");
}

function stripSqlCommentsAndQuotedText(sql) {
  let sanitized = "";
  let index = 0;

  while (index < sql.length) {
    if (sql.startsWith("--", index)) {
      index = skipLineComment(sql, index + 2);
      sanitized += "\n";
      continue;
    }
    if (sql.startsWith("/*", index)) {
      index = skipBlockComment(sql, index + 2);
      sanitized += " ";
      continue;
    }

    const character = sql[index];
    if (character === "'" || character === '"') {
      const allowsBackslashEscapes =
        character === "'" && isEscapeStringPrefix(sql, index);
      index = skipQuotedText(
        sql,
        index + 1,
        character,
        allowsBackslashEscapes
      );
      sanitized += " ";
      continue;
    }
    if (character === "$") {
      const delimiter = readDollarQuoteDelimiter(sql, index);
      if (delimiter) {
        const closeIndex = sql.indexOf(delimiter, index + delimiter.length);
        if (closeIndex === -1) {
          throw new Error("Unterminated dollar-quoted SQL body");
        }
        index = closeIndex + delimiter.length;
        sanitized += " ";
        continue;
      }
    }

    sanitized += character;
    index += 1;
  }

  return sanitized;
}

function skipLineComment(sql, index) {
  const newline = sql.indexOf("\n", index);
  return newline === -1 ? sql.length : newline + 1;
}

function skipBlockComment(sql, index) {
  let depth = 1;
  while (index < sql.length && depth > 0) {
    if (sql.startsWith("/*", index)) {
      depth += 1;
      index += 2;
    } else if (sql.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  if (depth !== 0) {
    throw new Error("Unterminated block comment in migration SQL");
  }
  return index;
}

function skipQuotedText(sql, index, delimiter, allowsBackslashEscapes) {
  while (index < sql.length) {
    if (allowsBackslashEscapes && sql[index] === "\\") {
      index += 2;
      continue;
    }
    if (sql[index] !== delimiter) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === delimiter) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  throw new Error("Unterminated quoted text in migration SQL");
}

function isEscapeStringPrefix(sql, quoteIndex) {
  if (quoteIndex === 0 || !/[eE]/.test(sql[quoteIndex - 1])) {
    return false;
  }
  return quoteIndex === 1 || !/[A-Za-z0-9_$]/.test(sql[quoteIndex - 2]);
}

function readDollarQuoteDelimiter(sql, index) {
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
  return match?.[0] ?? null;
}
