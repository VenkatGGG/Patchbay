import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const port = Number(process.env.PATCHBAY_TASK_TIMEOUT_PORT ?? 3107);
const baseUrl = `http://127.0.0.1:${port}`;
const storageMode = process.env.PATCHBAY_TASK_TIMEOUT_STORAGE ?? "memory";
const databaseUrl =
  process.env.PATCHBAY_TASK_TIMEOUT_DATABASE_URL ?? process.env.DATABASE_URL;
const operatorToken = "task-timeout-operator-token";
const children = [];

async function main() {
  if (storageMode === "postgres") {
    assert(
      databaseUrl,
      "PATCHBAY_TASK_TIMEOUT_DATABASE_URL or DATABASE_URL is required for postgres task timeout tests"
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
      PATCHBAY_ENROLLMENT_SECRET: "task-timeout-enrollment-secret",
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: "task-timeout-agent-secret",
      PATCHBAY_AGENT_TOKEN_TTL_MINUTES: "30",
      PATCHBAY_TASK_TIMEOUT_SECONDS: "1",
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

  const environmentResponse = await postJson(
    "/api/environments",
    {
      name: `Task timeout ${Date.now()}`,
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
      name: "task-timeout-agent",
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
      name: "task timeout session",
      requestedBy: "task-timeout-test",
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

  const claimResponse = await getResponse(
    `/api/agent/tasks?agentId=${agentResponse.body.agent.id}`,
    agentHeaders(agentResponse.body.agentToken)
  );
  assert(claimResponse.status === 200, "expected task claim");
  assert(claimResponse.body.length === 1, "expected one claimed task");
  assert(claimResponse.body[0].id === task.id, "expected claimed task id");
  assert(claimResponse.body[0].status === "running", "expected claimed task running");
  assert(claimResponse.body[0].startedAt, "expected claimed task start time");

  const repeatClaimResponse = await getResponse(
    `/api/agent/tasks?agentId=${agentResponse.body.agent.id}`,
    agentHeaders(agentResponse.body.agentToken)
  );
  assert(repeatClaimResponse.status === 200, "expected repeated task poll");
  assert(repeatClaimResponse.body.length === 0, "expected claimed task not to repeat");

  await delay(1200);
  const state = await getJson("/api/state", operatorHeaders());
  const timedOutTask = state.tasks.find((candidate) => candidate.id === task.id);
  assert(timedOutTask?.status === "failed", "expected stale task to fail");
  assert(
    timedOutTask.error === "Task timed out after 1 seconds",
    "expected task timeout error"
  );
  assert(timedOutTask.completedAt, "expected timed-out task completion time");
  assert(
    state.audit.some(
      (event) => event.action === "task.timed_out" && event.target === task.id
    ),
    "expected timeout audit event"
  );

  await expectStatus(
    "late completion after timeout is rejected",
    postJson(
      `/api/agent/tasks/${task.id}/events`,
      {
        agentId: agentResponse.body.agent.id,
        level: "info",
        message: "Late completion should be rejected",
        status: "completed",
        result: { late: true }
      },
      agentHeaders(agentResponse.body.agentToken)
    ),
    409
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        storage: storageMode,
        taskStatus: timedOutTask.status,
        error: timedOutTask.error
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

function agentHeaders(token) {
  return {
    Authorization: `Bearer ${token}`
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
