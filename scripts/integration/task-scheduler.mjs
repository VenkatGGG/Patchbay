import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.PATCHBAY_TASK_SCHEDULER_PORT ?? 3108);
const baseUrl = `http://127.0.0.1:${port}`;
const operatorToken = "task-scheduler-operator-token";
const children = [];

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
      PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
      PATCHBAY_ENROLLMENT_SECRET: "task-scheduler-enrollment-secret",
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: "task-scheduler-agent-secret",
      PATCHBAY_AGENT_TOKEN_TTL_MINUTES: "30",
      PATCHBAY_TASK_TIMEOUT_SECONDS: "30",
      PATCHBAY_OPERATOR_TOKEN: operatorToken,
      PATCHBAY_LLM_PROVIDER: "offline",
      TAILSCALE_TAILNET: "",
      TAILSCALE_OAUTH_CLIENT_ID: "",
      TAILSCALE_OAUTH_CLIENT_SECRET: "",
      TAILSCALE_AUTH_KEY_TAGS: ""
    }
  );
  children.push(web);

  await waitForJson("/api/health");

  const environmentResponse = await postJson(
    "/api/environments",
    { name: `Task scheduler ${Date.now()}`, provider: "any" },
    operatorHeaders()
  );
  assert.equal(environmentResponse.status, 201, "expected isolated environment");
  const environmentId = environmentResponse.body.id;

  const systemAgent = await enrollAgent(environmentId, "system-agent", ["system.info"]);
  const processAgent = await enrollAgent(environmentId, "process-agent", ["process.list"]);

  const sessionResponse = await postJson(
    "/api/sessions",
    {
      environmentId,
      name: "task scheduler session",
      requestedBy: "task-scheduler-test",
      ttlMinutes: 15
    },
    operatorHeaders()
  );
  assert.equal(sessionResponse.status, 201, "expected session creation");

  const diagnosticResponse = await postJson(
    `/api/sessions/${sessionResponse.body.id}/diagnostics`,
    { scenario: "latency_spike" },
    operatorHeaders()
  );
  assert.equal(diagnosticResponse.status, 201, "expected diagnostic creation");
  assert.equal(
    diagnosticResponse.body.length,
    9,
    "expected one queued task for each read-only capability"
  );
  assert(
    diagnosticResponse.body.every(
      (task) => task.agentId === undefined || task.agentId === null
    ),
    "expected queued diagnostic tasks to be unassigned"
  );

  const systemClaim = await getResponse(
    `/api/agent/tasks?agentId=${systemAgent.agent.id}`,
    agentHeaders(systemAgent.agentToken)
  );
  assert.equal(systemClaim.status, 200, "expected system agent task claim");
  assert.deepEqual(
    systemClaim.body.map((task) => task.capability),
    ["system.info"],
    "expected system agent to claim only its capability"
  );

  const processClaim = await getResponse(
    `/api/agent/tasks?agentId=${processAgent.agent.id}`,
    agentHeaders(processAgent.agentToken)
  );
  assert.equal(processClaim.status, 200, "expected process agent task claim");
  assert.deepEqual(
    processClaim.body.map((task) => task.capability),
    ["process.list"],
    "expected process agent to claim only its capability"
  );

  const repeatedSystemClaim = await getResponse(
    `/api/agent/tasks?agentId=${systemAgent.agent.id}`,
    agentHeaders(systemAgent.agentToken)
  );
  assert.deepEqual(repeatedSystemClaim.body, [], "expected no duplicate system tasks");

  const state = await getJson("/api/state", operatorHeaders());
  const sessionTasks = state.tasks.filter((task) => task.sessionId === sessionResponse.body.id);
  assert.equal(sessionTasks.length, 9, "expected all capability tasks in state");
  assert.equal(
    sessionTasks.filter((task) => task.status === "running").length,
    2,
    "expected only claimed tasks to be running"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        taskCount: sessionTasks.length,
        runningCapabilities: sessionTasks
          .filter((task) => task.status === "running")
          .map((task) => task.capability)
      },
      null,
      2
    )
  );
}

async function enrollAgent(environmentId, name, capabilities) {
  const tokenResponse = await postJson(
    `/api/environments/${environmentId}/enrollment-token`,
    { ttlMinutes: 15 },
    operatorHeaders()
  );
  assert.equal(tokenResponse.status, 200, `expected enrollment token for ${name}`);

  const response = await postJson(
    "/api/agent/enroll",
    {
      environmentId,
      name,
      version: "test",
      capabilities
    },
    enrollmentHeaders(tokenResponse.body.token)
  );
  assert.equal(response.status, 201, `expected ${name} enrollment`);
  return response.body;
}

function spawnProcess(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stdout.write(prefix(command, chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(prefix(command, chunk)));
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
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      return await getJson(path);
    } catch {
      await delay(500);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function getJson(path, headers = {}) {
  const response = await getResponse(path, headers);
  assert(response.status >= 200 && response.status < 300, `GET ${path} returned ${response.status}`);
  return response.body;
}

async function getResponse(path, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: "application/json", ...headers }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function postJson(path, payload, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function operatorHeaders() {
  return { Authorization: `Bearer ${operatorToken}` };
}

function enrollmentHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function agentHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function cleanup() {
  for (const child of children.reverse()) {
    if (!child.killed) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
  await delay(500);
}

try {
  await main();
} finally {
  await cleanup();
}
