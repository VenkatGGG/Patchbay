package tailscale

import (
	"context"
	"encoding/json"
	"os/exec"
	"time"

	"github.com/VenkatGGG/Patchbay/agent/internal/protocol"
)

type statusPayload struct {
	Self struct {
		ID       string   `json:"ID"`
		HostName string   `json:"HostName"`
		DNSName  string   `json:"DNSName"`
		Tags     []string `json:"Tags"`
	} `json:"Self"`
}

func Detect(ctx context.Context) protocol.TailscaleState {
	state := protocol.TailscaleState{
		Enabled: false,
		Tags:    []string{"tag:patchbay-agent"},
	}

	if _, err := exec.LookPath("tailscale"); err != nil {
		return state
	}

	statusCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	output, err := exec.CommandContext(statusCtx, "tailscale", "status", "--json").Output()
	if err != nil {
		return state
	}

	var payload statusPayload
	if err := json.Unmarshal(output, &payload); err != nil {
		return state
	}

	state.Enabled = true
	state.NodeID = payload.Self.ID
	state.Hostname = payload.Self.HostName
	state.Tailnet = payload.Self.DNSName
	if len(payload.Self.Tags) > 0 {
		state.Tags = payload.Self.Tags
	}
	return state
}
