import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.PATCHBAY_TWO_AGENT_PORT ?? 3112);
const baseUrl = `http://127.0.0.1:${port}`;
const operatorToken = "two-agent-operator-token";
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
      PATCHBAY_ENROLLMENT_SECRET: "two-agent-enrollment-secret",
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: "two-agent-agent-secret",
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

  const discoveryAgent = await enrollAgent(
    "two-agent-discovery",
    ["workload.discover", "system.info"]
  );
  const processAgent = await enrollAgent("two-agent-process", ["process.list"]);
  const discoveryAuth = enrollmentHeaders(discoveryAgent.agentToken);
  const processAuth = enrollmentHeaders(processAgent.agentToken);

  const sessionResponse = await postJson(
    "/api/sessions",
    {
      environmentId: "env_local",
      name: "two-agent latency incident",
      requestedBy: "two-agent-release-test",
      ttlMinutes: 15
    },
    operatorHeaders()
  );
  assert.equal(sessionResponse.status, 201, "expected session creation");

  const investigationResponse = await postJson(
    `/api/sessions/${sessionResponse.body.id}/investigations`,
    {
      objective: "Investigate a latency spike across two specialized agents",
      capabilities: ["workload.discover", "system.info", "process.list"]
    },
    operatorHeaders()
  );
  assert.equal(investigationResponse.status, 201, "expected investigation creation");
  assert.equal(investigationResponse.body.tasks.length, 1, "expected one root task");

  const rootTask = investigationResponse.body.tasks[0];
  const discoveryRootClaim = await getResponse(
    `/api/agent/tasks?agentId=${discoveryAgent.agent.id}`,
    discoveryAuth
  );
  assert.deepEqual(
    discoveryRootClaim.body.map((task) => task.capability),
    ["workload.discover"],
    "expected discovery agent to claim the root capability"
  );
  const processRootClaim = await getResponse(
    `/api/agent/tasks?agentId=${processAgent.agent.id}`,
    processAuth
  );
  assert.deepEqual(processRootClaim.body, [], "expected process agent to wait for its dependency");
  await completeTask(rootTask.id, discoveryAgent.agent.id, discoveryAuth, "workload discovered");

  let state = await getJson("/api/state", operatorHeaders());
  const systemTask = findQueuedTask(state, sessionResponse.body.id, "system.info");
  const processBeforeSystem = state.tasks.find(
    (task) => task.sessionId === sessionResponse.body.id && task.capability === "process.list"
  );
  assert.equal(processBeforeSystem, undefined, "expected process task to remain uncreated");

  const discoverySystemClaim = await getResponse(
    `/api/agent/tasks?agentId=${discoveryAgent.agent.id}`,
    discoveryAuth
  );
  assert.deepEqual(
    discoverySystemClaim.body.map((task) => task.capability),
    ["system.info"],
    "expected discovery agent to claim system information"
  );
  await completeTask(systemTask.id, discoveryAgent.agent.id, discoveryAuth, "system inspected");

  state = await getJson("/api/state", operatorHeaders());
  const processTask = findQueuedTask(state, sessionResponse.body.id, "process.list");
  const discoveryProcessClaim = await getResponse(
    `/api/agent/tasks?agentId=${discoveryAgent.agent.id}`,
    discoveryAuth
  );
  assert.deepEqual(
    discoveryProcessClaim.body,
    [],
    "expected discovery agent not to claim an unsupported capability"
  );
  const processClaim = await getResponse(
    `/api/agent/tasks?agentId=${processAgent.agent.id}`,
    processAuth
  );
  assert.deepEqual(
    processClaim.body.map((task) => task.capability),
    ["process.list"],
    "expected process agent to claim the unlocked process capability"
  );
  await completeTask(processTask.id, processAgent.agent.id, processAuth, "processes inspected");

  state = await getJson("/api/state", operatorHeaders());
  const investigation = state.investigations.find(
    (item) => item.id === investigationResponse.body.investigation.id
  );
  assert.equal(investigation.status, "completed", "expected investigation completion");
  const nodes = state.investigationNodes.filter(
    (node) => node.investigationId === investigation.id
  );
  assert.deepEqual(
    nodes.map((node) => [node.capability, node.status]),
    [
      ["workload.discover", "completed"],
      ["system.info", "completed"],
      ["process.list", "completed"]
    ],
    "expected all dependency-ordered nodes to complete"
  );
  assert.equal(state.evidence.length, 3, "expected evidence from both agents");
  assert.equal(state.findings.length, 3, "expected findings from both agents");
  assert(
    state.tasks.every((task) => task.agentId),
    "expected every task to retain its responsible agent"
  );

  const synthesisResponse = await postJson(
    `/api/sessions/${sessionResponse.body.id}/synthesize`,
    {},
    operatorHeaders()
  );
  assert.equal(synthesisResponse.status, 201, "expected synthesis");
  assert.equal(synthesisResponse.body.provider, "offline");
  assert(
    synthesisResponse.body.summary.includes("3 artifacts") &&
      synthesisResponse.body.summary.includes("3 structured findings"),
    "expected synthesis to include persisted evidence and findings"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        agents: 2,
        completedNodes: nodes.length,
        evidence: state.evidence.length,
        findings: state.findings.length,
        synthesisProvider: synthesisResponse.body.provider
      },
      null,
      2
    )
  );
}

async function enrollAgent(name, capabilities) {
  const tokenResponse = await postJson(
    "/api/environments/env_local/enrollment-token",
    { ttlMinutes: 15 },
    operatorHeaders()
  );
  assert.equal(tokenResponse.status, 200, `expected enrollment token for ${name}`);
  const response = await postJson(
    "/api/agent/enroll",
    {
      environmentId: "env_local",
      name,
      version: "test",
      capabilities
    },
    enrollmentHeaders(tokenResponse.body.token)
  );
  assert.equal(response.status, 201, `expected ${name} enrollment`);
  return response.body;
}

function findQueuedTask(state, sessionId, capability) {
  const task = state.tasks.find(
    (candidate) =>
      candidate.sessionId === sessionId &&
      candidate.capability === capability &&
      candidate.status === "queued"
  );
  assert(task, `expected queued ${capability} task`);
  return task;
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

async function completeTask(taskId, agentId, headers, message) {
  const response = await postJson(
    `/api/agent/tasks/${taskId}/events`,
    {
      agentId,
      level: "info",
      message,
      status: "completed",
      idempotencyKey: `${taskId}:completed`,
      result: { ok: true }
    },
    headers
  );
  assert.equal(response.status, 201, `expected task ${taskId} completion`);
}

function operatorHeaders() {
  return { Authorization: `Bearer ${operatorToken}` };
}

function enrollmentHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function cleanup() {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The child may already have exited after the test assertion.
    }
  }
}

try {
  await main();
} finally {
  await cleanup();
}
