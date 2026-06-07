package agent

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

const Version = "0.1.0"

type Config struct {
	ControlPlaneURL string
	EnvironmentID   string
	Name            string
	EnrollmentToken string
	TailscaleUp     bool
	PollInterval    time.Duration
}

func ConfigFromEnv() (Config, error) {
	hostname, _ := os.Hostname()

	controlPlaneURL, err := normalizeControlPlaneURL(
		getenv("PATCHBAY_CONTROL_PLANE_URL", "http://localhost:3000"),
	)
	if err != nil {
		return Config{}, err
	}

	config := Config{
		ControlPlaneURL: controlPlaneURL,
		EnvironmentID:   getenv("PATCHBAY_ENVIRONMENT_ID", "env_local"),
		Name:            getenv("PATCHBAY_AGENT_NAME", hostname),
		EnrollmentToken: getenv("PATCHBAY_ENROLLMENT_TOKEN", ""),
		TailscaleUp:     getenv("PATCHBAY_TAILSCALE_UP", "false") == "true",
	}

	if config.Name == "" {
		config.Name = "patchbay-agent"
	}

	interval, err := time.ParseDuration(getenv("PATCHBAY_POLL_INTERVAL", "5s"))
	if err != nil {
		return Config{}, fmt.Errorf("parse PATCHBAY_POLL_INTERVAL: %w", err)
	}
	if interval < time.Second {
		return Config{}, fmt.Errorf("PATCHBAY_POLL_INTERVAL must be at least 1s")
	}
	config.PollInterval = interval

	return config, nil
}

func normalizeControlPlaneURL(rawURL string) (string, error) {
	value := strings.TrimRight(strings.TrimSpace(rawURL), "/")
	parsed, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("parse PATCHBAY_CONTROL_PLANE_URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("PATCHBAY_CONTROL_PLANE_URL must use http or https")
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("PATCHBAY_CONTROL_PLANE_URL must include a host")
	}
	return value, nil
}

func getenv(key string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}
