const secretAssignmentPattern =
  /\b(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|DATABASE_URL|GEMINI_API_KEY|GOOGLE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|TAILSCALE_OAUTH_CLIENT_SECRET|PATCHBAY_OPERATOR_TOKEN|PATCHBAY_AGENT_AUTH_SECRET)=\S+/gi;
const bearerPattern = /bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const privateKeyPattern =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const urlCredentialPattern = /([a-z][a-z0-9+.-]*:\/\/)[^:\s/@]+:[^@\s]+@/gi;
const sensitiveKeyPattern =
  /(^|[_-])(token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|client[_-]?secret)([_-]|$)/i;

export function redactString(value: string) {
  return value
    .replace(privateKeyPattern, "[REDACTED_PRIVATE_KEY]")
    .replace(secretAssignmentPattern, "[REDACTED_SECRET]")
    .replace(bearerPattern, "Bearer [REDACTED_TOKEN]")
    .replace(urlCredentialPattern, "$1[REDACTED_CREDENTIALS]@");
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (typeof value !== "object") {
    return value;
  }

  if (depth > 8) {
    return "[TRUNCATED_DEPTH]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED_SECRET]" : redactValue(item, depth + 1)
    ])
  );
}

export function isSensitiveKey(key: string) {
  return sensitiveKeyPattern.test(key);
}
