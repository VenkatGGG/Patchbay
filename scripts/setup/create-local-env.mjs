import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const templatePath = fileURLToPath(new URL("../../.env.example", import.meta.url));
const targetPath = resolve(
  repoRoot,
  process.env.PATCHBAY_ENV_LOCAL_TARGET ?? "apps/web/.env.local"
);
const targetDisplayPath = relative(repoRoot, targetPath);
const targetExisted = existsSync(targetPath);

const generatedKeys = new Set([
  "PATCHBAY_OPERATOR_TOKEN",
  "PATCHBAY_ENROLLMENT_SECRET",
  "PATCHBAY_AGENT_AUTH_SECRET"
]);

const preserveBlankKeys = new Set([
  "GEMINI_API_KEY",
  "TAILSCALE_TAILNET",
  "TAILSCALE_OAUTH_CLIENT_ID",
  "TAILSCALE_OAUTH_CLIENT_SECRET",
  "PATCHBAY_ENROLLMENT_TOKEN"
]);

const template = readFileSync(templatePath, "utf8");
const existing = targetExisted ? readFileSync(targetPath, "utf8") : "";
const existingValues = parseEnv(existing);
const templateKeys = new Set();
const generated = [];
const preserved = [];
const output = [];

for (const line of template.split("\n")) {
  const parsed = parseLine(line);

  if (!parsed) {
    output.push(line);
    continue;
  }

  templateKeys.add(parsed.key);
  const existingValue = existingValues.get(parsed.key);

  if (
    existingValue !== undefined &&
    existingValue.trim() !== "" &&
    !isWeakGeneratedSecret(parsed.key, existingValue)
  ) {
    output.push(`${parsed.key}=${existingValue}`);
    preserved.push(parsed.key);
    continue;
  }

  if (generatedKeys.has(parsed.key)) {
    output.push(`${parsed.key}=${randomSecret(parsed.key)}`);
    generated.push(parsed.key);
    continue;
  }

  if (preserveBlankKeys.has(parsed.key)) {
    output.push(`${parsed.key}=`);
    continue;
  }

  output.push(line);
}

const extraLocalKeys = [...existingValues.keys()].filter((key) => !templateKeys.has(key));
if (extraLocalKeys.length > 0) {
  output.push("");
  output.push("# Existing local-only keys preserved by pnpm env:local");
  for (const key of extraLocalKeys) {
    output.push(`${key}=${existingValues.get(key)}`);
  }
}

mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(targetPath, `${output.join("\n").replace(/\n+$/u, "")}\n`);

console.log(`${targetExisted ? "Updated" : "Created"} ${targetDisplayPath}`);
if (generated.length > 0) {
  console.log(`Generated local-only values for: ${generated.join(", ")}`);
}
if (preserved.length > 0) {
  console.log(`Preserved existing values for: ${preserved.join(", ")}`);
}
console.log(`Set GEMINI_API_KEY in ${targetDisplayPath} when the key is available.`);

function parseEnv(content) {
  const values = new Map();

  for (const line of content.split("\n")) {
    const parsed = parseLine(line);
    if (parsed) {
      values.set(parsed.key, parsed.value);
    }
  }

  return values;
}

function parseLine(line) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
  if (!match) {
    return undefined;
  }

  return {
    key: match[1],
    value: match[2]
  };
}

function randomSecret(key) {
  const prefix = key.toLowerCase().replaceAll("_", "-");
  return `${prefix}-${randomBytes(24).toString("base64url")}`;
}

function isWeakGeneratedSecret(key, value) {
  return (
    generatedKeys.has(key) &&
    (value.includes("change-me") ||
      value.includes("local-dev") ||
      value.includes("patchbay-local"))
  );
}
