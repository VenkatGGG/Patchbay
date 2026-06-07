import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const localEnvPath = fileURLToPath(
  new URL("../../apps/web/.env.local", import.meta.url)
);
const localEnv = loadEnvFile(localEnvPath);
const port = Number(process.env.PATCHBAY_LIVE_TAILSCALE_PORT ?? 3103);
const baseUrl = `http://127.0.0.1:${port}`;
const tailnet = envValue("TAILSCALE_TAILNET");
const tailscaleClientId = envValue("TAILSCALE_OAUTH_CLIENT_ID");
const tailscaleClientSecret = envValue("TAILSCALE_OAUTH_CLIENT_SECRET");
const operatorToken =
  envValue("PATCHBAY_OPERATOR_TOKEN") ?? `patchbay-live-operator-${secret()}`;
const enrollmentSecret =
  envValue("PATCHBAY_ENROLLMENT_SECRET") ?? `patchbay-live-enroll-${secret()}`;
const agentSecret =
  envValue("PATCHBAY_AGENT_AUTH_SECRET") ?? `patchbay-live-agent-${secret()}`;
const children = [];

const missingKeys = [
  ["TAILSCALE_TAILNET", tailnet],
  ["TAILSCALE_OAUTH_CLIENT_ID", tailscaleClientId],
  ["TAILSCALE_OAUTH_CLIENT_SECRET", tailscaleClientSecret]
]
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingKeys.length > 0) {
  console.error(
    [
      `Missing Tailscale live smoke setting(s): ${missingKeys.join(", ")}`,
      `Set them in ${localEnvPath} or export them in the shell, then rerun pnpm test:tailscale:live.`
    ].join("\n")
  );
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
      "dev",
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
      PATCHBAY_ENROLLMENT_SECRET: enrollmentSecret,
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: agentSecret,
      PATCHBAY_AGENT_TOKEN_TTL_MINUTES: "30",
      TAILSCALE_TAILNET: tailnet,
      TAILSCALE_OAUTH_CLIENT_ID: tailscaleClientId,
      TAILSCALE_OAUTH_CLIENT_SECRET: tailscaleClientSecret
    }
  );
  children.push(web);

  await waitForJson("/api/health");

  const ready = await getJson("/api/ready");
  assert(ready.status === "ready", "expected readiness endpoint to report ready");
  assert(ready.tailscale.configured === true, "expected Tailscale to be configured");
  expectReadinessCheck(ready, "tailscale", "ready");

  const enrollmentTokenResponse = await postJson(
    "/api/environments/env_local/enrollment-token",
    { ttlMinutes: 15 },
    operatorHeaders()
  );
  assert(
    enrollmentTokenResponse.status === 200,
    `expected enrollment token minting to return 200, got ${enrollmentTokenResponse.status}`
  );

  const agentResponse = await postJson(
    "/api/agent/enroll",
    {
      environmentId: "env_local",
      name: "live-tailscale-agent",
      version: "test",
      capabilities: ["system.info"]
    },
    enrollmentHeaders(enrollmentTokenResponse.body.token)
  );
  assert(
    agentResponse.status === 201,
    `expected Tailscale-backed agent enrollment to return 201, got ${agentResponse.status}`
  );
  assert(agentResponse.body.agentToken, "expected signed agent token");
  assert(agentResponse.body.tailscale.available === true, "expected Tailscale auth key");
  assert(
    typeof agentResponse.body.tailscale.authKey === "string" &&
      agentResponse.body.tailscale.authKey.length > 20,
    "expected non-empty Tailscale auth key"
  );
  assert(
    !agentResponse.body.tailscale.authKeyPreview.includes("disabled"),
    "expected live Tailscale auth key preview"
  );
  assert(
    agentResponse.body.tailscale.tags.includes("tag:patchbay-agent"),
    "expected patchbay agent tag"
  );
  assert(
    agentResponse.body.tailscale.tags.includes("tag:patchbay-env-local"),
    "expected normalized environment tag"
  );
  assert(
    Date.parse(agentResponse.body.tailscale.expiresAt) > Date.now(),
    "expected future auth key expiry"
  );
  assert(
    agentResponse.body.agent.tailscale.enabled === true,
    "expected enrolled agent to record Tailscale as enabled"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        tailscaleAvailable: true,
        authKeyPreview: agentResponse.body.tailscale.authKeyPreview,
        tags: agentResponse.body.tailscale.tags,
        expiresAt: agentResponse.body.tailscale.expiresAt,
        readiness: ready.posture.level
      },
      null,
      2
    )
  );
}

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return new Map();
  }

  const values = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (match) {
      values.set(match[1], match[2]);
    }
  }
  return values;
}

function envValue(key) {
  const value = process.env[key] ?? localEnv.get(key);
  return value?.trim() ? value.trim() : undefined;
}

function secret() {
  return randomBytes(18).toString("base64url");
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
    body: await response.json()
  };
}

async function postJson(path, payload, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(payload)
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

function enrollmentHeaders(token) {
  return {
    Authorization: `Bearer ${token}`
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
