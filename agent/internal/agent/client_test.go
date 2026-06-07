package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/VenkatGGG/Patchbay/agent/internal/protocol"
)

func TestClientCarriesEnrollmentAndAgentTokens(t *testing.T) {
	enrollmentToken := "enrollment-token"
	firstAgentToken := "agent-token-1"
	refreshedAgentToken := "agent-token-2"
	enrollmentExpiry := time.Now().Add(2 * time.Minute).UTC().Format(time.RFC3339)
	refreshExpiry := time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339)
	calls := []string{}

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls = append(calls, request.Method+" "+request.URL.String())
		response.Header().Set("Content-Type", "application/json")

		switch request.URL.Path {
		case "/api/agent/enroll":
			if request.Method != http.MethodPost {
				t.Fatalf("expected enrollment POST, got %s", request.Method)
			}
			expectBearer(t, request, enrollmentToken)

			var body protocol.EnrollRequest
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatalf("decode enrollment request: %v", err)
			}
			if body.EnvironmentID != "env_local" || body.Name != "agent-a" || body.Version != Version {
				t.Fatalf("unexpected enrollment request: %+v", body)
			}
			if len(body.Capabilities) != 1 || body.Capabilities[0] != protocol.CapabilitySystemInfo {
				t.Fatalf("unexpected enrollment capabilities: %v", body.Capabilities)
			}

			_ = json.NewEncoder(response).Encode(protocol.EnrollResponse{
				Agent: protocol.Agent{
					ID:            "agt_1",
					EnvironmentID: "env_local",
					Name:          "agent-a",
					Version:       Version,
					Status:        "online",
					Capabilities:  []protocol.Capability{protocol.CapabilitySystemInfo},
				},
				AgentToken:          firstAgentToken,
				AgentTokenExpiresAt: enrollmentExpiry,
				Tailscale: protocol.TailscaleReply{
					Available: false,
					Tags:      []string{"tag:patchbay-agent"},
				},
			})
		case "/api/agent/tasks":
			if request.Method != http.MethodGet {
				t.Fatalf("expected task polling GET, got %s", request.Method)
			}
			expectBearer(t, request, firstAgentToken)
			if request.URL.Query().Get("agentId") != "agt_1" {
				t.Fatalf("unexpected agentId query: %s", request.URL.RawQuery)
			}
			_ = json.NewEncoder(response).Encode([]protocol.Task{
				{
					ID:         "task_1",
					SessionID:  "sess_1",
					AgentID:    "agt_1",
					Capability: protocol.CapabilitySystemInfo,
					Status:     "running",
					Params:     map[string]any{},
				},
			})
		case "/api/agent/token":
			if request.Method != http.MethodPost {
				t.Fatalf("expected token refresh POST, got %s", request.Method)
			}
			expectBearer(t, request, firstAgentToken)
			_ = json.NewEncoder(response).Encode(protocol.AgentTokenResponse{
				AgentID:             "agt_1",
				EnvironmentID:       "env_local",
				AgentToken:          refreshedAgentToken,
				AgentTokenExpiresAt: refreshExpiry,
			})
		case "/api/agent/tasks/task_1/events":
			if request.Method != http.MethodPost {
				t.Fatalf("expected event upload POST, got %s", request.Method)
			}
			expectBearer(t, request, refreshedAgentToken)

			var body protocol.TaskEvent
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatalf("decode task event: %v", err)
			}
			if body.AgentID != "agt_1" || body.Status != "completed" {
				t.Fatalf("unexpected task event: %+v", body)
			}
			response.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, enrollmentToken)
	ctx := context.Background()

	enrollment, err := client.Enroll(ctx, protocol.EnrollRequest{
		EnvironmentID: "env_local",
		Name:          "agent-a",
		Version:       Version,
		Capabilities:  []protocol.Capability{protocol.CapabilitySystemInfo},
	})
	if err != nil {
		t.Fatalf("Enroll returned error: %v", err)
	}
	if enrollment.Agent.ID != "agt_1" {
		t.Fatalf("unexpected enrollment response: %+v", enrollment)
	}

	tasks, err := client.PollTasks(ctx, enrollment.Agent.ID)
	if err != nil {
		t.Fatalf("PollTasks returned error: %v", err)
	}
	if len(tasks) != 1 || tasks[0].ID != "task_1" {
		t.Fatalf("unexpected tasks: %+v", tasks)
	}

	refreshed, err := client.RefreshAgentTokenIfNeeded(ctx, 5*time.Minute)
	if err != nil {
		t.Fatalf("RefreshAgentTokenIfNeeded returned error: %v", err)
	}
	if !refreshed {
		t.Fatal("expected expiring agent token to refresh")
	}

	if err := client.SendTaskEvent(ctx, "task_1", protocol.TaskEvent{
		AgentID: "agt_1",
		Level:   "info",
		Message: "completed",
		Status:  "completed",
		Result:  map[string]string{"ok": "true"},
	}); err != nil {
		t.Fatalf("SendTaskEvent returned error: %v", err)
	}

	expectedCalls := []string{
		"POST /api/agent/enroll",
		"GET /api/agent/tasks?agentId=agt_1",
		"POST /api/agent/token",
		"POST /api/agent/tasks/task_1/events",
	}
	if strings.Join(calls, ",") != strings.Join(expectedCalls, ",") {
		t.Fatalf("unexpected calls: %v", calls)
	}
}

func TestClientRejectsMalformedAgentTokenExpiry(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/agent/enroll" {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(protocol.EnrollResponse{
			Agent: protocol.Agent{
				ID:            "agt_bad_expiry",
				EnvironmentID: "env_local",
				Name:          "agent-b",
				Version:       Version,
				Status:        "online",
			},
			AgentToken:          "agent-token",
			AgentTokenExpiresAt: "not-a-date",
			Tailscale:           protocol.TailscaleReply{Available: false},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "enrollment-token")
	_, err := client.Enroll(context.Background(), protocol.EnrollRequest{
		EnvironmentID: "env_local",
		Name:          "agent-b",
		Version:       Version,
		Capabilities:  []protocol.Capability{protocol.CapabilitySystemInfo},
	})
	if err == nil {
		t.Fatal("expected malformed token expiry to be rejected")
	}
	if !strings.Contains(err.Error(), "parse agent token expiry") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func expectBearer(t *testing.T, request *http.Request, token string) {
	t.Helper()
	expected := "Bearer " + token
	if got := request.Header.Get("Authorization"); got != expected {
		t.Fatalf("expected Authorization %q, got %q", expected, got)
	}
}
