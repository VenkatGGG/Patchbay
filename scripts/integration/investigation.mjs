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
  assert.equal(investigationResponse.body.investigation.status, "planned");
  assert.equal(investigationResponse.body.nodes.length, 3);
  assert.deepEqual(
    investigationResponse.body.nodes.map((node) => node.capability),
    ["workload.discover", "system.info", "process.list"]
  );
  assert.deepEqual(investigationResponse.body.nodes[1].dependsOn, ["node_workload_discover"]);

  const state = await getJson("/api/state", operatorHeaders());
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

  console.log(JSON.stringify({ ok: true, nodeCount: investigationResponse.body.nodes.length }, null, 2));
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
