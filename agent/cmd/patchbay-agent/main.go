package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/VenkatGGG/Patchbay/agent/internal/agent"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	config, err := agent.ConfigFromEnv()
	if err != nil {
		logger.Error("invalid config", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := agent.Run(ctx, config, logger); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("agent stopped", "error", err)
		os.Exit(1)
	}
}
