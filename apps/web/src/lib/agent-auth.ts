import { createHmac, timingSafeEqual } from "node:crypto";

type AgentTokenPayload = {
  purpose: "agent_api";
  agentId: string;
  environmentId: string;
  issuedAt: string;
  expiresAt: string;
};

type AgentAuthResult =
  | { ok: true; agentId?: string; environmentId?: string; expiresAt?: string }
  | { ok: false; reason: string };

type AgentAuthOptions = {
  requireToken?: boolean;
};

export function createAgentTokenEnvelope(agentId: string, environmentId: string) {
  const issuedAt = new Date();
  const expiresAt = new Date(
    issuedAt.getTime() + agentTokenTtlMinutes() * 60_000
  ).toISOString();
  const payload: AgentTokenPayload = {
    purpose: "agent_api",
    agentId,
    environmentId,
    issuedAt: issuedAt.toISOString(),
    expiresAt
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    agentToken: `${body}.${sign(body)}`,
    agentTokenExpiresAt: expiresAt
  };
}

export function verifyAgentAuthorization(
  authorization: string | null,
  expectedAgentId?: string,
  options: AgentAuthOptions = {}
): AgentAuthResult {
  if (!agentTokenRequired() && !options.requireToken) {
    return { ok: true };
  }

  const token = bearerToken(authorization);
  if (!token) {
    return { ok: false, reason: "Agent token required" };
  }

  const payload = verifyAgentToken(token);
  if (!payload) {
    return { ok: false, reason: "Agent token rejected" };
  }

  const expiresAtMs = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return { ok: false, reason: "Agent token expired" };
  }

  if (expectedAgentId && payload.agentId !== expectedAgentId) {
    return { ok: false, reason: "Agent token does not match agent" };
  }

  return {
    ok: true,
    agentId: payload.agentId,
    environmentId: payload.environmentId,
    expiresAt: payload.expiresAt
  };
}

export function agentAuthStatus() {
  return {
    required: agentTokenRequired(),
    secretConfigured: Boolean(process.env.PATCHBAY_AGENT_AUTH_SECRET),
    tokenTtlMinutes: agentTokenTtlMinutes()
  };
}

function verifyAgentToken(token: string) {
  const [body, signature] = token.split(".", 2);
  if (!body || !signature || !safeEqual(signature, sign(body))) {
    return undefined;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as AgentTokenPayload;
    if (
      payload.purpose !== "agent_api" ||
      !payload.agentId ||
      !payload.expiresAt
    ) {
      return undefined;
    }
    return payload;
  } catch {
    return undefined;
  }
}

function agentTokenRequired() {
  return process.env.PATCHBAY_REQUIRE_AGENT_TOKEN === "true";
}

function agentTokenTtlMinutes() {
  const value = Number(process.env.PATCHBAY_AGENT_TOKEN_TTL_MINUTES ?? 24 * 60);
  if (!Number.isInteger(value) || value <= 0) {
    return 24 * 60;
  }
  return Math.min(value, 7 * 24 * 60);
}

function bearerToken(header: string | null) {
  if (!header) {
    return undefined;
  }

  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? token?.trim() : undefined;
}

function sign(body: string) {
  return createHmac("sha256", agentSecret()).update(body).digest("base64url");
}

function agentSecret() {
  return (
    process.env.PATCHBAY_AGENT_AUTH_SECRET ??
    process.env.PATCHBAY_ENROLLMENT_SECRET ??
    "patchbay-local-dev-agent-secret"
  );
}

function safeEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
