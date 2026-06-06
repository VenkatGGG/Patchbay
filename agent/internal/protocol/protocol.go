package protocol

type Capability string

const (
	CapabilitySystemInfo         Capability = "system.info"
	CapabilityProcessList        Capability = "process.list"
	CapabilityDiskUsage          Capability = "disk.usage"
	CapabilityNetworkConnections Capability = "network.connections"
	CapabilityLogsSearch         Capability = "logs.search"
)

type TailscaleState struct {
	Enabled        bool     `json:"enabled"`
	Tailnet        string   `json:"tailnet,omitempty"`
	NodeID         string   `json:"nodeId,omitempty"`
	Hostname       string   `json:"hostname,omitempty"`
	Tags           []string `json:"tags"`
	AuthKeyPreview string   `json:"authKeyPreview,omitempty"`
}

type EnrollRequest struct {
	EnvironmentID string          `json:"environmentId"`
	Name          string          `json:"name"`
	Version       string          `json:"version"`
	Capabilities  []Capability    `json:"capabilities"`
	Tailscale     *TailscaleState `json:"tailscale,omitempty"`
}

type EnrollResponse struct {
	Agent     Agent          `json:"agent"`
	Tailscale TailscaleReply `json:"tailscale"`
}

type TailscaleReply struct {
	Available      bool     `json:"available"`
	AuthKey        string   `json:"authKey,omitempty"`
	AuthKeyPreview string   `json:"authKeyPreview"`
	Tags           []string `json:"tags"`
	ExpiresAt      string   `json:"expiresAt,omitempty"`
}

type Agent struct {
	ID            string         `json:"id"`
	EnvironmentID string         `json:"environmentId"`
	Name          string         `json:"name"`
	Version       string         `json:"version"`
	Status        string         `json:"status"`
	Capabilities  []Capability   `json:"capabilities"`
	Tailscale     TailscaleState `json:"tailscale"`
	LastSeenAt    string         `json:"lastSeenAt"`
	CreatedAt     string         `json:"createdAt"`
}

type Task struct {
	ID         string         `json:"id"`
	SessionID  string         `json:"sessionId"`
	AgentID    string         `json:"agentId"`
	Capability Capability     `json:"capability"`
	Params     map[string]any `json:"params"`
	Status     string         `json:"status"`
	CreatedAt  string         `json:"createdAt"`
}

type TaskEvent struct {
	AgentID string `json:"agentId"`
	Level   string `json:"level"`
	Message string `json:"message"`
	Payload any    `json:"payload,omitempty"`
	Status  string `json:"status,omitempty"`
	Result  any    `json:"result,omitempty"`
	Error   string `json:"error,omitempty"`
}
