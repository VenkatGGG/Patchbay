package capabilities

import "regexp"

var (
	secretAssignmentPattern = regexp.MustCompile(`(?i)(["']?\b(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|DATABASE_URL|GEMINI_API_KEY|GOOGLE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|TAILSCALE_OAUTH_CLIENT_SECRET|PATCHBAY_OPERATOR_TOKEN|PATCHBAY_AGENT_AUTH_SECRET|[A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|COOKIE|API[_-]?KEY|CLIENT[_-]?SECRET)[A-Z0-9_-]*)\b["']?\s*(?:=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)`)
	bearerPattern           = regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._~+/\-]+=*`)
	privateKeyPattern       = regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`)
	urlCredentialPattern    = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://)[^:\s/@]+:[^@\s]+@`)
)

func Redact(input string) string {
	redacted := privateKeyPattern.ReplaceAllString(input, "[REDACTED_PRIVATE_KEY]")
	redacted = bearerPattern.ReplaceAllString(redacted, "Bearer [REDACTED_TOKEN]")
	redacted = secretAssignmentPattern.ReplaceAllString(redacted, "${1}[REDACTED_SECRET]")
	redacted = urlCredentialPattern.ReplaceAllString(redacted, "${1}[REDACTED_CREDENTIALS]@")
	return redacted
}
