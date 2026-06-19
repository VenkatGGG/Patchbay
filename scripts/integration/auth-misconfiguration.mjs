import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const children = [];
const tailscaleRequests = [];
let fakeTailscale;

try {
  fakeTailscale = createServer((request, response) => {
    tailscaleRequests.push(request.url);
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "must not be called" }));
  });
  await listen(fakeTailscale);
  const address = fakeTailscale.address();
  assert(address && typeof address === "object", "expected fake Tailscale address");
  const tailscaleBaseUrl = `http://127.0.0.1:${address.port}`;

  await verifyAgentMisconfigurationHasNoSideEffects(tailscaleBaseUrl);
  await verifyEnrollmentMisconfigurationResponses();
  await verifyOptionalEnrollmentTokenMinting();
  await verifyOpenLocalMode();

  console.log(
    JSON.stringify(
      {
        ok: true,
        tailscaleRequests: tailscaleRequests.length,
        scenarios: [
          "agent secret missing before enrollment side effects",
          "enrollment secret missing returns sanitized 503",
          "optional enrollment secret can mint a token",
          "optional enrollment without secret returns disabled",
          "open local enrollment omits signed agent token"
        ]
      },
      null,
      2
    )
  );
} finally {
  for (const child of children.reverse()) {
    await stop(child);
  }
  if (fakeTailscale) {
    await new Promise((resolve) => fakeTailscale.close(resolve));
  }
}

async function verifyAgentMisconfigurationHasNoSideEffects(tailscaleBaseUrl) {
  const server = await startWeb(3111, {
    PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
    PATCHBAY_ENROLLMENT_SECRET: "integration-enrollment-secret",
    PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
    PATCHBAY_AGENT_AUTH_SECRET: "   ",
    TAILSCALE_TAILNET: "integration-tailnet",
    TAILSCALE_OAUTH_CLIENT_ID: "integration-client",
    TAILSCALE_OAUTH_CLIENT_SECRET: "integration-secret",
    TAILSCALE_API_BASE_URL: tailscaleBaseUrl
  });
  const before = await request(server.baseUrl, "/api/state");
  const mint = await request(
    server.baseUrl,
    "/api/environments/env_local/enrollment-token",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlMinutes: 15 })
    }
  );
  assert(mint.status === 200, `expected required minting 200, got ${mint.status}`);
  assert(
    typeof mint.body.token === "string" && mint.body.token.split(".").length === 2,
    "expected required signed enrollment token"
  );
  const token = signedEnrollmentToken(
    "env_local",
    "integration-enrollment-secret"
  );

  const enrollment = await request(server.baseUrl, "/api/agent/enroll", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(enrollmentBody("misconfigured-agent"))
  });
  expectConfigurationFailure(enrollment);

  const polling = await request(
    server.baseUrl,
    "/api/agent/tasks?agentId=agt_missing"
  );
  expectConfigurationFailure(polling);

  const event = await request(
    server.baseUrl,
    "/api/agent/tasks/task_missing/events",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "agt_missing",
        level: "info",
        message: "must not mutate"
      })
    }
  );
  expectConfigurationFailure(event);

  const refresh = await request(server.baseUrl, "/api/agent/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  expectConfigurationFailure(refresh);

  const after = await request(server.baseUrl, "/api/state");
  assert(
    after.body.agents.length === before.body.agents.length,
    "misconfigured enrollment must not create an agent"
  );
  assert(
    tailscaleRequests.length === 0,
    "misconfigured enrollment must not call Tailscale"
  );
  await stop(server.child);
}

async function verifyEnrollmentMisconfigurationResponses() {
  const server = await startWeb(3112, {
    PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
    PATCHBAY_ENROLLMENT_SECRET: "",
    PATCHBAY_REQUIRE_AGENT_TOKEN: "false",
    PATCHBAY_AGENT_AUTH_SECRET: ""
  });

  const mint = await request(
    server.baseUrl,
    "/api/environments/env_local/enrollment-token",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlMinutes: 15 })
    }
  );
  expectConfigurationFailure(mint);

  const enrollment = await request(server.baseUrl, "/api/agent/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(enrollmentBody("missing-enrollment-secret"))
  });
  expectConfigurationFailure(enrollment);
  await stop(server.child);
}

