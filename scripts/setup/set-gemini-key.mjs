import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvLine } from "../lib/env-file.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const targetPath = resolve(
  repoRoot,
  process.env.PATCHBAY_ENV_LOCAL_TARGET ?? "apps/web/.env.local"
);
const targetDisplayPath = relative(repoRoot, targetPath);
const apiKey = process.env.GEMINI_API_KEY?.trim() ?? "";

if (!apiKey) {
  console.error(
    "GEMINI_API_KEY is required. Run: GEMINI_API_KEY=<your-key> pnpm env:set-gemini"
  );
  process.exit(1);
}

if (apiKey.includes("\n") || /\s/u.test(apiKey)) {
  console.error("GEMINI_API_KEY must be a single token without whitespace.");
  process.exit(1);
}

if (!existsSync(targetPath)) {
  mkdirSync(dirname(targetPath), { recursive: true });
  execFileSync("node", ["scripts/setup/create-local-env.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GEMINI_API_KEY: "",
      PATCHBAY_ENV_LOCAL_TARGET: targetPath
    },
    stdio: "pipe"
  });
}

const content = readFileSync(targetPath, "utf8");
const lines = content.split("\n");
let replaced = false;

const nextLines = lines.map((line) => {
  const parsed = parseEnvLine(line);
  if (parsed?.key === "GEMINI_API_KEY") {
    replaced = true;
    return `GEMINI_API_KEY=${apiKey}`;
  }
  return line;
});

if (!replaced) {
  if (nextLines.at(-1) !== "") {
    nextLines.push("");
  }
  nextLines.push(`GEMINI_API_KEY=${apiKey}`);
}

writeFileSync(targetPath, `${nextLines.join("\n").replace(/\n+$/u, "")}\n`);

console.log(`Updated ${targetDisplayPath} with GEMINI_API_KEY.`);
console.log("The key value was not printed. Run pnpm test:gemini:live to validate it.");
