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

func TestCloudMetadataCapabilityUsesSafeLoopbackOverride(t *testing.T) {
	t.Setenv(metadataBaseURLOverrideEnv, "true")
	requests := make([]string, 0)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests = append(requests, request.Method+" "+request.URL.Path)
		switch request.URL.Path {
		case "/latest/api/token", "/latest/dynamic/instance-identity/document":
			http.NotFound(response, request)
		case "/computeMetadata/v1/project/project-id":
			if request.Header.Get("Metadata-Flavor") != "Google" {
				http.Error(response, "expected GCP metadata header", http.StatusUnauthorized)
				return
			}
			_, _ = response.Write([]byte("PROJECT_" + "SEC" + "RET=should_not_leak"))
		case "/computeMetadata/v1/instance/id":
			_, _ = response.Write([]byte("987654321"))
		case "/computeMetadata/v1/instance/name":
			_, _ = response.Write([]byte("postgres://user:pass@db.internal/app"))
		case "/computeMetadata/v1/instance/zone":
			_, _ = response.Write([]byte("projects/123/zones/us-central1-a"))
		case "/computeMetadata/v1/instance/machine-type":
			_, _ = response.Write([]byte("projects/123/machineTypes/e2-medium"))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	registry := NewRegistry()
	result, err := registry.Execute(context.Background(), protocol.CapabilityCloudMetadata, map[string]any{
		"baseUrl":   server.URL,
		"timeoutMs": 5,
	})
	if err != nil {
		t.Fatalf("cloud metadata capability failed: %v", err)
	}

	payload, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type: %T", result)
	}
	if payload["available"] != true || payload["provider"] != "gcp" {
		t.Fatalf("expected gcp metadata match, got %v", payload)
	}
	if payload["timeoutMs"] != 100 {
		t.Fatalf("expected timeout to be clamped to 100ms, got %v", payload["timeoutMs"])
	}

	metadata, ok := payload["metadata"].(map[string]string)
	if !ok {
		t.Fatalf("unexpected metadata type: %T", payload["metadata"])
	}
	for _, leaked := range []string{"should_not_leak", "user:pass"} {
		if strings.Contains(metadata["projectId"], leaked) || strings.Contains(metadata["instanceName"], leaked) {
			t.Fatalf("metadata leaked %q: %v", leaked, metadata)
		}
	}
	if !strings.Contains(metadata["projectId"], "[REDACTED_SECRET]") {
		t.Fatalf("expected project id secret marker, got %q", metadata["projectId"])
	}
	if !strings.Contains(metadata["instanceName"], "[REDACTED_CREDENTIALS]") {
		t.Fatalf("expected instance name credential marker, got %q", metadata["instanceName"])
	}
	if !strings.Contains(strings.Join(requests, ","), "GET /computeMetadata/v1/project/project-id") {
		t.Fatalf("expected fake GCP metadata server to be probed, got %v", requests)
	}
}

func TestMetadataBaseURLOverrideRequiresOptInAndLoopback(t *testing.T) {
	overrideURL := "http://127.0.0.1:12345"
	if got := metadataBaseURLForParams(map[string]any{metadataBaseURLOverrideParam: overrideURL}); got != metadataBaseURL {
		t.Fatalf("expected override without opt-in to be ignored, got %q", got)
	}

	t.Setenv(metadataBaseURLOverrideEnv, "true")
	for _, blocked := range []string{
		"http://metadata.example.com",
		"http://user:pass@127.0.0.1:12345",
		"http://127.0.0.1:12345/path",
		"file:///tmp/metadata",
	} {
		if got := metadataBaseURLForParams(map[string]any{metadataBaseURLOverrideParam: blocked}); got != metadataBaseURL {
			t.Fatalf("expected unsafe override %q to be ignored, got %q", blocked, got)
		}
	}

	if got := metadataBaseURLForParams(map[string]any{metadataBaseURLOverrideParam: overrideURL + "/"}); got != overrideURL {
		t.Fatalf("expected loopback override to be accepted, got %q", got)
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
