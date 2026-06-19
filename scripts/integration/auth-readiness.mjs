import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.PATCHBAY_AUTH_READINESS_PORT ?? 3110);
const baseUrl = `http://127.0.0.1:${port}`;
let child;

try {
  child = spawn(
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
        PATCHBAY_OPERATOR_TOKEN: "",
        PATCHBAY_REQUIRE_ENROLLMENT_TOKEN: "true",
        PATCHBAY_ENROLLMENT_SECRET: "   ",
        PATCHBAY_REQUIRE_AGENT_TOKEN: "true",
        PATCHBAY_AGENT_AUTH_SECRET: "",
        GEMINI_API_KEY: "",
        TAILSCALE_TAILNET: "",
        TAILSCALE_OAUTH_CLIENT_ID: "",
        TAILSCALE_OAUTH_CLIENT_SECRET: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  await waitForHealth(output);

  const response = await fetch(`${baseUrl}/api/ready`, {
    headers: { accept: "application/json" }
  });
  const body = await response.json();

  assert(response.status === 503, `expected readiness 503, got ${response.status}`);
  assert(body.status === "not_ready", `expected not_ready, got ${body.status}`);
  assert(body.posture?.level === "blocked", "expected blocked readiness posture");
  assert(body.posture?.criticalCount === 2, "expected two critical auth checks");
  expectCriticalCheck(body, "enrollment_auth");
  expectCriticalCheck(body, "agent_auth");
  assert(body.enrollmentAuth?.secretConfigured === false, "expected enrollment secret unconfigured");
  assert(body.agentAuth?.secretConfigured === false, "expected agent secret unconfigured");
  assert(
    response.headers.get("cache-control") === "no-store",
    "expected readiness response to disable caching"
  );

  console.log(
    JSON.stringify(
      {
        status: response.status,
        readiness: body.status,
        posture: body.posture.level,
        criticalChecks: body.posture.checks
          .filter((check) => check.status === "critical")
          .map((check) => check.id)
      },
      null,
      2
    )
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(5_000)
    ]);
  }
}

async function waitForHealth(output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`web process exited before health check:\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for web server:\n${output}`);
}

function expectCriticalCheck(body, id) {
  const check = body.posture?.checks?.find((candidate) => candidate.id === id);
  assert(check, `expected readiness check ${id}`);
  assert(check.status === "critical", `expected ${id} to be critical`);
  assert(check.summary.includes("missing"), `expected useful ${id} summary`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
