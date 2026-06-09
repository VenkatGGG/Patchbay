import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const port = Number(process.env.PATCHBAY_ARTIFACT_RETENTION_PORT ?? 3109);
const baseUrl = `http://127.0.0.1:${port}`;
const storageMode = process.env.PATCHBAY_ARTIFACT_RETENTION_STORAGE ?? "memory";
const databaseUrl =
  process.env.PATCHBAY_ARTIFACT_RETENTION_DATABASE_URL ?? process.env.DATABASE_URL;
const operatorToken = "artifact-retention-operator-token";
const artifactRetentionDays = "0.00003";
const children = [];

async function main() {
  if (storageMode === "postgres") {
    assert(
      databaseUrl,
      "PATCHBAY_ARTIFACT_RETENTION_DATABASE_URL or DATABASE_URL is required for postgres artifact retention tests"
    );
    await migrateDatabase(databaseUrl);
  }

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
      PATCHBAY_STORAGE: storageMode,
      DATABASE_URL: storageMode === "postgres" ? databaseUrl : "",
      PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
      PATCHBAY_ENROLLMENT_SECRET: "artifact-retention-enrollment-secret",
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: "artifact-retention-agent-secret",
      PATCHBAY_AGENT_TOKEN_TTL_MINUTES: "30",
      PATCHBAY_ARTIFACT_RETENTION_DAYS: artifactRetentionDays,
      PATCHBAY_LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: "",
      PATCHBAY_OPERATOR_TOKEN: operatorToken,
      TAILSCALE_TAILNET: "",
      TAILSCALE_OAUTH_CLIENT_ID: "",
      TAILSCALE_OAUTH_CLIENT_SECRET: "",
      TAILSCALE_AUTH_KEY_TAGS: ""
    }
  );
  children.push(web);

  await waitForJson("/api/health");

  const ready = await getJson("/api/ready");
  assert(
    ready.runtime.storage === storageMode,
    `expected readiness storage ${storageMode}, got ${ready.runtime.storage}`
  );
  assert(
    ready.artifactRetention.enabled === true,
    "expected artifact retention to be enabled"
  );
  assert(
    ready.artifactRetention.valid === true,
    "expected artifact retention config to be valid"
  );
  expectReadinessCheck(ready, "artifact_retention", "ready");

  const environmentResponse = await postJson(
    "/api/environments",
    {
      name: `Artifact retention ${Date.now()}`,
      provider: "any"
    },
    operatorHeaders()
  );
  assert(environmentResponse.status === 201, "expected isolated environment");
  const environmentId = environmentResponse.body.id;

  const enrollmentTokenResponse = await postJson(
    `/api/environments/${environmentId}/enrollment-token`,
    { ttlMinutes: 15 },
    operatorHeaders()
  );
  assert(enrollmentTokenResponse.status === 200, "expected enrollment token");

  const agentResponse = await postJson(
    "/api/agent/enroll",
    {
      environmentId,
      name: "artifact-retention-agent",
      version: "test",
      capabilities: ["system.info"]
    },
    enrollmentHeaders(enrollmentTokenResponse.body.token)
  );
  assert(agentResponse.status === 201, "expected agent enrollment");
  assert(agentResponse.body.agentToken, "expected agent token");

  const sessionResponse = await postJson(
    "/api/sessions",
    {
      environmentId,
      name: "artifact retention session",
      requestedBy: "artifact-retention-test",
      ttlMinutes: 30
    },
    operatorHeaders()
  );
  assert(sessionResponse.status === 201, "expected session creation");
  const sessionId = sessionResponse.body.id;

  const diagnosticResponse = await postJson(
    `/api/sessions/${sessionId}/diagnostics`,
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
      message: "Artifact retention evidence completed",
      status: "completed",
      result: {
        hostname: "retention-smoke",
        diagnostic: "payload should be pruned"
      }
    },
    agentHeaders(agentResponse.body.agentToken)
  );
  assert(eventResponse.status === 201, "expected task event creation");

  const synthesisResponse = await postJson(
    `/api/sessions/${sessionId}/synthesize`,
    {},
    operatorHeaders()
  );
  assert(synthesisResponse.status === 201, "expected synthesis creation");

  const retainedState = await getJson("/api/state", operatorHeaders());
  const retainedTask = retainedState.tasks.find((candidate) => candidate.id === task.id);
  assert(retainedTask?.result, "expected task result before retention cutoff");
  assert(
    retainedState.events.some((event) => event.taskId === task.id),
    "expected task event before retention cutoff"
  );
  assert(
    retainedState.syntheses.some((synthesis) => synthesis.sessionId === sessionId),
    "expected synthesis before retention cutoff"
  );

  await delay(3200);
  const prunedState = await getJson("/api/state", operatorHeaders());
  const prunedTask = prunedState.tasks.find((candidate) => candidate.id === task.id);
  assert(prunedTask, "expected task metadata after retention cutoff");
  assert(prunedTask.status === "completed", "expected task status to be preserved");
  assert(
    !Object.hasOwn(prunedTask, "result"),
    "expected task result payload to be pruned"
  );
  assert(
    !prunedState.events.some((event) => event.taskId === task.id),
    "expected task events to be pruned"
  );
  assert(
    !prunedState.syntheses.some((synthesis) => synthesis.sessionId === sessionId),
    "expected syntheses to be pruned"
  );
  assert(
    prunedState.audit.some(
      (event) =>
        event.action === "artifact.retention.pruned" &&
        event.metadata.taskResults >= 1 &&
        event.metadata.taskEvents >= 1 &&
        event.metadata.syntheses >= 1
    ),
    "expected retention pruning audit event"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        storage: storageMode,
        sessionId,
        taskStatus: prunedTask.status
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

function agentHeaders(token) {
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
