import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.PATCHBAY_FAKE_TAILSCALE_PORT ?? 3106);
const baseUrl = `http://127.0.0.1:${port}`;
const operatorToken = "fake-tailscale-operator-token";
const enrollmentSecret = "fake-tailscale-enrollment-secret";
const agentSecret = "fake-tailscale-agent-secret";
const tailnet = "fake-tailnet";
const clientId = "fake-client-id";
const clientSecret = "fake-client-secret";
const accessToken = "fake-access-token";
const authKeyId = "fake-auth-key-id";
const authKey = "tskey-auth-fake-local-1234567890";
const requests = [];
const children = [];
let fakeMode = "success";
let fakeTailscale;
let fakeTailscaleBaseUrl;

async function main() {
  fakeTailscale = createFakeTailscaleApi();
  await listen(fakeTailscale);
  const address = fakeTailscale.address();
  assert(address && typeof address === "object", "expected fake Tailscale address");
  fakeTailscaleBaseUrl = `http://127.0.0.1:${address.port}`;

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
      PATCHBAY_LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: "",
      PATCHBAY_OPERATOR_TOKEN: operatorToken,
      PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
      PATCHBAY_ENROLLMENT_SECRET: enrollmentSecret,
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: agentSecret,
      PATCHBAY_AGENT_TOKEN_TTL_MINUTES: "30",
      TAILSCALE_TAILNET: tailnet,
      TAILSCALE_OAUTH_CLIENT_ID: clientId,
      TAILSCALE_OAUTH_CLIENT_SECRET: clientSecret,
      TAILSCALE_API_BASE_URL: fakeTailscaleBaseUrl
    }
  );
  children.push(web);

  await waitForJson("/api/health");

  const ready = await getJson("/api/ready");
  assert(ready.tailscale.configured === true, "expected Tailscale readiness configured");
  expectReadinessCheck(ready, "tailscale", "ready");

  const enrollmentTokenResponse = await postJson(
    "/api/environments/env_local/enrollment-token",
    { ttlMinutes: 15 },
    operatorHeaders()
  );
  assert(enrollmentTokenResponse.status === 200, "expected enrollment token minting");

  const agentResponse = await enrollAgent(
    "fake-tailscale-agent",
    enrollmentTokenResponse.body.token
  );
  assert(
    agentResponse.status === 201,
    `expected Tailscale-backed enrollment 201, got ${agentResponse.status}`
  );
  assert(agentResponse.body.agentToken, "expected signed agent token");
  assert(agentResponse.body.tailscale.available === true, "expected auth key available");
  assert(agentResponse.body.tailscale.authKeyId === authKeyId, "expected auth key id");
  assert(agentResponse.body.tailscale.authKey === authKey, "expected raw auth key in bootstrap response");
  assert(
    agentResponse.body.tailscale.authKeyPreview === "tskey-au...7890",
    `expected auth key preview, got ${agentResponse.body.tailscale.authKeyPreview}`
  );
  assert(
    agentResponse.body.tailscale.tags.includes("tag:patchbay-agent"),
    "expected patchbay agent tag"
  );
  assert(
    agentResponse.body.tailscale.tags.includes("tag:patchbay-env-local"),
    "expected normalized environment tag"
  );
  assert(
    agentResponse.body.agent.tailscale.enabled === true,
    "expected enrolled agent to record Tailscale enabled"
  );

  const stateResponse = await getResponse("/api/state", operatorHeaders());
  assert(stateResponse.status === 200, "expected state response");
  const stateJson = JSON.stringify(stateResponse.body);
  assert(!stateJson.includes(authKey), "expected state not to expose raw auth key");
  assert(stateJson.includes("tskey-au...7890"), "expected state to include only auth key preview");

  const oauthRequest = requests.find((request) => request.path === "/api/v2/oauth/token");
  assert(oauthRequest, "expected OAuth token request");
  assert(
    oauthRequest.headers["content-type"]?.includes("application/x-www-form-urlencoded"),
    "expected OAuth request content type"
  );
  const oauthBody = new URLSearchParams(oauthRequest.body);
  assert(oauthBody.get("client_id") === clientId, "expected OAuth client id");
  assert(oauthBody.get("client_secret") === clientSecret, "expected OAuth client secret");

  const keyRequest = requests.find((request) =>
    request.path === `/api/v2/tailnet/${tailnet}/keys`
  );
  assert(keyRequest, "expected auth key request");
  assert(
    keyRequest.headers.authorization === `Bearer ${accessToken}`,
    "expected bearer token on auth key request"
  );
  const keyBody = JSON.parse(keyRequest.body);
  assert(keyBody.expirySeconds === 1800, "expected short-lived auth key");
  assert(keyBody.capabilities.devices.create.reusable === false, "expected non-reusable key");
  assert(keyBody.capabilities.devices.create.ephemeral === true, "expected ephemeral key");
  assert(keyBody.capabilities.devices.create.preauthorized === true, "expected preauthorized key");
  assert(
    keyBody.capabilities.devices.create.tags.includes("tag:patchbay-agent"),
    "expected auth key agent tag"
  );
  assert(
    keyBody.capabilities.devices.create.tags.includes("tag:patchbay-env-local"),
    "expected auth key environment tag"
  );

  fakeMode = "missing-token";
  const missingTokenAgentResponse = await enrollAgent(
    "fake-tailscale-missing-token-agent",
    enrollmentTokenResponse.body.token
  );
  assert(
    missingTokenAgentResponse.status === 502,
    `expected missing OAuth token response 502, got ${missingTokenAgentResponse.status}`
  );
  assert(
    missingTokenAgentResponse.body.error === "Tailscale enrollment failed",
    "expected sanitized Tailscale failure error"
  );
  assert(
    missingTokenAgentResponse.body.detail ===
      "Tailscale token response did not include access_token",
    "expected missing access token detail"
  );

  fakeMode = "invalid-token-json";
  const invalidTokenJsonAgentResponse = await enrollAgent(
    "fake-tailscale-invalid-token-json-agent",
    enrollmentTokenResponse.body.token
  );
  assert(
    invalidTokenJsonAgentResponse.status === 502,
    `expected invalid OAuth JSON response 502, got ${invalidTokenJsonAgentResponse.status}`
  );
  assert(
    invalidTokenJsonAgentResponse.body.detail ===
      "Tailscale token response was not valid JSON",
    "expected invalid OAuth JSON detail"
  );

  fakeMode = "missing-key";
  const missingKeyAgentResponse = await enrollAgent(
    "fake-tailscale-missing-key-agent",
    enrollmentTokenResponse.body.token
  );
  assert(
    missingKeyAgentResponse.status === 502,
    `expected missing auth key response 502, got ${missingKeyAgentResponse.status}`
  );
  assert(
    missingKeyAgentResponse.body.error === "Tailscale enrollment failed",
    "expected sanitized auth key failure error"
  );
  assert(
    missingKeyAgentResponse.body.detail ===
      "Tailscale auth key response did not include key",
    "expected missing auth key detail"
  );

  fakeMode = "invalid-key-json";
  const invalidKeyJsonAgentResponse = await enrollAgent(
    "fake-tailscale-invalid-key-json-agent",
    enrollmentTokenResponse.body.token
  );
  assert(
    invalidKeyJsonAgentResponse.status === 502,
    `expected invalid key JSON response 502, got ${invalidKeyJsonAgentResponse.status}`
  );
  assert(
    invalidKeyJsonAgentResponse.body.detail ===
      "Tailscale auth key response was not valid JSON",
    "expected invalid auth key JSON detail"
  );

  const failureStateResponse = await getResponse("/api/state", operatorHeaders());
  assert(failureStateResponse.status === 200, "expected state after Tailscale failures");
  const failedAgentNames = new Set(failureStateResponse.body.agents.map((agent) => agent.name));
  assert(
    !failedAgentNames.has("fake-tailscale-missing-token-agent"),
    "expected missing-token Tailscale failure not to persist an agent"
  );
  assert(
    !failedAgentNames.has("fake-tailscale-missing-key-agent"),
    "expected missing-key Tailscale failure not to persist an agent"
  );
  assert(
    !failedAgentNames.has("fake-tailscale-invalid-token-json-agent"),
    "expected invalid-token-json Tailscale failure not to persist an agent"
  );
  assert(
    !failedAgentNames.has("fake-tailscale-invalid-key-json-agent"),
    "expected invalid-key-json Tailscale failure not to persist an agent"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        tailscaleRequests: requests.length,
        authKeyPreview: agentResponse.body.tailscale.authKeyPreview,
        readiness: ready.posture.level
      },
      null,
      2
    )
  );
}

