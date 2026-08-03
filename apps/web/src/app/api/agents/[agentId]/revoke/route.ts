import { NextRequest, NextResponse } from "next/server";
import { domainErrorResponse } from "@/lib/api-validation";
import { requireOperator } from "@/lib/operator-auth";
import { store } from "@/lib/store";
import {
  revokeAgentAuthKey,
  TailscaleIntegrationError
} from "@/lib/tailscale";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ agentId: string }> }
) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  const { agentId } = await context.params;

  try {
    const state = await store.snapshot();
    const existingAgent = state.agents.find((agent) => agent.id === agentId);
    const agent = await store.revokeAgent(agentId, "operator");
    let tailscaleLifecycle;
    try {
      tailscaleLifecycle = await revokeAgentAuthKey(
        existingAgent?.tailscale.authKeyId
      );
      await store.recordAudit("agent.tailscale.revoked", "operator", agent.id, {
        status: tailscaleLifecycle.status,
        attempted: tailscaleLifecycle.attempted
      });
    } catch (error) {
      const detail =
        error instanceof TailscaleIntegrationError
          ? error.message
          : "Tailscale auth key revocation failed";
      tailscaleLifecycle = { attempted: true, status: "failed", detail };
      await store.recordAudit("agent.tailscale.revoke.failed", "operator", agent.id, {
        detail
      });
    }
    return NextResponse.json({ ...agent, tailscaleLifecycle });
  } catch (error) {
    const response = domainErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
