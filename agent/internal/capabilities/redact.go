package capabilities

import "regexp"

var redactionPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|DATABASE_URL)=\S+`),
	regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._\-]+`),
	regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`),
}

func Redact(input string) string {
	redacted := input
	for _, pattern := range redactionPatterns {
		redacted = pattern.ReplaceAllStringFunc(redacted, func(match string) string {
			if len(match) > 0 && match[0] == '-' {
				return "[REDACTED_PRIVATE_KEY]"
			}
			return "[REDACTED_SECRET]"
		})
	}
	return redacted
}
