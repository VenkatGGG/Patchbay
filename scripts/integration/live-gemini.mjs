import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadEnvFile } from "../lib/env-file.mjs";

const localEnvPath = fileURLToPath(
  new URL("../../apps/web/.env.local", import.meta.url)
);
const localEnv = loadEnvFile(localEnvPath);
const port = Number(process.env.PATCHBAY_LIVE_GEMINI_PORT ?? 3102);
const baseUrl = `http://127.0.0.1:${port}`;
const geminiApiKey = envValue("GEMINI_API_KEY");
const geminiModel = envValue("GEMINI_MODEL") ?? "gemini-2.5-flash";
const operatorToken =
  envValue("PATCHBAY_OPERATOR_TOKEN") ?? `patchbay-live-operator-${secret()}`;
const enrollmentSecret =
  envValue("PATCHBAY_ENROLLMENT_SECRET") ?? `patchbay-live-enroll-${secret()}`;
const agentSecret =
  envValue("PATCHBAY_AGENT_AUTH_SECRET") ?? `patchbay-live-agent-${secret()}`;
const children = [];

if (!geminiApiKey) {
  console.error(
    [
      "GEMINI_API_KEY is required for the live Gemini smoke test.",
      `Set it in ${localEnvPath} or export it in the shell, then rerun pnpm test:gemini:live.`
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
      GEMINI_API_KEY: geminiApiKey,
      GEMINI_MODEL: geminiModel,
      PATCHBAY_OPERATOR_TOKEN: operatorToken,
      PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
      PATCHBAY_ENROLLMENT_SECRET: enrollmentSecret,
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: agentSecret,
      PATCHBAY_AGENT_TOKEN_TTL_MINUTES: "30",
      TAILSCALE_TAILNET: "",
      TAILSCALE_OAUTH_CLIENT_ID: "",
      TAILSCALE_OAUTH_CLIENT_SECRET: ""
    }
  );
  children.push(web);

  await waitForJson("/api/health");

  const ready = await getJson("/api/ready");
  assert(ready.status === "ready", "expected readiness endpoint to report ready");
  const geminiProvider = ready.llmProviders.find((provider) => provider.id === "gemini");
  assert(geminiProvider?.selected === true, "expected Gemini provider to be selected");
  assert(geminiProvider.configured === true, "expected Gemini provider to be configured");
  expectReadinessCheck(ready, "llm_provider", "ready");

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
      name: "live-gemini-agent",
      version: "test",
      capabilities: ["system.info"]
    },
    enrollmentHeaders(enrollmentTokenResponse.body.token)
  );
  assert(agentResponse.status === 201, "expected live Gemini agent enrollment");
  assert(agentResponse.body.agentToken, "expected live Gemini agent token");

  const sessionResponse = await postJson(
    "/api/sessions",
    {
      environmentId: "env_local",
      name: "live Gemini synthesis validation",
      requestedBy: "live-gemini-smoke",
      ttlMinutes: 30
    },
    operatorHeaders()
  );
  assert(sessionResponse.status === 201, "expected session creation to return 201");

  const diagnosticResponse = await postJson(
    `/api/sessions/${sessionResponse.body.id}/diagnostics`,
    { scenario: "latency_spike" },
    operatorHeaders()
  );
  assert(
    diagnosticResponse.status === 201,
    `expected diagnostics creation to return 201, got ${diagnosticResponse.status}`
  );
  assert(diagnosticResponse.body.length === 1, "expected one task for one agent");
  const task = diagnosticResponse.body[0];

  const eventResponse = await postJson(
    `/api/agent/tasks/${task.id}/events`,
    {
      agentId: agentResponse.body.agent.id,
      level: "info",
      message: "Live Gemini validation evidence completed",
      status: "completed",
      result: {
        host: "live-gemini-smoke",
        observedLatencyMs: 842,
        suspectedArea: "checkout-api",
        readOnly: true
      }
    },
    {
      Authorization: `Bearer ${agentResponse.body.agentToken}`
    }
  );
  assert(eventResponse.status === 201, "expected task event ingestion to return 201");

  const synthesisResponse = await postJson(
    `/api/sessions/${sessionResponse.body.id}/synthesize`,
    {},
    operatorHeaders()
  );
  assert(
    synthesisResponse.status === 201,
    `expected live Gemini synthesis to return 201, got ${synthesisResponse.status}`
  );
  assert(
    synthesisResponse.body.provider === `gemini:${geminiModel}`,
    `expected live Gemini provider gemini:${geminiModel}, got ${synthesisResponse.body.provider}`
  );
  assert(
    typeof synthesisResponse.body.summary === "string" &&
      synthesisResponse.body.summary.trim().length > 0,
    "expected non-empty live Gemini synthesis summary"
  );
  assert(
    !synthesisResponse.body.summary.includes("No configured LLM provider was available"),
    "expected live Gemini summary rather than offline fallback text"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider: synthesisResponse.body.provider,
        summaryBytes: synthesisResponse.body.summary.length,
        readiness: ready.posture.level
      },
      null,
      2
    )
  );
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
