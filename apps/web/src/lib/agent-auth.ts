import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthConfigurationError } from "./auth-configuration.ts";

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
  if (!isAgentTokenRequired()) {
    return {};
  }

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
  const tokenRequired = isAgentTokenRequired() || options.requireToken;
  if (!tokenRequired) {
    return { ok: true };
  }

  const secret = agentSecret();

  const token = bearerToken(authorization);
  if (!token) {
    return { ok: false, reason: "Agent token required" };
  }

  const payload = verifyAgentToken(token, secret);
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
    required: isAgentTokenRequired(),
    secretConfigured: Boolean(configuredAgentSecret()),
    tokenTtlMinutes: agentTokenTtlMinutes()
  };
}

export function assertAgentAuthConfigured() {
  if (isAgentTokenRequired()) {
    agentSecret();
  }
}

function verifyAgentToken(token: string, secret: string) {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return undefined;
  }
  const [body, signature] = parts;
  if (!body || !signature || !safeEqual(signature, sign(body, secret))) {
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

export function isAgentTokenRequired() {
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

  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}

function sign(body: string, secret = agentSecret()) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function agentSecret() {
  const secret = configuredAgentSecret();
  if (secret) {
    return secret;
  }
  throw new AuthConfigurationError("PATCHBAY_AGENT_AUTH_SECRET");
}

function configuredAgentSecret() {
  const secret = process.env.PATCHBAY_AGENT_AUTH_SECRET?.trim();
  return secret && secret.length > 0 ? secret : undefined;
}

function safeEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
