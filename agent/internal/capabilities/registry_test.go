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

func TestRedactSecrets(t *testing.T) {
	output := Redact("GITHUB_TOKEN=ghp_secret Bearer abc.def.ghi")
	if strings.Contains(output, "ghp_secret") || strings.Contains(output, "abc.def.ghi") {
		t.Fatalf("secret was not redacted: %s", output)
	}
}