async function verifyOpenLocalMode() {
  const server = await startWeb(3113, {
    PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "false",
    PATCHBAY_ENROLLMENT_SECRET: "",
    PATCHBAY_REQUIRE_AGENT_TOKEN: "false",
    PATCHBAY_AGENT_AUTH_SECRET: ""
  });

  const mint = await request(
    server.baseUrl,
    "/api/environments/env_local/enrollment-token",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlMinutes: 15 })
    }
  );
  assert(mint.status === 409, `expected disabled minting 409, got ${mint.status}`);
  assert(
    mint.body.code === "ENROLLMENT_AUTH_DISABLED",
    `expected disabled code, got ${mint.body.code}`
  );
  assert(
    mint.body.error === "Enrollment authentication is disabled",
    `unexpected disabled error: ${mint.body.error}`
  );

  const enrollment = await request(server.baseUrl, "/api/agent/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(enrollmentBody("open-local-agent"))
  });
  assert(enrollment.status === 201, `expected open enrollment 201, got ${enrollment.status}`);
  assert(!enrollment.body.agentToken, "open enrollment must not issue an agent token");
  assert(
    !enrollment.body.agentTokenExpiresAt,
    "open enrollment must not issue a token expiry"
  );

  const polling = await request(
    server.baseUrl,
    `/api/agent/tasks?agentId=${encodeURIComponent(enrollment.body.agent.id)}`
  );
  assert(polling.status === 200, `expected open polling 200, got ${polling.status}`);

  const refresh = await request(server.baseUrl, "/api/agent/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert(refresh.status === 200, `expected open refresh 200, got ${refresh.status}`);
  assert(refresh.body.authRequired === false, "expected explicit no-auth-required response");
  assert(!refresh.body.agentToken, "open refresh must not sign an agent token");
  await stop(server.child);
}

async function verifyOptionalEnrollmentTokenMinting() {
  const server = await startWeb(3114, {
    PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "false",
    PATCHBAY_ENROLLMENT_SECRET: "optional-enrollment-secret",
    PATCHBAY_REQUIRE_AGENT_TOKEN: "false",
    PATCHBAY_AGENT_AUTH_SECRET: ""
  });

  const mint = await request(
    server.baseUrl,
    "/api/environments/env_local/enrollment-token",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlMinutes: 15 })
    }
  );
  assert(mint.status === 200, `expected optional minting 200, got ${mint.status}`);
  assert(
    typeof mint.body.token === "string" && mint.body.token.split(".").length === 2,
    "expected signed optional enrollment token"
  );
  await stop(server.child);
}

async function startWeb(port, overrides) {
  const child = spawn(
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
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATCHBAY_STORAGE: "memory",
        DATABASE_URL: "",
        PATCHBAY_OPERATOR_TOKEN: "",
        GEMINI_API_KEY: "",
        TAILSCALE_TAILNET: "",
        TAILSCALE_OAUTH_CLIENT_ID: "",
        TAILSCALE_OAUTH_CLIENT_SECRET: "",
        TAILSCALE_API_BASE_URL: "",
        ...overrides
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`web process exited before health check:\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return { baseUrl, child };
      }
    } catch {
      // Server is still starting.
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for web server:\n${output}`);
}

async function request(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...init.headers
    }
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

function expectConfigurationFailure(response) {
  assert(response.status === 503, `expected 503, got ${response.status}`);
  assert(
    response.body.code === "AUTH_CONFIGURATION_ERROR",
    `expected auth configuration code, got ${response.body.code}`
  );
  assert(
    response.body.error === "Authentication service is not configured",
    `unexpected public error: ${response.body.error}`
  );
  const serialized = JSON.stringify(response.body);
  assert(!serialized.includes("PATCHBAY_"), "response must not expose environment variable names");
  assert(!serialized.includes("secret"), "response must not expose secret configuration detail");
}

function enrollmentBody(name) {
  return {
    environmentId: "env_local",
    name,
    version: "integration",
    capabilities: ["system.info"]
  };
}

function signedEnrollmentToken(environmentId, secret) {
  const body = Buffer.from(
    JSON.stringify({
      purpose: "agent_enrollment",
      environmentId,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000)
  ]);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
