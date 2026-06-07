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
    "unauthenticated provider registry is rejected",
    getResponse("/api/llm/providers"),
    401
  );

  await expectStatus(
    "unauthenticated environment listing is rejected",
    getResponse("/api/environments"),
    401
  );

  await expectStatus(
    "unauthenticated environment creation is rejected",
    postJson("/api/environments", { name: "rejected-env", provider: "any" }),
    401
  );

  await expectStatus(
    "unauthenticated session listing is rejected",
    getResponse("/api/sessions"),
    401
  );

  await expectStatus(
    "unauthenticated session creation is rejected",
    postJson("/api/sessions", {
      environmentId: "env_local",
      name: "rejected-session",
      requestedBy: "integration-test"
    }),
    401
  );

  await expectStatus(
    "operator token header authenticates state",
    getResponse("/api/state", operatorTokenHeader()),
    200
  );

  await expectStatus(
    "malformed operator token header is rejected",
    getResponse("/api/state", {
      "x-patchbay-operator-token": `${operatorToken} trailing`
    }),
    401
  );

  await expectStatus(
    "operator bearer token with trailing words is rejected",
    getResponse("/api/state", {
      Authorization: `Bearer ${operatorToken} trailing`
    }),
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

  const missingAgentToken = createSignedAgentToken({
    agentId: "agt_missing_signed",
    environmentId: "env_local",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  await expectStatus(
    "unknown agent task polling is rejected",
    getResponse("/api/agent/tasks?agentId=agt_missing_signed", {
      Authorization: `Bearer ${missingAgentToken}`
    }),
    404
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

  await expectError(
    "malformed environment JSON is rejected",
    postRaw("/api/environments", '{"name":', operatorHeaders()),
    400,
    "Malformed JSON request body"
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
    "unknown environment session creation is rejected",
    postJson(
      "/api/sessions",
      {
        environmentId: "env_missing",
        name: "missing environment",
        ttlMinutes: 30
      },
      operatorHeaders()
    ),
    404
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

  await expectStatus(
    "unknown environment token minting is rejected",
    postJson(
      "/api/environments/env_missing/enrollment-token",
      { ttlMinutes: 15 },
      operatorHeaders()
    ),
    404
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

  const missingEnvironmentToken = createSignedEnrollmentToken({
    environmentId: "env_missing",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  await expectStatus(
    "unknown environment enrollment is rejected",
    postJson(
      "/api/agent/enroll",
      {
        environmentId: "env_missing",
        name: "integration-missing-env-agent",
        version: "test",
        capabilities: ["system.info"]
      },
      enrollmentHeaders(missingEnvironmentToken)
    ),
    404
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

  await expectStatus(
    "extra-segment enrollment token is rejected",
    postJson(
      "/api/agent/enroll",
      {
        environmentId: "env_local",
        name: "integration-extra-segment-enrollment-agent",
        version: "test",
        capabilities: ["system.info"]
      },
      enrollmentHeaders(`${tokenResponse.body.token}.ignored`)
    ),
    401
  );

  await expectStatus(
    "enrollment bearer token with trailing words is rejected",
    postJson(
      "/api/agent/enroll",
      {
        environmentId: "env_local",
        name: "integration-trailing-enrollment-agent",
        version: "test",
        capabilities: ["system.info"]
      },
      {
        Authorization: `Bearer ${tokenResponse.body.token} trailing`
      }
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

  const closeSessionResponse = await postJson(
    "/api/sessions",
    {
      environmentId: "env_local",
      name: "integration close session",
      requestedBy: "integration-test",
      ttlMinutes: 30
    },
    operatorHeaders()
  );
  assert(closeSessionResponse.status === 201, "expected close session creation");
  const closeSessionId = closeSessionResponse.body.id;
  assert(closeSessionId, "expected close session id");

  await expectStatus(
    "unauthenticated session close is rejected",
    postJson(`/api/sessions/${closeSessionId}/close`, {}),
    401
  );

  const closeDiagnosticResponse = await postJson(
    `/api/sessions/${closeSessionId}/diagnostics`,
    { scenario: "latency_spike" },
    operatorHeaders()
  );
  assert(
    closeDiagnosticResponse.status === 201,
    "expected close diagnostic creation"
  );
  assert(
    closeDiagnosticResponse.body.length === 1,
    `expected one queued close diagnostic task, got ${closeDiagnosticResponse.body.length}`
  );
  const closeTask = closeDiagnosticResponse.body[0];
  assert(closeTask?.id, "expected close diagnostic task id");

  const closeResponse = await postJson(
    `/api/sessions/${closeSessionId}/close`,
    {},
    operatorHeaders()
  );
  assert(closeResponse.status === 200, "expected session close to return 200");
  assert(closeResponse.body.status === "closed", "expected closed session status");

  await expectStatus(
    "closed session diagnostic request is rejected",
    postJson(
      `/api/sessions/${closeSessionId}/diagnostics`,
      { scenario: "latency_spike" },
      operatorHeaders()
    ),
    409
  );

  await expectStatus(
    "late task event for closed session is rejected",
    postJson(
      `/api/agent/tasks/${closeTask.id}/events`,
      {
        agentId: redactionAgentResponse.body.agent.id,
        level: "info",
        message: "Closed session event should be rejected",
        status: "completed",
        result: { ignored: true }
      },
      {
        Authorization: `Bearer ${redactionAgentResponse.body.agentToken}`
      }
    ),
    409
  );

  const closedState = await getJson("/api/state", operatorHeaders());
  const closedSession = closedState.sessions.find(
    (session) => session.id === closeSessionId
  );
  assert(closedSession?.status === "closed", "expected closed session in state");
  const deniedCloseTask = closedState.tasks.find((task) => task.id === closeTask.id);
  assert(deniedCloseTask?.status === "denied", "expected close task to be denied");
  assert(
    deniedCloseTask.error === "Session closed",
    "expected close task to record closure reason"
  );
  assert(
    closedState.audit.some(
      (event) => event.action === "session.closed" && event.target === closeSessionId
    ),
    "expected session close audit event"
  );

  const expiringSessionResponse = await postJson(
    "/api/sessions",
    {
      environmentId: "env_local",
      name: "integration expiring session",
      requestedBy: "integration-test",
      ttlSeconds: 1
    },
    operatorHeaders()
  );
  assert(expiringSessionResponse.status === 201, "expected expiring session creation");
  const expiringSessionId = expiringSessionResponse.body.id;
  assert(expiringSessionId, "expected expiring session id");

  const expiringDiagnosticResponse = await postJson(
    `/api/sessions/${expiringSessionId}/diagnostics`,
    { scenario: "latency_spike" },
    operatorHeaders()
  );
  assert(
    expiringDiagnosticResponse.status === 201,
    "expected expiring diagnostic creation"
  );
  assert(
    expiringDiagnosticResponse.body.length === 1,
    `expected one queued expiring diagnostic task, got ${expiringDiagnosticResponse.body.length}`
  );
  const expiringTask = expiringDiagnosticResponse.body[0];
  assert(expiringTask?.id, "expected expiring diagnostic task id");

  await delay(1200);
  const expiredState = await getJson("/api/state", operatorHeaders());
  const expiredSession = expiredState.sessions.find(
    (session) => session.id === expiringSessionId
  );
  assert(expiredSession?.status === "expired", "expected expired session in state");
  const deniedExpiredTask = expiredState.tasks.find((task) => task.id === expiringTask.id);
  assert(
    deniedExpiredTask?.status === "denied",
    "expected expired session task to be denied"
  );
  assert(
    deniedExpiredTask.error === "Session expired",
    "expected expired session task to record expiry reason"
  );
  assert(
    expiredState.audit.some(
      (event) => event.action === "session.expired" && event.target === expiringSessionId
    ),
    "expected session expiry audit event"
  );

  await expectStatus(
    "late task event for expired session is rejected",
    postJson(
      `/api/agent/tasks/${expiringTask.id}/events`,
      {
        agentId: redactionAgentResponse.body.agent.id,
        level: "info",
        message: "Expired session event should be rejected",
        status: "completed",
        result: { ignored: true }
      },
      {
        Authorization: `Bearer ${redactionAgentResponse.body.agentToken}`
      }
    ),
    409
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
    "unauthenticated diagnostic request is rejected",
    postJson(`/api/sessions/${sessionId}/diagnostics`, { scenario: "latency_spike" }),
    401
  );

  await expectStatus(
    "unauthenticated synthesis request is rejected",
    postJson(`/api/sessions/${sessionId}/synthesize`, {}),
    401
  );

  await expectStatus(
    "unauthenticated report export is rejected",
    getResponse(`/api/sessions/${sessionId}/report`),
    401
  );

  await expectStatus(
    "unknown session diagnostic request is rejected",
    postJson(
      "/api/sessions/sess_missing/diagnostics",
      { scenario: "latency_spike" },
      operatorHeaders()
    ),
    404
  );

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

  const claimedRedactionTasks = await getResponse(
    `/api/agent/tasks?agentId=${redactionAgentResponse.body.agent.id}`,
    {
      Authorization: `Bearer ${redactionAgentResponse.body.agentToken}`
    }
  );
  assert(claimedRedactionTasks.status === 200, "expected redaction agent task claim");
  assert(
    claimedRedactionTasks.body.length === 1,
    `expected one claimed redaction task, got ${claimedRedactionTasks.body.length}`
  );
  assert(
    claimedRedactionTasks.body[0].id === redactionTask.id,
    "expected claimed redaction task id"
  );
  assert(
    claimedRedactionTasks.body[0].status === "running",
    "expected task claim to mark task running"
  );
  assert(
    claimedRedactionTasks.body[0].startedAt,
    "expected task claim to record start time"
  );

  const repeatedRedactionClaim = await getResponse(
    `/api/agent/tasks?agentId=${redactionAgentResponse.body.agent.id}`,
    {
      Authorization: `Bearer ${redactionAgentResponse.body.agentToken}`
    }
  );
  assert(repeatedRedactionClaim.status === 200, "expected repeated task claim");
  assert(
    repeatedRedactionClaim.body.length === 0,
    "expected repeated claim to return no duplicate tasks"
  );

  await expectStatus(
    "agent cannot requeue an assigned task",
    postJson(
      `/api/agent/tasks/${redactionTask.id}/events`,
      {
        agentId: redactionAgentResponse.body.agent.id,
        level: "info",
        message: "Requeue attempt should be rejected",
        status: "queued"
      },
      {
        Authorization: `Bearer ${redactionAgentResponse.body.agentToken}`
      }
    ),
    409
  );

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

  await expectError(
    "malformed task event JSON is rejected",
    postRaw(`/api/agent/tasks/${redactionTask.id}/events`, '{"agentId":', {
      Authorization: `Bearer ${redactionAgentResponse.body.agentToken}`
    }),
    400,
    "Malformed JSON request body"
  );

  const syntheticEnvSecret =
    "GITHUB_" +
    "TO" +
    "KEN" +
    "=ghp_should_not_leak DATABASE_" +
    "URL" +
    "=postgres://user:pass@localhost:5432/app";
  const syntheticColonSecret =
    "KUBERNETES_SERVICE_ACCOUNT_" + "TO" + "KEN : eyJ_should_not_leak";
  const syntheticJsonSecret =
    '{"client' + 'Secret":"client_secret_should_not_leak","safe":"value"}';
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
        configDump: syntheticColonSecret,
        jsonDump: syntheticJsonSecret,
        nested: {
          password: "supersecret",
          apiKey: "api_key_should_not_leak",
          clientSecret: "client_secret_object_should_not_leak",
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

  await expectStatus(
    "terminal task status rewrite is rejected",
    postJson(
      `/api/agent/tasks/${redactionTask.id}/events`,
      {
        agentId: redactionAgentResponse.body.agent.id,
        level: "info",
        message: "Terminal rewrite should be rejected",
        status: "running",
        result: { overwritten: true }
      },
      {
        Authorization: `Bearer ${redactionAgentResponse.body.agentToken}`
      }
    ),
    409
  );

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

  await expectStatus(
    "extra-segment agent token refresh is rejected",
    postJson(
      "/api/agent/token",
      {},
      {
        Authorization: `Bearer ${secondAgentResponse.body.agentToken}.ignored`
      }
    ),
    401
  );

  await expectStatus(
    "agent bearer token with trailing words is rejected",
    postJson(
      "/api/agent/token",
      {},
      {
        Authorization: `Bearer ${secondAgentResponse.body.agentToken} trailing`
      }
    ),
    401
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
    !reportResponse.body.includes("eyJ_should_not_leak"),
    "expected report to redact colon-delimited token assignments"
  );
  assert(
    !reportResponse.body.includes("client_secret_should_not_leak"),
    "expected report to redact JSON-style client secrets"
  );
  assert(
    !reportResponse.body.includes("api_key_should_not_leak"),
    "expected report to redact camelCase apiKey object values"
  );
  assert(
    !reportResponse.body.includes("client_secret_object_should_not_leak"),
    "expected report to redact camelCase clientSecret object values"
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

function operatorTokenHeader() {
  return {
    "x-patchbay-operator-token": operatorToken
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

async function postRaw(path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body
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

async function expectError(label, promise, status, error) {
  const response = await promise;
  assert(response.status === status, `${label}: expected ${status}, got ${response.status}`);
  assert(
    response.body.error === error,
    `${label}: expected error ${JSON.stringify(error)}, got ${JSON.stringify(response.body.error)}`
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
