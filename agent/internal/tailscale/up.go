package tailscale

import (
	"context"
	"fmt"
	"os/exec"
	"time"
)

func Up(ctx context.Context, authKey string, hostname string) error {
	if authKey == "" {
		return fmt.Errorf("tailscale auth key is required")
	}

	if _, err := exec.LookPath("tailscale"); err != nil {
		return fmt.Errorf("tailscale CLI not found: %w", err)
	}

	upCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	args := []string{"up", "--auth-key=" + authKey}
	if hostname != "" {
		args = append(args, "--hostname="+hostname)
	}

	output, err := exec.CommandContext(upCtx, "tailscale", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("tailscale up failed: %w: %s", err, RedactOutput(string(output)))
	}

	return nil
}

func RedactOutput(output string) string {
	if len(output) > 500 {
		return output[:500] + "..."
	}
	return output
}
