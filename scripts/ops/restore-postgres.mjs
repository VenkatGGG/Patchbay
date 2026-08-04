import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const sourcePath = process.argv[2]?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  fail("DATABASE_URL is required");
}
if (!sourcePath) {
  fail("usage: node scripts/ops/restore-postgres.mjs <source.dump>");
}

const source = resolve(sourcePath);
if (!existsSync(source) || !statSync(source).isFile()) {
  fail(`backup source does not exist: ${source}`);
}

const parsed = parseDatabaseUrl(databaseUrl);
const result = spawnSync(
  "pg_restore",
  [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--exit-on-error",
    "--dbname",
    parsed.pathname.replace(/^\//u, ""),
    source
  ],
  {
    env: postgresEnvironment(parsed),
    stdio: "inherit"
  }
);

if (result.error) {
  fail(`pg_restore could not start: ${result.error.message}`);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Postgres backup restored from ${source}`);

function postgresEnvironment(parsed) {
  const env = {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username)
  };
  if (parsed.password) {
    env.PGPASSWORD = decodeURIComponent(parsed.password);
  }
  if (parsed.searchParams.get("sslmode")) {
    env.PGSSLMODE = parsed.searchParams.get("sslmode");
  }
  return env;
}

function parseDatabaseUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!parsed || !["postgres:", "postgresql:"].includes(parsed.protocol)) {
    fail("DATABASE_URL must use the postgres or postgresql scheme");
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    fail("DATABASE_URL must include a host and database name");
  }
  return parsed;
}

function fail(message) {
  // never print credentials or the full DATABASE_URL.
  console.error(message);
  process.exit(1);
}
