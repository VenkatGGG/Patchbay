package agent

import (
	"fmt"
	"os"
	"strings"
	"time"
)

const Version = "0.1.0"

type Config struct {
	ControlPlaneURL string
	EnvironmentID   string
	Name            string
	PollInterval    time.Duration
}

func ConfigFromEnv() (Config, error) {
	hostname, _ := os.Hostname()

	config := Config{
		ControlPlaneURL: strings.TrimRight(getenv("PATCHBAY_CONTROL_PLANE_URL", "http://localhost:3000"), "/"),
		EnvironmentID:   getenv("PATCHBAY_ENVIRONMENT_ID", "env_local"),
		Name:            getenv("PATCHBAY_AGENT_NAME", hostname),
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

func getenv(key string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}
