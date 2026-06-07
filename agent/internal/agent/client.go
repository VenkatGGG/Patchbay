package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/VenkatGGG/Patchbay/agent/internal/protocol"
)

type Client struct {
	baseURL         string
	enrollmentToken string
	agentToken      string
	httpClient      *http.Client
}

func NewClient(baseURL string, enrollmentToken string) *Client {
	return &Client{
		baseURL:         baseURL,
		enrollmentToken: enrollmentToken,
		httpClient: &http.Client{
			Timeout: 20 * time.Second,
		},
	}
}

func (client *Client) Enroll(ctx context.Context, request protocol.EnrollRequest) (protocol.EnrollResponse, error) {
	var response protocol.EnrollResponse
	if err := client.post(ctx, "/api/agent/enroll", request, &response, client.enrollmentToken); err != nil {
		return protocol.EnrollResponse{}, err
	}
	client.agentToken = response.AgentToken
	return response, nil
}

func (client *Client) PollTasks(ctx context.Context, agentID string) ([]protocol.Task, error) {
	endpoint := fmt.Sprintf("/api/agent/tasks?agentId=%s", url.QueryEscape(agentID))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, client.baseURL+endpoint, nil)
	if err != nil {
		return nil, err
	}
	authorize(request, client.agentToken)

	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode >= 300 {
		return nil, fmt.Errorf("poll tasks failed: %s", response.Status)
	}

	var tasks []protocol.Task
	if err := json.NewDecoder(response.Body).Decode(&tasks); err != nil {
		return nil, err
	}
	return tasks, nil
}

func (client *Client) SendTaskEvent(ctx context.Context, taskID string, event protocol.TaskEvent) error {
	return client.post(ctx, fmt.Sprintf("/api/agent/tasks/%s/events", taskID), event, nil, client.agentToken)
}

func (client *Client) post(ctx context.Context, path string, requestPayload any, responsePayload any, authToken string) error {
	body, err := json.Marshal(requestPayload)
	if err != nil {
		return err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	authorize(request, authToken)

	response, err := client.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	if response.StatusCode >= 300 {
		return fmt.Errorf("post %s failed: %s", path, response.Status)
	}

	if responsePayload != nil {
		if err := json.NewDecoder(response.Body).Decode(responsePayload); err != nil {
			return err
		}
	}

	return nil
}

func authorize(request *http.Request, token string) {
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
}
