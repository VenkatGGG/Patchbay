import { createServer } from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.PATCHBAY_PLANNER_GEMINI_PORT ?? 3111);
const baseUrl = `http://127.0.0.1:${port}`;
const operatorToken = "planner-gemini-operator-token";
const model = "gemini-2.5-flash";
const children = [];
let fakeMode = "valid";
let requests = [];
let fakeGemini;

const validPlan = JSON.stringify({
  version: 1,
  title: "Latency investigation",
  objective: "Investigate API latency",
  nodes: [
    {
      id: "node_system_info",
      capability: "system.info",
      params: {},
      dependsOn: [],
      rationale: "Collect host context"
    },
    {
      id: "node_process_list",
      capability: "process.list",
      params: { limit: 10 },
      dependsOn: ["node_system_info"],
      rationale: "Inspect process pressure"
    }
  ]
});

async function main() {
  fakeGemini = createServer(async (request, response) => {
    requests.push(await readBody(request));
    response.setHeader("content-type", "application/json");
    if (fakeMode === "invalid-json") {
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }));
      return;
    }
    response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: validPlan }] } }] }));
  });
  await listen(fakeGemini);
  const fakeAddress = fakeGemini.address();
  assert(fakeAddress && typeof fakeAddress === "object");

  const web = spawnProcess(
    "pnpm",
    ["--filter", "@patchbay/web", "exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      PATCHBAY_STORAGE: "memory",
      DATABASE_URL: "",
      PATCHBAY_LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: "fake-planner-key",
      GEMINI_MODEL: model,
      GEMINI_API_BASE_URL: `http://127.0.0.1:${fakeAddress.port}`,
      PATCHBAY_OPERATOR_TOKEN: operatorToken,
      PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
      PATCHBAY_ENROLLMENT_SECRET: "planner-gemini-enrollment-secret",
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: "planner-gemini-agent-secret",
      PATCHBAY_LLM_TIMEOUT_MS: "5000",
      TAILSCALE_TAILNET: "",
      TAILSCALE_OAUTH_CLIENT_ID: "",
      TAILSCALE_OAUTH_CLIENT_SECRET: "",
      TAILSCALE_AUTH_KEY_TAGS: ""
    }
  );
  children.push(web);
  await waitForJson("/api/health");

  const tokenResponse = await postJson(
    "/api/environments/env_local/enrollment-token",
    { ttlMinutes: 15 },
    operatorHeaders()
  );
  assert.equal(tokenResponse.status, 200);
  const agentResponse = await postJson(
    "/api/agent/enroll",
    {
      environmentId: "env_local",
      name: "planner-gemini-agent",
      version: "test",
      capabilities: ["system.info", "process.list"]
    },
    { Authorization: `Bearer ${tokenResponse.body.token}` }
  );
  assert.equal(agentResponse.status, 201);

  const sessionResponse = await postJson(
    "/api/sessions",
    {
      environmentId: "env_local",
      name: "Gemini planner validation",
      requestedBy: "planner-gemini-test",
      ttlMinutes: 15
    },
    operatorHeaders()
  );
  assert.equal(sessionResponse.status, 201);

  const planResponse = await postJson(
    `/api/sessions/${sessionResponse.body.id}/investigations`,
    {
      objective: "Investigate API latency with API_KEY=should_not_be_sent_to_gemini",
      capabilities: ["system.info", "process.list"]
    },
    operatorHeaders()
  );
  assert.equal(planResponse.status, 201, JSON.stringify(planResponse.body));
  assert.equal(planResponse.body.planner, `gemini:${model}`);
  assert.deepEqual(
    planResponse.body.nodes.map((node) => node.capability),
    ["system.info", "process.list"]
  );
  assert.equal(requests.length, 1);
  assert(requests[0].includes("Investigate API latency"));
  assert(requests[0].includes("[REDACTED_SECRET]"));
  assert(!requests[0].includes("should_not_be_sent_to_gemini"));

  fakeMode = "invalid-json";
  const fallbackResponse = await postJson(
    `/api/sessions/${sessionResponse.body.id}/investigations`,
    {
      objective: "Investigate API latency again",
      capabilities: ["system.info"]
    },
    operatorHeaders()
  );
  assert.equal(fallbackResponse.status, 201);
  assert.equal(fallbackResponse.body.planner, `gemini:${model}:offline-fallback`);
  assert.equal(requests.length, 2);

  console.log(JSON.stringify({ ok: true, planner: planResponse.body.planner, requests: requests.length }, null, 2));
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
  const response = await fetch(`${baseUrl}${path}`, { headers });
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

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function cleanup() {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The child may already have exited after the test assertion.
    }
  }
  fakeGemini?.close();
}

try {
  await main();
} finally {
  await cleanup();
}
