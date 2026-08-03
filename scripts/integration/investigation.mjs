import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.PATCHBAY_INVESTIGATION_PORT ?? 3110);
const baseUrl = `http://127.0.0.1:${port}`;
const operatorToken = "investigation-operator-token";
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
      PATCHBAY_ENROLLMENT_SECRET: "investigation-enrollment-secret",
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: "investigation-agent-secret",
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

  const enrollmentTokenResponse = await postJson(
    "/api/environments/env_local/enrollment-token",
    { ttlMinutes: 15 },
    operatorHeaders()
  );
  assert.equal(enrollmentTokenResponse.status, 200, "expected enrollment token");
  const agentResponse = await postJson(
    "/api/agent/enroll",
    {
      environmentId: "env_local",
      name: "investigation-agent",
      version: "test",
      capabilities: ["workload.discover", "system.info", "process.list"]
    },
    enrollmentHeaders(enrollmentTokenResponse.body.token)
  );
  assert.equal(agentResponse.status, 201, "expected agent enrollment");

  const sessionResponse = await postJson(
    "/api/sessions",
    {
      environmentId: "env_local",
      name: "persisted investigation",
      requestedBy: "investigation-test",
      ttlMinutes: 15
    },
    operatorHeaders()
  );
  assert.equal(sessionResponse.status, 201, "expected session creation");

  const investigationResponse = await postJson(
    `/api/sessions/${sessionResponse.body.id}/investigations`,
    {
      objective: "Investigate a latency spike",
      capabilities: ["workload.discover", "system.info", "process.list"]
    },
    operatorHeaders()
  );
  assert.equal(investigationResponse.status, 201, "expected investigation creation");
  assert.equal(investigationResponse.body.investigation.status, "running");
  assert.equal(investigationResponse.body.nodes.length, 3);
  assert.deepEqual(
    investigationResponse.body.nodes.map((node) => node.capability),
    ["workload.discover", "system.info", "process.list"]
  );
  assert.deepEqual(investigationResponse.body.nodes[1].dependsOn, ["node_workload_discover"]);

  assert.equal(investigationResponse.body.tasks.length, 1, "expected only the root node to queue");
  const agentAuth = enrollmentHeaders(agentResponse.body.agentToken);
  const rootTask = investigationResponse.body.tasks[0];
  const rootClaim = await getResponse(
    `/api/agent/tasks?agentId=${agentResponse.body.agent.id}`,
    agentAuth
  );
  assert.equal(rootClaim.status, 200);
  assert.equal(rootClaim.body.length, 1);
  await completeTask(rootTask.id, agentResponse.body.agent.id, agentAuth, "root completed");

  let state = await getJson("/api/state", operatorHeaders());
  assert.equal(
    state.investigations.some((item) => item.id === investigationResponse.body.investigation.id),
    true,
    "expected persisted investigation in state"
  );
  assert.equal(
    state.investigationNodes.filter(
      (node) => node.investigationId === investigationResponse.body.investigation.id
    ).length,
    3,
    "expected persisted plan nodes in state"
  );

  const systemTask = state.tasks.find(
    (task) => task.investigationNodeId && task.capability === "system.info" && task.status === "queued"
  );
  assert(systemTask, "expected system node to unlock after root completion");
  const systemClaim = await getResponse(
    `/api/agent/tasks?agentId=${agentResponse.body.agent.id}`,
    agentAuth
  );
  assert.equal(systemClaim.body.length, 1);
  await failTask(systemTask.id, agentResponse.body.agent.id, agentAuth, "first failure");

  state = await getJson("/api/state", operatorHeaders());
  const retryTask = state.tasks.find(
    (task) => task.investigationNodeId === systemTask.investigationNodeId && task.status === "queued"
  );
  assert(retryTask, "expected failed node to be retried");
  const retryClaim = await getResponse(
    `/api/agent/tasks?agentId=${agentResponse.body.agent.id}`,
    agentAuth
  );
  assert.equal(retryClaim.body.length, 1);
  await failTask(retryTask.id, agentResponse.body.agent.id, agentAuth, "final failure");

  state = await getJson("/api/state", operatorHeaders());
  const finalInvestigation = state.investigations.find(
    (item) => item.id === investigationResponse.body.investigation.id
  );
  assert.equal(finalInvestigation.status, "failed");
  const finalNodes = state.investigationNodes.filter(
    (node) => node.investigationId === finalInvestigation.id
  );
  assert.equal(finalNodes.find((node) => node.nodeKey === "node_process_list").status, "blocked");

  console.log(JSON.stringify({ ok: true, nodeCount: finalNodes.length, retryCount: 1 }, null, 2));
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
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: "application/json", ...headers }
  });
  assert(response.ok, `GET ${path} returned ${response.status}`);
  return response.json();
}

async function getResponse(path, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
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
  assert.equal(response.status, 201);
}

async function failTask(taskId, agentId, headers, message) {
  const response = await postJson(
    `/api/agent/tasks/${taskId}/events`,
    {
      agentId,
      level: "error",
      message,
      status: "failed",
      idempotencyKey: `${taskId}:failed`,
      error: message
    },
    headers
  );
  assert.equal(response.status, 201);
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
