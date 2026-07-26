import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

const enrollment = await import("../src/lib/enrollment-token.ts");
const agent = await import("../src/lib/agent-auth.ts");
const readiness = await import("../src/lib/readiness.ts");

const authEnvironmentKeys = [
  "PATCHBAY_OPERATOR_TOKEN",
  "PATCHBAY_REQUIRE_ENROLLMENT_TOKEN",
  "PATCHBAY_ENROLLMENT_SECRET",
  "PATCHBAY_REQUIRE_AGENT_TOKEN",
  "PATCHBAY_AGENT_AUTH_SECRET"
];

test.afterEach(() => {
  for (const key of authEnvironmentKeys) {
    delete process.env[key];
  }
});

test("optional authentication remains open when flags and operator token are unset", () => {
  assert.deepEqual(enrollment.enrollmentAuthStatus(), {
    required: false,
    secretConfigured: false
  });
  assert.deepEqual(enrollment.verifyEnrollmentToken(undefined, "env_local"), {
    ok: true
  });

  assert.deepEqual(agent.agentAuthStatus(), {
    required: false,
    secretConfigured: false,
    tokenTtlMinutes: 1440
  });
  assert.deepEqual(agent.verifyAgentAuthorization(null), { ok: true });
});

test("configured secrets do not make disabled authentication required", () => {
  process.env.PATCHBAY_ENROLLMENT_SECRET = "configured-enrollment-secret";
  process.env.PATCHBAY_AGENT_AUTH_SECRET = "configured-agent-secret";

  assert.deepEqual(enrollment.enrollmentAuthStatus(), {
    required: false,
    secretConfigured: true
  });
  assert.deepEqual(enrollment.verifyEnrollmentToken(undefined, "env_local"), {
    ok: true
  });
  assert.deepEqual(agent.agentAuthStatus(), {
    required: false,
    secretConfigured: true,
    tokenTtlMinutes: 1440
  });
  assert.deepEqual(agent.verifyAgentAuthorization(null), { ok: true });
});

test("required enrollment authentication reports blank secrets as unconfigured", () => {
  process.env.PATCHBAY_REQUIRE_ENROLLMENT_TOKEN = "true";

  for (const secret of [undefined, "", "   "]) {
    setOptionalEnv("PATCHBAY_ENROLLMENT_SECRET", secret);
    assert.deepEqual(enrollment.enrollmentAuthStatus(), {
      required: true,
      secretConfigured: false
    });
  }
});

test("required enrollment token creation fails without an explicit secret", () => {
  process.env.PATCHBAY_REQUIRE_ENROLLMENT_TOKEN = "true";
  process.env.PATCHBAY_ENROLLMENT_SECRET = "   ";

  assert.throws(() => enrollment.createEnrollmentToken("env_local"), (error) => {
    assert.equal(error.name, "AuthConfigurationError");
    assert.equal(error.code, "AUTH_CONFIGURATION_ERROR");
    assert.equal(error.setting, "PATCHBAY_ENROLLMENT_SECRET");
    return true;
  });
});

test("required enrollment verification throws configuration error before credential validation", () => {
  process.env.PATCHBAY_REQUIRE_ENROLLMENT_TOKEN = "true";
  const token = createLegacyEnrollmentToken(
    "env_local",
    "patchbay-local-dev-secret"
  );

  assert.throws(
    () => enrollment.verifyEnrollmentToken(token, "env_local"),
    (error) =>
      error.name === "AuthConfigurationError" &&
      error.code === "AUTH_CONFIGURATION_ERROR"
  );
});

test("configured enrollment tokens retain their valid verification flow", () => {
  process.env.PATCHBAY_REQUIRE_ENROLLMENT_TOKEN = "true";
  process.env.PATCHBAY_ENROLLMENT_SECRET = "configured-enrollment-secret";

  const token = enrollment.createEnrollmentToken("env_local");
  const verification = enrollment.verifyEnrollmentToken(token, "env_local");

  assert.equal(verification.ok, true);
  assert.equal(verification.payload?.environmentId, "env_local");
  assert.match(verification.payload?.jti ?? "", /^[A-Za-z0-9_-]{20,}$/);
});

test("enrollment tokens receive unique invitation identifiers", () => {
  process.env.PATCHBAY_REQUIRE_ENROLLMENT_TOKEN = "true";
  process.env.PATCHBAY_ENROLLMENT_SECRET = "configured-enrollment-secret";

  const first = enrollment.verifyEnrollmentToken(
    enrollment.createEnrollmentToken("env_local"),
    "env_local"
  );
  const second = enrollment.verifyEnrollmentToken(
    enrollment.createEnrollmentToken("env_local"),
    "env_local"
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.payload?.jti, second.payload?.jti);
  assert.notEqual(
    enrollment.hashEnrollmentTokenId(first.payload?.jti ?? ""),
    first.payload?.jti
  );
});

