import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const buildPath = fileURLToPath(new URL("../../apps/web/.next", import.meta.url));
const port = Number(process.env.PATCHBAY_UI_SMOKE_PORT ?? 3104);
const baseUrl = `http://127.0.0.1:${port}`;
const operatorToken =
  process.env.PATCHBAY_UI_SMOKE_OPERATOR_TOKEN ?? "ui-smoke-operator-token";
const children = [];

if (!existsSync(buildPath)) {
  console.error("Next production build is required before pnpm test:ui.");
  console.error("Run pnpm web:build first, or use pnpm check.");
  process.exit(1);
}

async function main() {
  const web = spawnProcess(
    "pnpm",
    [
      "--filter",
      "@patchbay/web",
      "exec",
      "next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port)
    ],
    {
      PATCHBAY_STORAGE: "memory",
      DATABASE_URL: "",
      PATCHBAY_LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: "",
      PATCHBAY_OPERATOR_TOKEN: operatorToken,
      PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
      PATCHBAY_ENROLLMENT_SECRET: "ui-smoke-enrollment-secret",
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: "ui-smoke-agent-secret",
      PATCHBAY_AGENT_TOKEN_TTL_MINUTES: "30",
      TAILSCALE_TAILNET: "",
      TAILSCALE_OAUTH_CLIENT_ID: "",
      TAILSCALE_OAUTH_CLIENT_SECRET: ""
    }
  );
  children.push(web);

  await waitForJson("/api/health");

  const htmlResponse = await fetch(`${baseUrl}/`);
  assert(htmlResponse.status === 200, `expected dashboard HTML 200, got ${htmlResponse.status}`);
  assert(
    htmlResponse.headers.get("content-type")?.includes("text/html"),
    "expected dashboard response to be HTML"
  );
  const html = await htmlResponse.text();
  for (const expected of [
    "Patchbay",
    "Incident Sessions",
    "Runtime Posture",
    "Readiness Checks",
    "Session Control",
    "Diagnostic Results",
    "Gemini Synthesis"
  ]) {
    assert(html.includes(expected), `expected dashboard HTML to include ${expected}`);
  }

  const ready = await getJson("/api/ready");
  assert(ready.status === "ready", "expected readiness endpoint to report ready");
  assert(ready.operatorAuth.required === true, "expected operator auth required");
  assert(ready.enrollmentAuth.required === true, "expected enrollment auth required");
  assert(ready.agentAuth.required === true, "expected agent auth required");
  assert(ready.posture.level === "degraded", "expected local production posture degraded");
  expectReadinessCheck(ready, "operator_auth", "ready");
  expectReadinessCheck(ready, "enrollment_auth", "ready");
  expectReadinessCheck(ready, "agent_auth", "ready");
  expectReadinessCheck(ready, "llm_provider", "warning");
  expectReadinessCheck(ready, "tailscale", "warning");

  const unauthenticatedState = await getResponse("/api/state");
  assert(
    unauthenticatedState.status === 401,
    `expected unauthenticated state request 401, got ${unauthenticatedState.status}`
  );

  const authenticatedState = await getResponse("/api/state", operatorHeaders());
  assert(
    authenticatedState.status === 200,
    `expected authenticated state request 200, got ${authenticatedState.status}`
  );
  assert(
    authenticatedState.body.environments.some((environment) => environment.id === "env_local"),
    "expected local environment in authenticated dashboard state"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "next-start",
        readiness: ready.posture.level,
        htmlBytes: html.length
      },
      null,
      2
    )
  );
}

function spawnProcess(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => process.stdout.write(prefix(command, chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(prefix(command, chunk)));
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      process.stderr.write(`${command} exited with code ${code}\n`);
    }
    if (signal) {
      process.stderr.write(`${command} exited with signal ${signal}\n`);
    }
  });

  return child;
}

function prefix(command, chunk) {
  return String(chunk)
    .split("\n")
    .filter(Boolean)
    .map((line) => `[${command}] ${line}\n`)
    .join("");
}

async function waitForJson(path) {
  return waitForCondition(`GET ${path}`, async () => {
    try {
      await getJson(path);
      return true;
    } catch {
      return false;
    }
  });
}

async function waitForCondition(label, check, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function getJson(path, headers = {}) {
  const response = await getResponse(path, headers);
  assert(
    response.status >= 200 && response.status < 300,
    `GET ${path} returned ${response.status}`
  );
  return response.body;
}

async function getResponse(path, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      accept: "application/json",
      ...headers
    }
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({}))
  };
}

function operatorHeaders() {
  return {
    Authorization: `Bearer ${operatorToken}`
  };
}

function expectReadinessCheck(ready, id, status) {
  const check = ready.posture.checks.find((candidate) => candidate.id === id);
  assert(check, `expected readiness check ${id}`);
  assert(
    check.status === status,
    `expected readiness check ${id} to be ${status}, got ${check.status}`
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function cleanup() {
  for (const child of children.reverse()) {
    if (!child.killed) {
      killProcessGroup(child, "SIGTERM");
    }
  }
  await delay(500);
  for (const child of children.reverse()) {
    if (!child.killed) {
      killProcessGroup(child, "SIGKILL");
    }
  }
}

function killProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

try {
  await main();
} finally {
  await cleanup();
}
