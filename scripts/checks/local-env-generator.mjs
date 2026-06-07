import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const templatePath = fileURLToPath(new URL("../../.env.example", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "patchbay-env-local-"));
const targetPath = join(tempRoot, ".env.local");

const generatedKeys = [
  "PATCHBAY_OPERATOR_TOKEN",
  "PATCHBAY_ENROLLMENT_SECRET",
  "PATCHBAY_AGENT_AUTH_SECRET"
];

const preserveBlankKeys = [
  "GEMINI_API_KEY",
  "TAILSCALE_TAILNET",
  "TAILSCALE_OAUTH_CLIENT_ID",
  "TAILSCALE_OAUTH_CLIENT_SECRET",
  "PATCHBAY_ENROLLMENT_TOKEN"
];

const dummyLiveValues = new Map([
  ["GEMINI_API_KEY", "test-gemini-key-value"],
  ["TAILSCALE_TAILNET", "test-tailnet"],
  ["TAILSCALE_OAUTH_CLIENT_ID", "test-oauth-client-id"],
  ["TAILSCALE_OAUTH_CLIENT_SECRET", "test-oauth-client-secret"],
  ["PATCHBAY_OPERATOR_TOKEN", "existing-operator-token"]
]);

try {
  const firstOutput = runGenerator();
  const firstValues = parseEnv(readFileSync(targetPath, "utf8"));
  const templateValues = parseEnv(readFileSync(templatePath, "utf8"));

  for (const key of templateValues.keys()) {
    assert(firstValues.has(key), `generated envelope is missing ${key}`);
  }

  for (const key of generatedKeys) {
    const value = firstValues.get(key) ?? "";
    assert(value.length >= 32, `${key} should be generated with a strong value`);
    assert(!value.includes("change-me"), `${key} should not use a placeholder`);
    assert(!firstOutput.includes(value), `${key} value leaked to generator output`);
  }

  for (const key of preserveBlankKeys) {
    assert(firstValues.get(key) === "", `${key} should stay blank on first create`);
  }

  writeFileSync(targetPath, buildExistingEnvelope(firstValues));
  const secondOutput = runGenerator();
  const secondValues = parseEnv(readFileSync(targetPath, "utf8"));

  for (const [key, value] of dummyLiveValues) {
    assert(secondValues.get(key) === value, `${key} should be preserved on backfill`);
    assert(!secondOutput.includes(value), `${key} value leaked to generator output`);
  }

  assert(
    secondValues.get("PATCHBAY_EXTRA_LOCAL_FLAG") === "extra-local-value",
    "local-only keys should be preserved on backfill"
  );

  console.log("Local env generator check passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function runGenerator() {
  return execFileSync("node", ["scripts/setup/create-local-env.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATCHBAY_ENV_LOCAL_TARGET: targetPath
    }
  });
}

function buildExistingEnvelope(values) {
  const lines = [];

  for (const [key, value] of values) {
    lines.push(`${key}=${dummyLiveValues.get(key) ?? value}`);
  }

  lines.push("PATCHBAY_EXTRA_LOCAL_FLAG=extra-local-value");
  return `${lines.join("\n")}\n`;
}

function parseEnv(content) {
  const values = new Map();

  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (match) {
      values.set(match[1], match[2]);
    }
  }

  return values;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
