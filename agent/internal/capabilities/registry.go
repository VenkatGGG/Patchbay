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

type WorkloadPack struct {
	Metadata protocol.WorkloadPackMetadata
	Handlers map[protocol.Capability]Handler
}

type Registry struct {
	handlers map[protocol.Capability]Handler
	packs    []protocol.WorkloadPackMetadata
}

func NewRegistry() *Registry {
	registry, err := NewRegistryWithPacks(builtinWorkloadPacks()...)
	if err != nil {
		panic(err)
	}
	return registry
}

func NewRegistryWithPacks(packs ...WorkloadPack) (*Registry, error) {
	registry := &Registry{
		handlers: map[protocol.Capability]Handler{},
		packs:    make([]protocol.WorkloadPackMetadata, 0, len(packs)),
	}

	for _, pack := range packs {
		if err := validateWorkloadPack(pack); err != nil {
			return nil, err
		}
		for _, capability := range pack.Metadata.Capabilities {
			if _, exists := registry.handlers[capability.Name]; exists {
				return nil, fmt.Errorf("duplicate capability: %s", capability.Name)
			}
			registry.handlers[capability.Name] = pack.Handlers[capability.Name]
		}
		registry.packs = append(registry.packs, clonePackMetadata(pack.Metadata))
	}

	sort.Slice(registry.packs, func(i, j int) bool {
		return registry.packs[i].Name < registry.packs[j].Name
	})
	return registry, nil
}

func (registry *Registry) Packs() []protocol.WorkloadPackMetadata {
	packs := make([]protocol.WorkloadPackMetadata, 0, len(registry.packs))
	for _, pack := range registry.packs {
		packs = append(packs, clonePackMetadata(pack))
	}
	return packs
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

func validateWorkloadPack(pack WorkloadPack) error {
	if strings.TrimSpace(pack.Metadata.Name) == "" {
		return fmt.Errorf("workload pack name is required")
	}
	if strings.TrimSpace(pack.Metadata.Version) == "" {
		return fmt.Errorf("workload pack %s version is required", pack.Metadata.Name)
	}
	if strings.TrimSpace(pack.Metadata.Workload) == "" {
		return fmt.Errorf("workload pack %s workload is required", pack.Metadata.Name)
	}
	if !pack.Metadata.ReadOnly {
		return fmt.Errorf("workload pack %s must be read-only", pack.Metadata.Name)
	}
	if len(pack.Metadata.Capabilities) == 0 {
		return fmt.Errorf("workload pack %s must declare capabilities", pack.Metadata.Name)
	}

	for _, capability := range pack.Metadata.Capabilities {
		if capability.Name == "" {
			return fmt.Errorf("workload pack %s has an empty capability", pack.Metadata.Name)
		}
		if strings.TrimSpace(capability.Description) == "" {
			return fmt.Errorf("capability %s description is required", capability.Name)
		}
		if !capability.ReadOnly {
			return fmt.Errorf("capability %s must be read-only", capability.Name)
		}
		if _, ok := pack.Handlers[capability.Name]; !ok {
			return fmt.Errorf("capability %s has no handler", capability.Name)
		}
	}

	for capability := range pack.Handlers {
		found := false
		for _, declared := range pack.Metadata.Capabilities {
			if declared.Name == capability {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("handler %s is not declared by workload pack %s", capability, pack.Metadata.Name)
		}
	}
	return nil
}

func clonePackMetadata(pack protocol.WorkloadPackMetadata) protocol.WorkloadPackMetadata {
	clone := pack
	clone.Capabilities = append([]protocol.CapabilityMetadata(nil), pack.Capabilities...)
	for index := range clone.Capabilities {
		clone.Capabilities[index].RequiredTools = append(
			[]string(nil),
			pack.Capabilities[index].RequiredTools...,
		)
	}
	return clone
}

func builtinWorkloadPacks() []WorkloadPack {
	return []WorkloadPack{
		{
			Metadata: protocol.WorkloadPackMetadata{
				Name:     "host",
				Version:  "1.0.0",
				Workload: "host",
				ReadOnly: true,
				Capabilities: []protocol.CapabilityMetadata{
					{Name: protocol.CapabilityWorkloadDiscover, Description: "Discover host workload visibility and local read-only tools", ReadOnly: true},
					{Name: protocol.CapabilitySystemInfo, Description: "Collect host operating system and runtime metadata", ReadOnly: true},
					{Name: protocol.CapabilityProcessList, Description: "Collect a bounded process listing", ReadOnly: true, RequiredTools: []string{"ps"}},
					{Name: protocol.CapabilityDiskUsage, Description: "Collect bounded filesystem usage information", ReadOnly: true, RequiredTools: []string{"df"}},
					{Name: protocol.CapabilityNetworkConnections, Description: "Collect bounded established network connections", ReadOnly: true, RequiredTools: []string{"lsof", "netstat"}},
					{Name: protocol.CapabilityLogsSearch, Description: "Search explicitly provided log paths with redaction", ReadOnly: true},
				},
			},
			Handlers: map[protocol.Capability]Handler{
				protocol.CapabilityWorkloadDiscover:   workloadDiscover,
				protocol.CapabilitySystemInfo:         systemInfo,
				protocol.CapabilityProcessList:        processList,
				protocol.CapabilityDiskUsage:          diskUsage,
				protocol.CapabilityNetworkConnections: networkConnections,
				protocol.CapabilityLogsSearch:         logsSearch,
			},
		},
		{
			Metadata: protocol.WorkloadPackMetadata{
				Name:     "cloud-metadata",
				Version:  "1.0.0",
				Workload: "cloud",
				ReadOnly: true,
				Capabilities: []protocol.CapabilityMetadata{{
					Name: protocol.CapabilityCloudMetadata, Description: "Probe read-only instance metadata for supported cloud providers", ReadOnly: true,
				}},
			},
			Handlers: map[protocol.Capability]Handler{
				protocol.CapabilityCloudMetadata: cloudMetadata,
			},
		},
		{
			Metadata: protocol.WorkloadPackMetadata{
				Name:     "docker",
				Version:  "1.0.0",
				Workload: "docker",
				ReadOnly: true,
				Capabilities: []protocol.CapabilityMetadata{{
					Name: protocol.CapabilityDockerContainers, Description: "Collect bounded Docker container metadata", ReadOnly: true, RequiredTools: []string{"docker"},
				}},
			},
			Handlers: map[protocol.Capability]Handler{
				protocol.CapabilityDockerContainers: dockerContainers,
			},
		},
		{
			Metadata: protocol.WorkloadPackMetadata{
				Name:     "kubernetes",
				Version:  "1.0.0",
				Workload: "kubernetes",
				ReadOnly: true,
				Capabilities: []protocol.CapabilityMetadata{{
					Name: protocol.CapabilityKubernetesResources, Description: "Collect bounded Kubernetes resources and events", ReadOnly: true, RequiredTools: []string{"kubectl"},
				}},
			},
			Handlers: map[protocol.Capability]Handler{
				protocol.CapabilityKubernetesResources: kubernetesResources,
			},
		},
	}
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
