package capabilities

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/VenkatGGG/Patchbay/agent/internal/protocol"
)

type Handler func(context.Context, map[string]any) (any, error)

type Registry struct {
	handlers map[protocol.Capability]Handler
}

func NewRegistry() *Registry {
	return &Registry{
		handlers: map[protocol.Capability]Handler{
			protocol.CapabilitySystemInfo:         systemInfo,
			protocol.CapabilityProcessList:        processList,
			protocol.CapabilityDiskUsage:          diskUsage,
			protocol.CapabilityNetworkConnections: networkConnections,
			protocol.CapabilityLogsSearch:         logsSearch,
		},
	}
}

func (registry *Registry) Names() []protocol.Capability {
	names := make([]protocol.Capability, 0, len(registry.handlers))
	for name := range registry.handlers {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool { return names[i] < names[j] })
	return names
}

func (registry *Registry) Execute(ctx context.Context, capability protocol.Capability, params map[string]any) (any, error) {
	handler, ok := registry.handlers[capability]
	if !ok {
		return nil, fmt.Errorf("capability denied: %s", capability)
	}

	taskCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return handler(taskCtx, params)
}

func systemInfo(_ context.Context, _ map[string]any) (any, error) {
	hostname, _ := os.Hostname()
	return map[string]any{
		"hostname": hostname,
		"os":       runtime.GOOS,
		"arch":     runtime.GOARCH,
		"go":       runtime.Version(),
		"cpus":     runtime.NumCPU(),
	}, nil
}

func processList(ctx context.Context, params map[string]any) (any, error) {
	limit := intParam(params, "limit", 40)
	output, err := runReadOnlyCommand(ctx, "ps", "-axo", "pid,comm,pcpu,pmem")
	if err != nil {
		return nil, err
	}
	return linesPayload(output, limit), nil
}

func diskUsage(ctx context.Context, _ map[string]any) (any, error) {
	output, err := runReadOnlyCommand(ctx, "df", "-h")
	if err != nil {
		return nil, err
	}
	return linesPayload(output, 80), nil
}

func networkConnections(ctx context.Context, params map[string]any) (any, error) {
	limit := intParam(params, "limit", 60)
	if _, err := exec.LookPath("lsof"); err == nil {
		output, runErr := runReadOnlyCommand(ctx, "lsof", "-nP", "-iTCP", "-sTCP:ESTABLISHED")
		if runErr == nil {
			return linesPayload(output, limit), nil
		}
	}

	output, err := runReadOnlyCommand(ctx, "netstat", "-an")
	if err != nil {
		return nil, err
	}
	return linesPayload(output, limit), nil
}

func logsSearch(_ context.Context, params map[string]any) (any, error) {
	pattern := stringParam(params, "pattern", "timeout|latency|connection|pool|error")
	paths := stringSliceParam(params, "paths")
	if len(paths) == 0 {
		return map[string]any{
			"matches": []string{},
			"notice":  "no log paths configured",
		}, nil
	}

	expression, err := regexp.Compile(pattern)
	if err != nil {
		return nil, err
	}

	matches := make([]string, 0)
	for _, path := range paths {
		fileInfo, err := os.Stat(path)
		if err != nil || fileInfo.IsDir() || fileInfo.Size() > 10*1024*1024 {
			continue
		}

		content, err := os.ReadFile(path)
		if err != nil {
			continue
		}

		for _, line := range strings.Split(string(content), "\n") {
			if expression.MatchString(line) {
				matches = append(matches, Redact(path+": "+line))
				if len(matches) >= 100 {
					return map[string]any{"matches": matches, "truncated": true}, nil
				}
			}
		}
	}

	return map[string]any{"matches": matches}, nil
}

func runReadOnlyCommand(ctx context.Context, name string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, name, args...)
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s failed: %w", name, err)
	}
	return Redact(string(output)), nil
}

func linesPayload(output string, limit int) map[string]any {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	if limit > 0 && len(lines) > limit {
		lines = lines[:limit]
		return map[string]any{"lines": lines, "truncated": true}
	}
	return map[string]any{"lines": lines, "truncated": false}
}

func intParam(params map[string]any, key string, fallback int) int {
	value, ok := params[key]
	if !ok {
		return fallback
	}

	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	default:
		return fallback
	}
}

func stringParam(params map[string]any, key string, fallback string) string {
	value, ok := params[key].(string)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func stringSliceParam(params map[string]any, key string) []string {
	raw, ok := params[key]
	if !ok {
		return nil
	}

	switch typed := raw.(type) {
	case []string:
		return typed
	case []any:
		values := make([]string, 0, len(typed))
		for _, item := range typed {
			if value, ok := item.(string); ok {
				values = append(values, value)
			}
		}
		return values
	default:
		return nil
	}
}
