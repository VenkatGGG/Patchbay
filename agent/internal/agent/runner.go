package agent

import (
	"context"
	"log/slog"
	"time"

	"github.com/VenkatGGG/Patchbay/agent/internal/capabilities"
	"github.com/VenkatGGG/Patchbay/agent/internal/protocol"
	"github.com/VenkatGGG/Patchbay/agent/internal/tailscale"
)

func Run(ctx context.Context, config Config, logger *slog.Logger) error {
	client := NewClient(config.ControlPlaneURL, config.EnrollmentToken)
	registry := capabilities.NewRegistry()
	tailscaleState := tailscale.Detect(ctx)

	enrollment, err := client.Enroll(ctx, protocol.EnrollRequest{
		EnvironmentID: config.EnvironmentID,
		Name:          config.Name,
		Version:       Version,
		Capabilities:  registry.Names(),
		Tailscale:     &tailscaleState,
	})
	if err != nil {
		return err
	}

	logger.Info(
		"agent enrolled",
		"agent_id", enrollment.Agent.ID,
		"environment_id", enrollment.Agent.EnvironmentID,
		"tailscale", enrollment.Tailscale.AuthKeyPreview,
	)

	ticker := time.NewTicker(config.PollInterval)
	defer ticker.Stop()

	for {
		if err := runPollCycle(ctx, client, registry, enrollment.Agent.ID, logger); err != nil {
			logger.Warn("poll cycle failed", "error", err)
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func runPollCycle(
	ctx context.Context,
	client *Client,
	registry *capabilities.Registry,
	agentID string,
	logger *slog.Logger,
) error {
	tasks, err := client.PollTasks(ctx, agentID)
	if err != nil {
		return err
	}

	for _, task := range tasks {
		logger.Info("running task", "task_id", task.ID, "capability", task.Capability)
		if err := client.SendTaskEvent(ctx, task.ID, protocol.TaskEvent{
			AgentID: agentID,
			Level:   "info",
			Message: "Task started",
			Status:  "running",
		}); err != nil {
			return err
		}

		result, err := registry.Execute(ctx, task.Capability, task.Params)
		if err != nil {
			_ = client.SendTaskEvent(ctx, task.ID, protocol.TaskEvent{
				AgentID: agentID,
				Level:   "error",
				Message: "Task failed",
				Status:  "failed",
				Error:   err.Error(),
			})
			continue
		}

		if err := client.SendTaskEvent(ctx, task.ID, protocol.TaskEvent{
			AgentID: agentID,
			Level:   "info",
			Message: "Task completed",
			Status:  "completed",
			Result:  result,
			Payload: result,
		}); err != nil {
			return err
		}
	}

	return nil
}
