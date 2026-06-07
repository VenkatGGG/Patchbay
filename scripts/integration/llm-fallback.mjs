import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.PATCHBAY_LLM_FALLBACK_PORT ?? 3105);
const baseUrl = `http://127.0.0.1:${port}`;
const operatorToken = "llm-fallback-operator-token";
const children = [];

async function main() {
  const web = spawnProcess(
    "pnpm",
    ["--filter", "@patchbay/web", "exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      PATCHBAY_STORAGE: "memory",
      DATABASE_URL: "",
      PATCHBAY_LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: "patchbay-forced-fallback-key",
      GEMINI_MODEL: "gemini-2.5-flash",
      PATCHBAY_GEMINI_FORCE_FAILURE: "true",
      PATCHBAY_OPERATOR_TOKEN: operatorToken,
      PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
      PATCHBAY_ENROLLMENT_SECRET: "llm-fallback-enrollment-secret",
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: "llm-fallback-agent-secret",
      PATCHBAY_AGENT_TOKEN_TTL_MINUTES: "30",
      TAILSCALE_TAILNET: "",
      TAILSCALE_OAUTH_CLIENT_ID: "",
      TAILSCALE_OAUTH_CLIENT_SECRET: ""
    }
  );
  children.push(web);

  await waitForJson("/api/health");

  const ready = await getJson("/api/ready");
  const geminiProvider = ready.llmProviders.find((provider) => provider.id === "gemini");
  assert(geminiProvider?.configured === true, "expected Gemini provider configured");
  expectReadinessCheck(ready, "llm_provider", "ready");

  const enrollmentTokenResponse = await postJson(
    "/api/environments/env_local/enrollment-token",
    { ttlMinutes: 15 },
    operatorHeaders()
  );
  assert(enrollmentTokenResponse.status === 200, "expected enrollment token");

  const agentResponse = await postJson(
    "/api/agent/enroll",
    {
      environmentId: "env_local",
      name: "llm-fallback-agent",
      version: "test",
      capabilities: ["system.info"]
    },
    enrollmentHeaders(enrollmentTokenResponse.body.token)
  );
  assert(agentResponse.status === 201, "expected agent enrollment");

  const sessionResponse = await postJson(
    "/api/sessions",
    {
      environmentId: "env_local",
      name: "llm fallback validation",
      requestedBy: "llm-fallback-smoke",
      ttlMinutes: 15
    },
    operatorHeaders()
  );
  assert(sessionResponse.status === 201, "expected session creation");

  const diagnosticResponse = await postJson(
    `/api/sessions/${sessionResponse.body.id}/diagnostics`,
    { scenario: "latency_spike" },
    operatorHeaders()
  );
  assert(diagnosticResponse.status === 201, "expected diagnostics creation");
  assert(diagnosticResponse.body.length === 1, "expected one diagnostic task");

  const task = diagnosticResponse.body[0];
  const eventResponse = await postJson(
    `/api/agent/tasks/${task.id}/events`,
    {
      agentId: agentResponse.body.agent.id,
      level: "info",
      message: "LLM fallback evidence completed",
      status: "completed",
      result: {
        hostname: "llm-fallback-smoke",
        secret: "should_not_be_returned"
      }
    },
    {
      Authorization: `Bearer ${agentResponse.body.agentToken}`
    }
  );
  assert(eventResponse.status === 201, "expected event ingestion");

  const synthesisResponse = await postJson(
    `/api/sessions/${sessionResponse.body.id}/synthesize`,
    {},
    operatorHeaders()
  );
  assert(synthesisResponse.status === 201, "expected synthesis to succeed");
  assert(
    synthesisResponse.body.provider === "gemini:gemini-2.5-flash:offline-fallback",
    `expected Gemini offline fallback provider, got ${synthesisResponse.body.provider}`
  );
  assert(
    synthesisResponse.body.summary.includes("Gemini synthesis was unavailable"),
    "expected fallback summary to explain provider unavailability"
  );
  assert(
    !synthesisResponse.body.summary.includes("should_not_be_returned"),
    "expected fallback synthesis to keep redaction"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider: synthesisResponse.body.provider,
        readiness: ready.posture.level
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
process.on("exit", () => {
  for (const child of children.reverse()) {
    if (!child.killed) {
      killProcessGroup(child, "SIGTERM");
    }
  }
});

main()
  .catch(async (error) => {
    console.error(error);
    await cleanup();
    process.exit(1);
  })
  .finally(cleanup);
