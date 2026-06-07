import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const port = Number(process.env.PATCHBAY_INTEGRATION_PORT ?? 3100);
const baseUrl = `http://127.0.0.1:${port}`;
const storageMode = process.env.PATCHBAY_INTEGRATION_STORAGE ?? "memory";
const databaseUrl = process.env.PATCHBAY_INTEGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const operatorToken =
  process.env.PATCHBAY_INTEGRATION_OPERATOR_TOKEN ?? "integration-operator-token";
const children = [];

async function main() {
  if (storageMode === "postgres") {
    assert(databaseUrl, "PATCHBAY_INTEGRATION_DATABASE_URL or DATABASE_URL is required for postgres integration tests");
    await migrateDatabase(databaseUrl);
  }

  const web = spawnProcess(
    "pnpm",
    ["--filter", "@patchbay/web", "exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
      PATCHBAY_ENROLLMENT_SECRET: "integration-secret",
      PATCHBAY_STORAGE: storageMode,
      DATABASE_URL: databaseUrl ?? "",
      GEMINI_API_KEY: "",
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: "integration-agent-auth-secret",
      PATCHBAY_AGENT_TOKEN_TTL_MINUTES: "30",
      PATCHBAY_LLM_PROVIDER: "gemini",
      PATCHBAY_OPERATOR_TOKEN: operatorToken
    }
  );
  children.push(web);

  await waitForJson("/api/health");

  const health = await getJson("/api/health");
  assert(health.status === "ok", "expected health endpoint to report ok");

  const ready = await getJson("/api/ready");
  assert(ready.status === "ready", "expected readiness endpoint to report ready");
  assert(
    ready.runtime.storage === storageMode,
    `expected readiness storage ${storageMode}, got ${ready.runtime.storage}`
  );
  assert(
    ready.operatorAuth.required === true,
    "expected readiness endpoint to report operator auth enabled"
  );
  assert(
    ready.enrollmentAuth.required === true,
    "expected readiness endpoint to report enrollment auth enabled"
  );
  assert(
    ready.enrollmentAuth.secretConfigured === true,
    "expected readiness endpoint to report enrollment signing secret configured"
  );
  assert(
    ready.agentAuth.required === true,
    "expected readiness endpoint to report agent auth enabled"
  );
  assert(
    ready.agentAuth.tokenTtlMinutes === 30,
    `expected agent token ttl 30, got ${ready.agentAuth.tokenTtlMinutes}`
  );
  const geminiProvider = ready.llmProviders.find((provider) => provider.id === "gemini");
  assert(geminiProvider, "expected Gemini provider in readiness payload");
  assert(geminiProvider.selected === true, "expected Gemini provider to be selected");
  assert(
    geminiProvider.configured === false,
    "expected Gemini provider to be unconfigured without GEMINI_API_KEY"
  );
  assert(
    ready.tailscale.configured === false,
    "expected Tailscale automation to be unconfigured in local integration"
  );
  assert(
    ready.posture.level === "degraded",
    `expected readiness posture degraded, got ${ready.posture.level}`
  );
  expectReadinessCheck(ready, "operator_auth", "ready");
  expectReadinessCheck(ready, "enrollment_auth", "ready");
  expectReadinessCheck(ready, "agent_auth", "ready");
  expectReadinessCheck(ready, "llm_provider", "warning");
  expectReadinessCheck(ready, "tailscale", "warning");

  await expectStatus(
    "unauthenticated state is rejected",
    getResponse("/api/state"),
    401
  );

  await expectStatus(
    "unauthenticated token minting is rejected",
    postJson("/api/environments/env_local/enrollment-token", { ttlMinutes: 15 }),
    401
  );

  await expectStatus(
    "unauthenticated enrollment is rejected",
    postJson("/api/agent/enroll", {
      environmentId: "env_local",
      name: "rejected-agent",
      version: "test",
      capabilities: ["system.info"]
    }),
    401
  );

  await expectStatus(
    "unauthenticated agent task polling is rejected",
    getResponse("/api/agent/tasks?agentId=agt_missing"),
    401
  );

  await expectStatus(
    "unauthenticated agent event posting is rejected",
    postJson("/api/agent/tasks/task_missing/events", {
      agentId: "agt_missing",
      level: "info",
      message: "should be rejected"
    }),
    401
  );

  await expectStatus(
    "unauthenticated agent token refresh is rejected",
    postJson("/api/agent/token", {}),
    401
  );

  await expectStatus(
    "invalid environment creation request is rejected",
    postJson(
      "/api/environments",
      { provider: "aws" },
      operatorHeaders()
    ),
    400
  );

  await expectStatus(
    "invalid session creation request is rejected",
    postJson(
      "/api/sessions",
      {
        environmentId: "env_local",
        name: "invalid ttl",
        ttlMinutes: 241
      },
      operatorHeaders()
    ),
    400
  );

  await expectStatus(
    "oversized enrollment token ttl is rejected",
    postJson(
      "/api/environments/env_local/enrollment-token",
      { ttlMinutes: 24 * 60 + 1 },
      operatorHeaders()
    ),
    400
  );

  const tokenResponse = await postJson(
    "/api/environments/env_local/enrollment-token",
    {
      ttlMinutes: 15
    },
    operatorHeaders()
  );
  assert(tokenResponse.status === 200, "expected token mint endpoint to return 200");
  assert(tokenResponse.body.token, "expected enrollment token");
  assert(
    tokenResponse.body.environmentId === "env_local",
    "expected minted token response to include environment id"
  );
  assert(
    Date.parse(tokenResponse.body.expiresAt) > Date.now(),
    "expected minted enrollment token expiry to be in the future"
  );

  await expectStatus(
    "invalid enrollment request is rejected",
    postJson(
      "/api/agent/enroll",
      {
        environmentId: "env_local",
        name: "integration-invalid-capability-agent",
        version: "test",
        capabilities: ["shell.exec"]
      },
      enrollmentHeaders(tokenResponse.body.token)
    ),
    400
  );

  const wrongEnvironmentToken = createSignedEnrollmentToken({
    environmentId: "env_other",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  await expectStatus(
    "wrong-environment enrollment token is rejected",
    postJson(
      "/api/agent/enroll",
      {
        environmentId: "env_local",
        name: "integration-wrong-env-agent",
        version: "test",
        capabilities: ["system.info"]
      },
      enrollmentHeaders(wrongEnvironmentToken)
    ),
    401
  );

  const malformedExpiryToken = createSignedEnrollmentToken({
    environmentId: "env_local",
    expiresAt: "not-a-date"
  });
  await expectStatus(
    "malformed-expiry enrollment token is rejected",
    postJson(
      "/api/agent/enroll",
      {
        environmentId: "env_local",
        name: "integration-malformed-expiry-agent",
        version: "test",
        capabilities: ["system.info"]
      },
      enrollmentHeaders(malformedExpiryToken)
    ),
    401
  );

  const expiredEnrollmentToken = createSignedEnrollmentToken({
    environmentId: "env_local",
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  });
  await expectStatus(
    "expired enrollment token is rejected",
    postJson(
      "/api/agent/enroll",
      {
        environmentId: "env_local",
        name: "integration-expired-enrollment-agent",
        version: "test",
        capabilities: ["system.info"]
      },
      enrollmentHeaders(expiredEnrollmentToken)
    ),
    401
  );


  const redactionAgentResponse = await postJson(
    "/api/agent/enroll",
    {
      environmentId: "env_local",
      name: "integration-redaction-agent",
      version: "test",
      capabilities: ["system.info"]
    },
    enrollmentHeaders(tokenResponse.body.token)
  );
  assert(redactionAgentResponse.status === 201, "expected redaction agent enrollment");
  assert(redactionAgentResponse.body.agentToken, "expected redaction agent token");
  assert(
    redactionAgentResponse.body.tailscale.tags.includes("tag:patchbay-env-local"),
    "expected enrollment to normalize environment Tailscale tag"
  );
  assert(
    redactionAgentResponse.body.tailscale.tags.every((tag) => !tag.includes("_")),
    "expected Tailscale tags to avoid underscores"
  );

  const agent = spawnProcess(
    "go",
    ["run", "./agent/cmd/patchbay-agent"],
    {
      PATCHBAY_CONTROL_PLANE_URL: baseUrl,
      PATCHBAY_ENVIRONMENT_ID: "env_local",
      PATCHBAY_AGENT_NAME: "integration-agent",
      PATCHBAY_POLL_INTERVAL: "1s",
      PATCHBAY_ENROLLMENT_TOKEN: tokenResponse.body.token
    }
  );
  children.push(agent);

  await waitForCondition("agent enrollment", async () => {
    const state = await getJson("/api/state", operatorHeaders());
    return state.agents.some((candidate) => candidate.name === "integration-agent");
  });

  const sessionResponse = await postJson(
    "/api/sessions",
    {
      environmentId: "env_local",
      name: "integration latency session",
      requestedBy: "integration-test",
      ttlMinutes: 30
    },
    operatorHeaders()
  );
  assert(sessionResponse.status === 201, "expected session creation to return 201");
  const sessionId = sessionResponse.body.id;
  assert(sessionId, "expected session id");

  await expectStatus(
    "invalid diagnostic request is rejected",
    postJson(
      `/api/sessions/${sessionId}/diagnostics`,
      { scenario: "memory_leak" },
      operatorHeaders()
    ),
    400
  );

  const diagnosticResponse = await postJson(
    `/api/sessions/${sessionId}/diagnostics`,
    { scenario: "latency_spike" },
    operatorHeaders()
  );
  assert(diagnosticResponse.status === 201, "expected diagnostics creation to return 201");
  assert(diagnosticResponse.body.length === 10, "expected all read-only tasks");
  assert(
    diagnosticResponse.body.some((task) => task.capability === "cloud.metadata"),
    "expected diagnostics to include cloud metadata task"
  );
  const firstDiagnosticTask = diagnosticResponse.body[0];
  assert(firstDiagnosticTask?.id, "expected a diagnostic task id");
  const redactionTask = diagnosticResponse.body.find(
    (task) => task.agentId === redactionAgentResponse.body.agent.id
  );
  assert(redactionTask?.id, "expected redaction agent diagnostic task");

  await expectStatus(
    "invalid task event request is rejected",
    postJson(
      `/api/agent/tasks/${redactionTask.id}/events`,
      {
        agentId: redactionAgentResponse.body.agent.id,
        status: "completed"
      },
      {
        Authorization: `Bearer ${redactionAgentResponse.body.agentToken}`
      }
    ),
    400
  );

  const syntheticEnvSecret =
    "GITHUB_" +
    "TO" +
    "KEN" +
    "=ghp_should_not_leak DATABASE_" +
    "URL" +
    "=postgres://user:pass@localhost:5432/app";
  const syntheticBearerToken = "Bearer " + "abc.def.ghi";
  const syntheticPrivateKey =
    "-----BEGIN PRIVATE " + "KEY-----\nabc123\n-----END PRIVATE " + "KEY-----";

  const redactionEventResponse = await postJson(
    `/api/agent/tasks/${redactionTask.id}/events`,
    {
      agentId: redactionAgentResponse.body.agent.id,
      level: "info",
      message: "Synthetic redaction fixture completed",
      status: "completed",
      result: {
        env: syntheticEnvSecret,
        nested: {
          password: "supersecret",
          authorization: syntheticBearerToken,
          privateKey: syntheticPrivateKey
        }
      }
    },
    {
      Authorization: `Bearer ${redactionAgentResponse.body.agentToken}`
    }
  );
  assert(redactionEventResponse.status === 201, "expected redaction fixture event");

  const secondAgentResponse = await postJson(
    "/api/agent/enroll",
    {
      environmentId: "env_local",
      name: "integration-agent-secondary",
      version: "test",
      capabilities: ["system.info"]
    },
    enrollmentHeaders(tokenResponse.body.token)
  );
  assert(secondAgentResponse.status === 201, "expected secondary agent enrollment");
  assert(secondAgentResponse.body.agentToken, "expected secondary agent token");
  assert(
    secondAgentResponse.body.agentTokenExpiresAt,
    "expected secondary agent token expiry"
  );

  const refreshedAgentResponse = await postJson(
    "/api/agent/token",
    {},
    {
      Authorization: `Bearer ${secondAgentResponse.body.agentToken}`
    }
  );
  assert(refreshedAgentResponse.status === 200, "expected agent token refresh");
  assert(
    refreshedAgentResponse.body.agentId === secondAgentResponse.body.agent.id,
    "expected refreshed token to belong to the secondary agent"
  );
  assert(refreshedAgentResponse.body.agentToken, "expected refreshed agent token");
  assert(
    Date.parse(refreshedAgentResponse.body.agentTokenExpiresAt) > Date.now(),
    "expected refreshed agent token expiry to be in the future"
  );

  const expiredToken = createSignedAgentToken({
    agentId: secondAgentResponse.body.agent.id,
    environmentId: "env_local",
    issuedAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  });
  await expectStatus(
    "expired agent token refresh is rejected",
    postJson(
      "/api/agent/token",
      {},
      {
        Authorization: `Bearer ${expiredToken}`
      }
    ),
    401
  );

  await expectStatus(
    "agent cannot update another agent task",
    postJson(
      `/api/agent/tasks/${firstDiagnosticTask.id}/events`,
      {
        agentId: secondAgentResponse.body.agent.id,
        level: "info",
        message: "Cross-agent event should be rejected",
        status: "running"
      },
      {
        Authorization: `Bearer ${refreshedAgentResponse.body.agentToken}`
      }
    ),
    403
  );

  await waitForCondition("all diagnostic tasks to complete", async () => {
    const state = await getJson("/api/state", operatorHeaders());
    const tasks = state.tasks.filter((task) => task.sessionId === sessionId);
    return tasks.length === 10 && tasks.every((task) => task.status === "completed");
  });

  const synthesisResponse = await postJson(
    `/api/sessions/${sessionId}/synthesize`,
    {},
    operatorHeaders()
  );
  assert(synthesisResponse.status === 201, "expected synthesis to return 201");
  assert(
    synthesisResponse.body.provider === "gemini:offline",
    `expected gemini offline fallback, got ${synthesisResponse.body.provider}`
  );
  assert(
    synthesisResponse.body.summary.includes("integration latency session"),
    "expected synthesis summary to reference the session"
  );

  const reportResponse = await getTextResponse(
    `/api/sessions/${sessionId}/report`,
    operatorHeaders()
  );
  assert(reportResponse.status === 200, "expected report export to return 200");
  assert(
    reportResponse.headers.get("content-type")?.includes("text/markdown"),
    "expected report export to return markdown"
  );
  assert(
    reportResponse.body.includes("integration latency session"),
    "expected report to include the session name"
  );
  assert(
    reportResponse.body.includes("workload.discover"),
    "expected report to include diagnostic task coverage"
  );
  assert(
    reportResponse.body.includes("cloud.metadata"),
    "expected report to include cloud metadata coverage"
  );
  assert(
    reportResponse.body.includes("gemini:offline"),
    "expected report to include the offline Gemini synthesis provider"
  );
  assert(
    reportResponse.body.includes("[REDACTED_SECRET]"),
    "expected report to contain redaction markers"
  );
  assert(
    !reportResponse.body.includes("ghp_should_not_leak"),
    "expected report to redact GitHub token"
  );
  assert(
    !reportResponse.body.includes("user:pass"),
    "expected report to redact URL credentials"
  );
  assert(
    !reportResponse.body.includes("supersecret"),
    "expected report to redact sensitive object keys"
  );
  assert(
    !reportResponse.body.includes("abc.def.ghi"),
    "expected report to redact bearer token"
  );
  assert(
    !reportResponse.body.includes("BEGIN PRIVATE KEY"),
    "expected report to redact private key blocks"
  );

  const providerResponse = await getResponse("/api/llm/providers", operatorHeaders());
  assert(providerResponse.status === 200, "expected provider registry endpoint to return 200");
  assert(
    providerResponse.body.some((provider) => provider.id === "gemini"),
    "expected Gemini provider to be listed"
  );

  const finalState = await getJson("/api/state", operatorHeaders());
  const finalTasks = finalState.tasks.filter((task) => task.sessionId === sessionId);
  console.log(
    JSON.stringify(
      {
        ok: true,
        storage: storageMode,
        agents: finalState.agents.length,
        tasks: finalTasks.length,
        completed: finalTasks.filter((task) => task.status === "completed").length,
        syntheses: finalState.syntheses.length,
        reportBytes: reportResponse.body.length
      },
      null,
      2
    )
  );
}

async function migrateDatabase(connectionString) {
  const { stdout, stderr } = await execFileAsync(
    "pnpm",
    ["--filter", "@patchbay/web", "db:migrate"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: connectionString
      }
    }
  );
  if (stdout.trim()) {
    process.stdout.write(`[migrate] ${stdout}`);
  }
  if (stderr.trim()) {
    process.stderr.write(`[migrate] ${stderr}`);
  }
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
  assert(response.status >= 200 && response.status < 300, `GET ${path} returned ${response.status}`);
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

async function getTextResponse(path, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      accept: "text/markdown",
      ...headers
    }
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text()
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

function enrollmentHeaders(token) {
  return {
    Authorization: `Bearer ${token}`
  };
}

function createSignedEnrollmentToken({ environmentId, expiresAt }) {
  const body = Buffer.from(
    JSON.stringify({
      purpose: "agent_enrollment",
      environmentId,
      expiresAt
    })
  ).toString("base64url");
  const signature = createHmac("sha256", "integration-secret")
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

function createSignedAgentToken({ agentId, environmentId, issuedAt, expiresAt }) {
  const body = Buffer.from(
    JSON.stringify({
      purpose: "agent_api",
      agentId,
      environmentId,
      issuedAt,
      expiresAt
    })
  ).toString("base64url");
  const signature = createHmac("sha256", "integration-agent-auth-secret")
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
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

async function expectStatus(label, promise, status) {
  const response = await promise;
  assert(response.status === status, `${label}: expected ${status}, got ${response.status}`);
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
