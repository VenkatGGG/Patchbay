import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { discoverMigrations, migrateDatabase } from "./migrations.mjs";

const { Client } = pg;
const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsPath = join(currentDir, "..", "db", "migrations");
const connectionString =
  process.env.DATABASE_URL ??
  "postgres://patchbay:patchbay@localhost:5432/patchbay";

const client = new Client({ connectionString });

try {
  const migrations = await discoverMigrations(migrationsPath);
  await client.connect();
  const result = await migrateDatabase(client, migrations);
  console.log(
    `Patchbay database schema is up to date at version ${result.currentVersion}. ` +
      `Applied ${result.applied.length} migration(s).`
  );
} finally {
  await client.end();
}