async function enrollAgent(name, token) {
  return postJson(
    "/api/agent/enroll",
    {
      environmentId: "env_local",
      name,
      version: "test",
      capabilities: ["system.info"]
    },
    enrollmentHeaders(token)
  );
}

function createFakeTailscaleApi() {
  return createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({
      method: request.method,
      path: request.url,
      headers: request.headers,
      body
    });

    if (request.method === "POST" && request.url === "/api/v2/oauth/token") {
      if (fakeMode === "invalid-token-json") {
        textResponse(response, 200, "not-json");
        return;
      }

      if (fakeMode === "missing-token") {
        jsonResponse(response, 200, {
          token_type: "Bearer",
          expires_in: 3600
        });
        return;
      }

      jsonResponse(response, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600
      });
      return;
    }

    if (
      request.method === "POST" &&
      request.url === `/api/v2/tailnet/${tailnet}/keys`
    ) {
      if (fakeMode === "invalid-key-json") {
        textResponse(response, 200, "not-json");
        return;
      }

      if (fakeMode === "missing-key") {
        jsonResponse(response, 200, {
          id: authKeyId
        });
        return;
      }

      jsonResponse(response, 200, {
        id: authKeyId,
        key: authKey
      });
      return;
    }

    jsonResponse(response, 404, { error: `Unhandled fake Tailscale path: ${request.url}` });
  });
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function textResponse(response, status, body) {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
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
  assert(
    response.status >= 200 && response.status < 300,
    `GET ${path} returned ${response.status}`
  );
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

  if (fakeTailscale) {
    await new Promise((resolve) => fakeTailscale.close(resolve));
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
process.on("exit", () => {
  for (const child of children.reverse()) {
    if (!child.killed) {
      killProcessGroup(child, "SIGTERM");
    }
  }
});

main()
  .catch(async (error) => {
    console.error(error);
    await cleanup();
    process.exit(1);
  })
  .finally(cleanup);
