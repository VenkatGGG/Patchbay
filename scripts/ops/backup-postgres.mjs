import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outputPath = process.argv[2]?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  fail("DATABASE_URL is required");
}
if (!outputPath) {
  fail("usage: node scripts/ops/backup-postgres.mjs <output.dump>");
}

const target = resolve(outputPath);
if (existsSync(target)) {
  fail(`backup destination already exists: ${target}`);
}

mkdirSync(dirname(target), { recursive: true });
const result = spawnSync(
  "pg_dump",
  ["--format=custom", "--file", target],
  {
    env: postgresEnvironment(databaseUrl),
    stdio: "inherit"
  }
);

if (result.error) {
  fail(`pg_dump could not start: ${result.error.message}`);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Postgres backup created at ${target}`);

function postgresEnvironment(rawUrl) {
  const parsed = parseDatabaseUrl(rawUrl);
  const env = {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//u, ""))
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
