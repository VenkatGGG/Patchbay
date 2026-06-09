import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.PATCHBAY_FAKE_GEMINI_PORT ?? 3108);
const baseUrl = `http://127.0.0.1:${port}`;
const operatorToken = "fake-gemini-operator-token";
const geminiApiKey = "fake-gemini-api-key";
const geminiModel = "gemini-2.5-flash";
const fakeSummary =
  "Summary\nFake Gemini synthesis completed from redacted Patchbay evidence.";
const requests = [];
const children = [];
let fakeMode = "success";
let fakeGemini;
let fakeGeminiBaseUrl;

async function main() {
  fakeGemini = createFakeGeminiApi();
  await listen(fakeGemini);
  const address = fakeGemini.address();
  assert(address && typeof address === "object", "expected fake Gemini address");
  fakeGeminiBaseUrl = `http://127.0.0.1:${address.port}`;

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
      GEMINI_API_KEY: geminiApiKey,
      GEMINI_MODEL: geminiModel,
      GEMINI_API_BASE_URL: fakeGeminiBaseUrl,
      PATCHBAY_OPERATOR_TOKEN: operatorToken,
      PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
      PATCHBAY_ENROLLMENT_SECRET: "fake-gemini-enrollment-secret",
      PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
      PATCHBAY_AGENT_AUTH_SECRET: "fake-gemini-agent-secret",
      PATCHBAY_AGENT_TOKEN_TTL_MINUTES: "30",
      TAILSCALE_TAILNET: "",
      TAILSCALE_OAUTH_CLIENT_ID: "",
      TAILSCALE_OAUTH_CLIENT_SECRET: "",
      TAILSCALE_AUTH_KEY_TAGS: ""
    }
  );
  children.push(web);

  await waitForJson("/api/health");

  const ready = await getJson("/api/ready");
  const geminiProvider = ready.llmProviders.find((provider) => provider.id === "gemini");
  assert(geminiProvider?.configured === true, "expected Gemini provider configured");
  assert(geminiProvider.selected === true, "expected Gemini provider selected");
  expectReadinessCheck(ready, "llm_provider", "ready");

  const enrollmentTokenResponse = await postJson(
    "/api/environments/env_local/enrollment-token",
    { ttlMinutes: 15 },
    operatorHeaders()
  );
  assert(enrollmentTokenResponse.status === 200, "expected enrollment token");

  const agentResponse = await postJson(
    "/api/agent/enroll",
    {
      environmentId: "env_local",
      name: "fake-gemini-agent",
      version: "test",
      capabilities: ["system.info"]
    },
    enrollmentHeaders(enrollmentTokenResponse.body.token)
  );
  assert(agentResponse.status === 201, "expected agent enrollment");

  const sessionResponse = await postJson(
    "/api/sessions",
    {
      environmentId: "env_local",
      name: "fake Gemini synthesis validation",
      requestedBy: "fake-gemini-smoke",
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
  assert(diagnosticResponse.status === 201, "expected diagnostics creation");
  assert(diagnosticResponse.body.length === 1, "expected one diagnostic task");

  const task = diagnosticResponse.body[0];
  const eventResponse = await postJson(
    `/api/agent/tasks/${task.id}/events`,
    {
      agentId: agentResponse.body.agent.id,
      level: "info",
      message: "Fake Gemini evidence completed",
      status: "completed",
      result: {
        hostname: "fake-gemini-smoke",
        secret: "should_not_be_sent_to_gemini",
        observedLatencyMs: 842
      }
    },
    {
      Authorization: `Bearer ${agentResponse.body.agentToken}`
    }
  );
  assert(eventResponse.status === 201, "expected event ingestion");

  const synthesisResponse = await postJson(
    `/api/sessions/${sessionResponse.body.id}/synthesize`,
    {},
    operatorHeaders()
  );
  assert(synthesisResponse.status === 201, "expected synthesis to succeed");
  assert(
    synthesisResponse.body.provider === `gemini:${geminiModel}`,
    `expected fake Gemini provider gemini:${geminiModel}, got ${synthesisResponse.body.provider}`
  );
  assert(synthesisResponse.body.summary === fakeSummary, "expected fake Gemini summary");
  assert(
    !synthesisResponse.body.summary.includes("offline fallback"),
    "expected Gemini success rather than fallback summary"
  );

  assert(requests.length === 1, `expected one fake Gemini request, got ${requests.length}`);
  const request = requests[0];
  assert(
    request.method === "POST",
    `expected fake Gemini POST request, got ${request.method}`
  );
  assert(
    request.path === `/v1beta/models/${geminiModel}:generateContent`,
    `expected Gemini generateContent path, got ${request.path}`
  );
  assert(request.query.get("key") === geminiApiKey, "expected Gemini API key query");
  assert(
    request.headers["content-type"]?.includes("application/json"),
    "expected JSON content type"
  );
  assert(
    request.body.includes("Fake Gemini evidence completed"),
    "expected evidence event in Gemini request"
  );
  assert(
    request.body.includes("[REDACTED_SECRET]"),
    "expected redacted secret marker in Gemini request"
  );
  assert(
    !request.body.includes("should_not_be_sent_to_gemini"),
    "expected raw secret not to be sent to Gemini"
  );

  const failureCases = [
    {
      mode: "status-error",
      label: "status error"
    },
    {
      mode: "network-failure",
      label: "network failure"
    },
    {
      mode: "invalid-json",
      label: "invalid JSON"
    },
    {
      mode: "missing-text",
      label: "missing text"
    }
  ];

  for (const failureCase of failureCases) {
    fakeMode = failureCase.mode;
    const failureResponse = await synthesizeSession(sessionResponse.body.id);
    assert(
      failureResponse.status === 201,
      `expected ${failureCase.label} fallback synthesis to return 201, got ${failureResponse.status}`
    );
    assert(
      failureResponse.body.provider === `gemini:${geminiModel}:offline-fallback`,
      `expected ${failureCase.label} fallback provider, got ${failureResponse.body.provider}`
    );
    assert(
      failureResponse.body.summary.includes("Gemini synthesis was unavailable"),
      `expected ${failureCase.label} fallback summary to explain provider unavailability`
    );
    assert(
      !failureResponse.body.summary.includes("should_not_be_sent_to_gemini"),
      `expected ${failureCase.label} fallback summary not to expose raw secret`
    );
  }

  assert(
    requests.length === 1 + failureCases.length,
    `expected ${1 + failureCases.length} fake Gemini requests after failures, got ${requests.length}`
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider: synthesisResponse.body.provider,
        fakeGeminiRequests: requests.length,
        readiness: ready.posture.level
      },
      null,
      2
    )
  );
}

function synthesizeSession(sessionId) {
  return postJson(`/api/sessions/${sessionId}/synthesize`, {}, operatorHeaders());
}

function createFakeGeminiApi() {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readBody(request);
    requests.push({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      body
    });

    if (
      request.method === "POST" &&
      url.pathname === `/v1beta/models/${geminiModel}:generateContent`
    ) {
      if (fakeMode === "network-failure") {
        request.socket.destroy();
        return;
      }

      if (fakeMode === "status-error") {
        jsonResponse(response, 503, { error: "temporary fake Gemini outage" });
        return;
      }

      if (fakeMode === "invalid-json") {
        textResponse(response, 200, "not-json");
        return;
      }

      if (fakeMode === "missing-text") {
        jsonResponse(response, 200, {
          candidates: [
            {
              content: {
                parts: [{}]
              }
            }
          ]
        });
        return;
      }

      jsonResponse(response, 200, {
        candidates: [
          {
            content: {
              parts: [{ text: fakeSummary }]
            }
          }
        ]
      });
      return;
    }

    jsonResponse(response, 404, { error: `Unhandled fake Gemini path: ${url.pathname}` });
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

  if (fakeGemini) {
    await new Promise((resolve) => fakeGemini.close(resolve));
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
