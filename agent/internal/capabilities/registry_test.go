package capabilities

import (
	"context"
	"net/http"
	"net/http/httptest"
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
		protocol.CapabilityCloudMetadata,
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

func TestAWSMetadataProbe(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/latest/api/token":
			response.WriteHeader(http.StatusOK)
			_, _ = response.Write([]byte("test-token"))
		case "/latest/dynamic/instance-identity/document":
			if request.Header.Get("X-aws-ec2-metadata-token") != "test-token" {
				http.Error(response, "expected IMDSv2 token header", http.StatusUnauthorized)
				return
			}
			_, _ = response.Write([]byte(`{
				"accountId":"123456789012",
				"availabilityZone":"us-west-2a",
				"instanceId":"i-123",
				"instanceType":"t3.small",
				"region":"us-west-2"
			}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	metadata, matched, err := probeAWSMetadata(context.Background(), server.Client(), server.URL)
	if err != nil {
		t.Fatalf("aws metadata probe failed: %v", err)
	}
	if !matched {
		t.Fatal("expected aws metadata probe to match")
	}
	if metadata["instanceId"] != "i-123" || metadata["region"] != "us-west-2" {
		t.Fatalf("unexpected aws metadata: %v", metadata)
	}
}

func TestGCPMetadataProbe(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Metadata-Flavor") != "Google" {
			http.Error(response, "expected GCP metadata header", http.StatusUnauthorized)
			return
		}

		switch request.URL.Path {
		case "/computeMetadata/v1/project/project-id":
			_, _ = response.Write([]byte("patchbay-prod"))
		case "/computeMetadata/v1/instance/id":
			_, _ = response.Write([]byte("987654321"))
		case "/computeMetadata/v1/instance/name":
			_, _ = response.Write([]byte("api-worker-1"))
		case "/computeMetadata/v1/instance/zone":
			_, _ = response.Write([]byte("projects/123/zones/us-central1-a"))
		case "/computeMetadata/v1/instance/machine-type":
			_, _ = response.Write([]byte("projects/123/machineTypes/e2-medium"))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	metadata, matched, err := probeGCPMetadata(context.Background(), server.Client(), server.URL)
	if err != nil {
		t.Fatalf("gcp metadata probe failed: %v", err)
	}
	if !matched {
		t.Fatal("expected gcp metadata probe to match")
	}
	if metadata["projectId"] != "patchbay-prod" || metadata["zone"] != "us-central1-a" {
		t.Fatalf("unexpected gcp metadata: %v", metadata)
	}
}

func TestAzureMetadataProbe(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Metadata") != "true" {
			http.Error(response, "expected Azure metadata header", http.StatusUnauthorized)
			return
		}
		if request.URL.Path != "/metadata/instance/compute" {
			http.NotFound(response, request)
			return
		}

		_, _ = response.Write([]byte(`{
			"location":"westus2",
			"name":"api-worker-2",
			"osType":"Linux",
			"resourceGroupName":"patchbay-rg",
			"subscriptionId":"sub-123",
			"vmId":"vm-123",
			"vmSize":"Standard_B2s"
		}`))
	}))
	defer server.Close()

	metadata, matched, err := probeAzureMetadata(context.Background(), server.Client(), server.URL)
	if err != nil {
		t.Fatalf("azure metadata probe failed: %v", err)
	}
	if !matched {
		t.Fatal("expected azure metadata probe to match")
	}
	if metadata["vmId"] != "vm-123" || metadata["location"] != "westus2" {
		t.Fatalf("unexpected azure metadata: %v", metadata)
	}
}

func TestRedactSecrets(t *testing.T) {
	githubToken := "GITHUB_" + "TO" + "KEN=ghp_should_not_leak"
	kubernetesToken := "KUBERNETES_SERVICE_ACCOUNT_" + "TOKEN : eyJ_should_not_leak"
	databaseURL := "DATABASE_" + "URL=postgres://user:pass@localhost:5432/app"
	urlCredential := "postgres://user:pass@localhost:5432/app"
	clientSecret := `"client` + `Secret":"client_secret_should_not_leak"`
	privateKey := "-----BEGIN PRIVATE " + "KEY-----\nabc123\n-----END PRIVATE " + "KEY-----"
	output := Redact(strings.Join([]string{
		githubToken,
		kubernetesToken,
		databaseURL,
		urlCredential,
		clientSecret,
		"Bearer abc.def/ghi+value==",
		privateKey,
	}, " "))
	for _, leaked := range []string{
		"ghp_should_not_leak",
		"eyJ_should_not_leak",
		"user:pass",
		"client_secret_should_not_leak",
		"abc.def/ghi+value",
		"BEGIN PRIVATE KEY",
	} {
		if strings.Contains(output, leaked) {
			t.Fatalf("secret %q was not redacted: %s", leaked, output)
		}
	}
	for _, marker := range []string{
		"[REDACTED_SECRET]",
		"Bearer [REDACTED_TOKEN]",
		"[REDACTED_PRIVATE_KEY]",
		"[REDACTED_CREDENTIALS]",
	} {
		if !strings.Contains(output, marker) {
			t.Fatalf("expected redaction marker %q in output: %s", marker, output)
		}
	}
	expectedAssignment := "GITHUB_" + "TO" + "KEN=[REDACTED_SECRET]"
	if !strings.Contains(output, expectedAssignment) {
		t.Fatalf("expected redaction to preserve assignment key: %s", output)
	}
}
