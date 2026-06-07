package capabilities

import (
	"context"
	"strings"
	"testing"

	"github.com/VenkatGGG/Patchbay/agent/internal/protocol"
)

func TestRegistryDeniesUnknownCapability(t *testing.T) {
	registry := NewRegistry()
	_, err := registry.Execute(context.Background(), protocol.Capability("shell.exec"), nil)
	if err == nil {
		t.Fatal("expected unknown capability to be denied")
	}
}

func TestRegistryIncludesWorkloadCapabilities(t *testing.T) {
	registry := NewRegistry()
	names := registry.Names()
	required := []protocol.Capability{
		protocol.CapabilityWorkloadDiscover,
		protocol.CapabilityDockerContainers,
		protocol.CapabilityKubernetesResources,
	}

	for _, capability := range required {
		found := false
		for _, name := range names {
			if name == capability {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("expected capability %s to be registered in %v", capability, names)
		}
	}
}

func TestWorkloadDiscoverReturnsHostWorkload(t *testing.T) {
	registry := NewRegistry()
	result, err := registry.Execute(context.Background(), protocol.CapabilityWorkloadDiscover, nil)
	if err != nil {
		t.Fatalf("workload discovery failed: %v", err)
	}

	payload, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type: %T", result)
	}

	workloads, ok := payload["workloads"].([]string)
	if !ok {
		t.Fatalf("unexpected workloads type: %T", payload["workloads"])
	}

	if len(workloads) == 0 || workloads[0] != "host" {
		t.Fatalf("expected host workload, got %v", workloads)
	}
}

func TestRedactSecrets(t *testing.T) {
	output := Redact("GITHUB_TOKEN=ghp_secret Bearer abc.def.ghi")
	if strings.Contains(output, "ghp_secret") || strings.Contains(output, "abc.def.ghi") {
		t.Fatalf("secret was not redacted: %s", output)
	}
}