test("optional enrollment authentication can mint with an explicit secret", () => {
  process.env.PATCHBAY_REQUIRE_ENROLLMENT_TOKEN = "false";
  process.env.PATCHBAY_ENROLLMENT_SECRET = "optional-enrollment-secret";

  const token = enrollment.createEnrollmentToken("env_local");

  assert.equal(token.split(".").length, 2);
  assert.deepEqual(enrollment.enrollmentTokenMintingStatus(), {
    available: true,
    required: false
  });
});

test("optional enrollment without a secret reports token minting disabled", () => {
  process.env.PATCHBAY_REQUIRE_ENROLLMENT_TOKEN = "false";
  delete process.env.PATCHBAY_ENROLLMENT_SECRET;

  assert.deepEqual(enrollment.enrollmentTokenMintingStatus(), {
    available: false,
    required: false
  });
  assert.throws(
    () => enrollment.createEnrollmentToken("env_local"),
    (error) =>
      error.name === "AuthConfigurationError" &&
      error.code === "AUTH_CONFIGURATION_ERROR"
  );
});

test("required agent authentication reports blank secrets as unconfigured", () => {
  process.env.PATCHBAY_REQUIRE_AGENT_TOKEN = "true";

  for (const secret of [undefined, "", "   "]) {
    setOptionalEnv("PATCHBAY_AGENT_AUTH_SECRET", secret);
    assert.deepEqual(agent.agentAuthStatus(), {
      required: true,
      secretConfigured: false,
      tokenTtlMinutes: 1440
    });
  }
});

test("required agent token creation fails without its explicit secret", () => {
  process.env.PATCHBAY_REQUIRE_AGENT_TOKEN = "true";
  process.env.PATCHBAY_ENROLLMENT_SECRET = "must-not-be-reused";

  assert.throws(
    () => agent.createAgentTokenEnvelope("agent-1", "env_local"),
    (error) => {
      assert.equal(error.name, "AuthConfigurationError");
      assert.equal(error.code, "AUTH_CONFIGURATION_ERROR");
      assert.equal(error.setting, "PATCHBAY_AGENT_AUTH_SECRET");
      return true;
    }
  );
});

test("required agent verification throws configuration error before credential validation", () => {
  process.env.PATCHBAY_REQUIRE_AGENT_TOKEN = "true";
  process.env.PATCHBAY_ENROLLMENT_SECRET = "enrollment-only-secret";

  for (const fallback of [
    "enrollment-only-secret",
    "patchbay-local-dev-agent-secret"
  ]) {
    const token = createLegacyAgentToken("agent-1", "env_local", fallback);
    assert.throws(
      () => agent.verifyAgentAuthorization(`Bearer ${token}`, "agent-1"),
      (error) =>
        error.name === "AuthConfigurationError" &&
        error.code === "AUTH_CONFIGURATION_ERROR"
    );
  }
});

test("disabled agent authentication does not create a signed token", () => {
  delete process.env.PATCHBAY_REQUIRE_AGENT_TOKEN;
  delete process.env.PATCHBAY_AGENT_AUTH_SECRET;

  assert.deepEqual(
    agent.createAgentTokenEnvelope("agent-1", "env_local"),
    {}
  );
});

test("configured agent tokens retain creation and verification flows", () => {
  process.env.PATCHBAY_REQUIRE_AGENT_TOKEN = "true";
  process.env.PATCHBAY_AGENT_AUTH_SECRET = "configured-agent-secret";

  const envelope = agent.createAgentTokenEnvelope("agent-1", "env_local");
  const verification = agent.verifyAgentAuthorization(
    `Bearer ${envelope.agentToken}`,
    "agent-1"
  );

  assert.deepEqual(verification, {
    ok: true,
    agentId: "agent-1",
    environmentId: "env_local",
    expiresAt: envelope.agentTokenExpiresAt
  });
});

test("readiness maps ready and degraded posture to HTTP 200", () => {
  assert.deepEqual(readiness.readinessHttpResponse({ level: "ready" }), {
    status: "ready",
    httpStatus: 200
  });
  assert.deepEqual(readiness.readinessHttpResponse({ level: "degraded" }), {
    status: "ready",
    httpStatus: 200
  });
});

test("readiness maps blocked posture to not_ready and HTTP 503", () => {
  assert.deepEqual(readiness.readinessHttpResponse({ level: "blocked" }), {
    status: "not_ready",
    httpStatus: 503
  });
});

function createLegacyEnrollmentToken(environmentId, secret) {
  const payload = {
    purpose: "agent_enrollment",
    environmentId,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  return signedToken(payload, secret);
}

function createLegacyAgentToken(agentId, environmentId, secret) {
  const issuedAt = new Date();
  const payload = {
    purpose: "agent_api",
    agentId,
    environmentId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString()
  };
  return signedToken(payload, secret);
}

function signedToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

function setOptionalEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
