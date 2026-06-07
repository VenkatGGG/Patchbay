import { createHmac, timingSafeEqual } from "node:crypto";

type EnrollmentTokenPayload = {
  purpose: "agent_enrollment";
  environmentId: string;
  expiresAt: string;
};

export type EnrollmentTokenVerification = {
  ok: boolean;
  reason?: string;
  payload?: EnrollmentTokenPayload;
};

export function createEnrollmentToken(environmentId: string, ttlMinutes = 60) {
  const payload: EnrollmentTokenPayload = {
    purpose: "agent_enrollment",
    environmentId,
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString()
  };
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(body);
  return `${body}.${signature}`;
}

export function verifyEnrollmentToken(
  token: string | undefined,
  environmentId: string
): EnrollmentTokenVerification {
  if (!isEnrollmentTokenRequired()) {
    return { ok: true };
  }

  if (!token) {
    return { ok: false, reason: "Enrollment token is required" };
  }

  const [body, signature] = token.split(".");
  if (!body || !signature) {
    return { ok: false, reason: "Enrollment token is malformed" };
  }

  if (!safeEqual(signature, sign(body))) {
    return { ok: false, reason: "Enrollment token signature is invalid" };
  }

  let payload: EnrollmentTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(body)) as EnrollmentTokenPayload;
  } catch {
    return { ok: false, reason: "Enrollment token payload is invalid" };
  }

  if (payload.purpose !== "agent_enrollment") {
    return { ok: false, reason: "Enrollment token has the wrong purpose" };
  }

  if (payload.environmentId !== environmentId) {
    return { ok: false, reason: "Enrollment token is for another environment" };
  }

  if (Date.parse(payload.expiresAt) <= Date.now()) {
    return { ok: false, reason: "Enrollment token has expired" };
  }

  return { ok: true, payload };
}

export function isEnrollmentTokenRequired() {
  return process.env.PATCHBAY_REQUIRE_ENROLLMENT_TOKEN === "true";
}

export function enrollmentAuthStatus() {
  return {
    required: isEnrollmentTokenRequired(),
    secretConfigured: Boolean(process.env.PATCHBAY_ENROLLMENT_SECRET)
  };
}

export function enrollmentTokenFromAuthorization(header: string | null) {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function sign(body: string) {
  return createHmac("sha256", enrollmentSecret()).update(body).digest("base64url");
}

function enrollmentSecret() {
  return process.env.PATCHBAY_ENROLLMENT_SECRET ?? "patchbay-local-dev-secret";
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function base64UrlEncode(input: string) {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input: string) {
  return Buffer.from(input, "base64url").toString("utf8");
}
