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

const client = new Client({ connectionString });

try {
  const schema = await readFile(schemaPath, "utf8");
  await client.connect();
  await client.query(schema);
  console.log("Patchbay database schema is up to date.");
} finally {
  await client.end();
}

