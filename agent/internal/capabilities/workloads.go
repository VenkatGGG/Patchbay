package capabilities

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

func workloadDiscover(_ context.Context, _ map[string]any) (any, error) {
	hostname, _ := os.Hostname()
	tools := map[string]bool{
		"docker":    commandExists("docker"),
		"kubectl":   commandExists("kubectl"),
		"tailscale": commandExists("tailscale"),
		"lsof":      commandExists("lsof"),
		"netstat":   commandExists("netstat"),
	}

	markers := map[string]bool{
		"container":          fileExists("/.dockerenv") || fileExists("/run/.containerenv"),
		"kubernetes_env":     os.Getenv("KUBERNETES_SERVICE_HOST") != "",
		"docker_socket":      fileExists("/var/run/docker.sock"),
		"kubeconfig_present": os.Getenv("KUBECONFIG") != "" || fileExists(os.Getenv("HOME")+"/.kube/config"),
	}

	workloads := []string{"host"}
	if tools["docker"] || markers["docker_socket"] {
		workloads = append(workloads, "docker")
	}
	if tools["kubectl"] || markers["kubernetes_env"] || markers["kubeconfig_present"] {
		workloads = append(workloads, "kubernetes")
	}

	return map[string]any{
		"hostname":  hostname,
		"os":        runtime.GOOS,
		"arch":      runtime.GOARCH,
		"workloads": workloads,
		"tools":     tools,
		"markers":   markers,
	}, nil
}

func dockerContainers(ctx context.Context, params map[string]any) (any, error) {
	limit := intParam(params, "limit", 60)
	if !commandExists("docker") {
		return map[string]any{
			"available": false,
			"notice":    "docker CLI not found",
		}, nil
	}

	output, err := runOptionalReadOnlyCommand(ctx, "docker", "ps", "--all", "--no-trunc", "--format", "{{json .}}")
	if err != nil {
		return map[string]any{
			"available": false,
			"notice":    "docker command could not read containers",
			"error":     err.Error(),
			"output":    linesPayload(output, limit),
		}, nil
	}

	return map[string]any{
		"available":  true,
		"containers": linesPayload(output, limit),
	}, nil
}

func kubernetesResources(ctx context.Context, params map[string]any) (any, error) {
	limit := intParam(params, "limit", 80)
	if !commandExists("kubectl") {
		return map[string]any{
			"available": false,
			"notice":    "kubectl not found",
		}, nil
	}

	sections := map[string]any{}
	commands := map[string][]string{
		"pods":        {"get", "pods", "-A", "-o", "wide", "--request-timeout=5s"},
		"deployments": {"get", "deployments", "-A", "-o", "wide", "--request-timeout=5s"},
		"events":      {"get", "events", "-A", "--sort-by=.lastTimestamp", "--request-timeout=5s"},
		"nodes":       {"get", "nodes", "-o", "wide", "--request-timeout=5s"},
	}

	available := false
	for name, args := range commands {
		output, err := runOptionalReadOnlyCommand(ctx, "kubectl", args...)
		if err != nil {
			sections[name] = map[string]any{
				"error":  err.Error(),
				"output": linesPayload(output, limit),
			}
			continue
		}

		available = true
		sections[name] = linesPayload(output, limit)
	}

	if !available {
		return map[string]any{
			"available": false,
			"notice":    "kubectl is installed but no readable Kubernetes resources were available",
			"sections":  sections,
		}, nil
	}

	return map[string]any{
		"available": true,
		"sections":  sections,
	}, nil
}

func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func fileExists(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}

	_, err := os.Stat(path)
	return err == nil
}

func runOptionalReadOnlyCommand(ctx context.Context, name string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, name, args...)
	output, err := command.CombinedOutput()
	redacted := Redact(string(output))
	if err != nil {
		return redacted, fmt.Errorf("%s failed: %w", name, err)
	}
	return redacted, nil
}
