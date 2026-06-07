import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dockerfilePath = fileURLToPath(new URL("../../Dockerfile.web", import.meta.url));
const composePath = fileURLToPath(new URL("../../docker-compose.yml", import.meta.url));
const dockerignorePath = fileURLToPath(new URL("../../.dockerignore", import.meta.url));
const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));

const dockerfile = readFileSync(dockerfilePath, "utf8");
const compose = readFileSync(composePath, "utf8");
const dockerignoreLines = readFileSync(dockerignorePath, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const requiredDockerfileSnippets = [
  "FROM node:25-alpine AS base",
  "RUN corepack enable",
  "COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./",
  "COPY apps/web/package.json apps/web/package.json",
  "RUN pnpm install --frozen-lockfile",
  "RUN pnpm --filter @patchbay/web build",
  "ENV NODE_ENV=production",
  "EXPOSE 3000",
  "pnpm --filter @patchbay/web db:migrate",
  "pnpm --filter @patchbay/web start -- --hostname 0.0.0.0"
];

const forbiddenDockerfileSnippets = [
  "GEMINI_API_KEY=",
  "PATCHBAY_OPERATOR_TOKEN=",
  "PATCHBAY_ENROLLMENT_SECRET=",
  "PATCHBAY_AGENT_AUTH_SECRET=",
  "TAILSCALE_OAUTH_CLIENT_SECRET=",
  "change-me-local-secret",
  "change-me-local-agent-secret"
];

const requiredDockerignorePatterns = [
  ".env",
  ".env.*",
  "apps/web/.env",
  "apps/web/.env.*",
  "node_modules",
  "apps/web/node_modules",
  "apps/web/.next",
  "agent/bin"
];

const requiredComposeSnippets = [
  "dockerfile: Dockerfile.web",
  "docker compose up --build"
];

const failures = [];

for (const snippet of requiredDockerfileSnippets) {
  if (!dockerfile.includes(snippet)) {
    failures.push(`Dockerfile.web is missing required build contract snippet: ${snippet}`);
  }
}

for (const snippet of forbiddenDockerfileSnippets) {
  if (dockerfile.includes(snippet)) {
    failures.push(`Dockerfile.web contains forbidden secret/default snippet: ${snippet}`);
  }
}

for (const pattern of requiredDockerignorePatterns) {
  if (!dockerignoreLines.includes(pattern)) {
    failures.push(`.dockerignore must exclude build-context artifact or secret pattern: ${pattern}`);
  }
}

if (!compose.includes(requiredComposeSnippets[0])) {
  failures.push("docker-compose.yml must build the web service with Dockerfile.web.");
}

if (!readFileSync(readmePath, "utf8").includes(requiredComposeSnippets[1])) {
  failures.push("README.md should document the self-hosted compose build command.");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Docker build contract check passed.");
