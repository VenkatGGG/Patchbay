import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.PATCHBAY_AGENT_LEASE_PORT ?? 3111);
const baseUrl = `http://127.0.0.1:${port}`;
const operatorToken = "agent-lease-operator-token";
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
      PATCHBAY_AGENT_LEASE_SECONDS: "1",
      PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
      PATCHBAY_ENROLLMENT_SECRET: "agent-lease-enrollment-secret",
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: "agent-lease-agent-secret",
      PATCHBAY_AGENT_TOKEN_TTL_MINUTES: "30",
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

  const tokenResponse = await postJson(
    "/api/environments/env_local/enrollment-token",
    { ttlMinutes: 15 },
    operatorHeaders()
  );
  assert(tokenResponse.status === 200, "expected enrollment token");

  const agentResponse = await postJson(
    "/api/agent/enroll",
    {
      environmentId: "env_local",
      name: "lease-agent",
      version: "test",
      capabilities: ["system.info"]
    },
    enrollmentHeaders(tokenResponse.body.token)
  );
  assert(agentResponse.status === 201, "expected agent enrollment");

  const sessionResponse = await postJson(
    "/api/sessions",
    {
      environmentId: "env_local",
      name: "agent lease session",
      requestedBy: "agent-lease-test",
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
  assert(diagnosticResponse.status === 201, "expected diagnostic creation");

  const claimResponse = await getResponse(
    `/api/agent/tasks?agentId=${agentResponse.body.agent.id}`,
    agentHeaders(agentResponse.body.agentToken)
  );
  assert(claimResponse.status === 200, "expected initial task poll");
  assert(claimResponse.body.length === 1, "expected one system info task");

  const activeState = await getJson("/api/state", operatorHeaders());
  const activeAgent = findAgent(activeState, agentResponse.body.agent.id);
  assert(activeAgent.status === "online", "expected active agent to be online");
  assert(
    Date.parse(activeAgent.leaseExpiresAt) > Date.now(),
    "expected active agent lease to be in the future"
  );

  await delay(1_300);

  const staleState = await getJson("/api/state", operatorHeaders());
  const staleAgent = findAgent(staleState, agentResponse.body.agent.id);
  assert(staleAgent.status === "offline", "expected expired lease to mark agent offline");
  assert(
    staleState.audit.some(
      (event) => event.action === "agent.lease.expired" && event.target === staleAgent.id
    ),
    "expected agent lease expiry audit event"
  );

  const recoveryResponse = await getResponse(
    `/api/agent/tasks?agentId=${agentResponse.body.agent.id}`,
    agentHeaders(agentResponse.body.agentToken)
  );
  assert(recoveryResponse.status === 200, "expected stale agent to recover on poll");

  const recoveredState = await getJson("/api/state", operatorHeaders());
  const recoveredAgent = findAgent(recoveredState, agentResponse.body.agent.id);
  assert(recoveredAgent.status === "online", "expected recovered agent to be online");
  assert(
    Date.parse(recoveredAgent.leaseExpiresAt) > Date.now(),
    "expected recovery poll to extend the lease"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        statusAfterExpiry: staleAgent.status,
        statusAfterRecovery: recoveredAgent.status
      },
      null,
      2
    )
  );
}

function findAgent(state, agentId) {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  assert(agent, `expected agent ${agentId} in state`);
  return agent;
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
