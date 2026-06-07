package agent

import (
	"strings"
	"testing"
	"time"
)

func TestConfigFromEnvNormalizesProductionSettings(t *testing.T) {
	t.Setenv("PATCHBAY_CONTROL_PLANE_URL", "https://patchbay.example.com///")
	t.Setenv("PATCHBAY_ENVIRONMENT_ID", "env_prod")
	t.Setenv("PATCHBAY_AGENT_NAME", "prod-agent")
	t.Setenv("PATCHBAY_ENROLLMENT_TOKEN", "enrollment-token")
	t.Setenv("PATCHBAY_TAILSCALE_UP", "true")
	t.Setenv("PATCHBAY_POLL_INTERVAL", "2s")

	config, err := ConfigFromEnv()
	if err != nil {
		t.Fatalf("ConfigFromEnv returned error: %v", err)
	}

	if config.ControlPlaneURL != "https://patchbay.example.com" {
		t.Fatalf("unexpected control plane URL: %s", config.ControlPlaneURL)
	}
	if config.EnvironmentID != "env_prod" {
		t.Fatalf("unexpected environment id: %s", config.EnvironmentID)
	}
	if config.Name != "prod-agent" {
		t.Fatalf("unexpected agent name: %s", config.Name)
	}
	if config.EnrollmentToken != "enrollment-token" {
		t.Fatal("expected enrollment token to be preserved")
	}
	if !config.TailscaleUp {
		t.Fatal("expected tailscale bootstrap to be enabled")
	}
	if config.PollInterval != 2*time.Second {
		t.Fatalf("unexpected poll interval: %s", config.PollInterval)
	}
}

func TestConfigFromEnvRejectsInvalidControlPlaneURL(t *testing.T) {
	for _, rawURL := range []string{
		"patchbay.example.com",
		"ftp://patchbay.example.com",
		"http://",
		"////",
	} {
		t.Run(rawURL, func(t *testing.T) {
			t.Setenv("PATCHBAY_CONTROL_PLANE_URL", rawURL)
			t.Setenv("PATCHBAY_POLL_INTERVAL", "5s")

			_, err := ConfigFromEnv()
			if err == nil {
				t.Fatal("expected invalid control plane URL to be rejected")
			}
			if !strings.Contains(err.Error(), "PATCHBAY_CONTROL_PLANE_URL") {
				t.Fatalf("expected control plane URL error, got: %v", err)
			}
		})
	}
}

func TestConfigFromEnvRejectsInvalidPollIntervals(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		interval string
		message  string
	}{
		{name: "too short", interval: "250ms", message: "at least 1s"},
		{name: "not a duration", interval: "soon", message: "parse PATCHBAY_POLL_INTERVAL"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			t.Setenv("PATCHBAY_CONTROL_PLANE_URL", "http://localhost:3000")
			t.Setenv("PATCHBAY_POLL_INTERVAL", testCase.interval)

			_, err := ConfigFromEnv()
			if err == nil {
				t.Fatal("expected invalid poll interval to be rejected")
			}
			if !strings.Contains(err.Error(), testCase.message) {
				t.Fatalf("expected error to contain %q, got: %v", testCase.message, err)
			}
		})
	}
}
