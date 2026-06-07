import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const trackedFiles = execFileSync("git", ["ls-files"], {
  encoding: "utf8"
})
  .split("\n")
  .filter(Boolean);

const forbiddenPathFragments = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development"
];

const secretPatterns = [
  {
    name: "Gemini API key",
    pattern: /AIza[0-9A-Za-z_-]{20,}/
  },
  {
    name: "Generic assigned API key",
    pattern: /(API_KEY|SECRET|TOKEN|PASSWORD)=([^<\n\s][^\n\s]{12,})/i
  },
  {
    name: "Private key block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/
  }
];

const failures = [];

for (const file of trackedFiles) {
  if (forbiddenPathFragments.some((fragment) => file.endsWith(fragment))) {
    failures.push(`Tracked env file is not allowed: ${file}`);
  }

  const content = readFileSync(file, "utf8");
  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(content) && !isAllowedPlaceholder(content)) {
      failures.push(`${name} pattern found in tracked file: ${file}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Secret guard passed.");

function isAllowedPlaceholder(content) {
  return (
    content.includes("<your-key>") ||
    content.includes("change-me-local-secret") ||
    content.includes("GEMINI_API_KEY=")
  );
}

