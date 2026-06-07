import { NextRequest, NextResponse } from "next/server";
import {
  createAgentTokenEnvelope,
  verifyAgentAuthorization
} from "@/lib/agent-auth";
import { store } from "@/lib/store";

export async function POST(request: NextRequest) {
  const agentAuth = verifyAgentAuthorization(
    request.headers.get("authorization"),
    undefined,
    { requireToken: true }
  );
  if (!agentAuth.ok) {
    return NextResponse.json({ error: agentAuth.reason }, { status: 401 });
  }

  const state = await store.snapshot();
  const agent = state.agents.find((candidate) => candidate.id === agentAuth.agentId);
  if (!agent || agent.environmentId !== agentAuth.environmentId) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({
    agentId: agent.id,
    environmentId: agent.environmentId,
    ...createAgentTokenEnvelope(agent.id, agent.environmentId)
  });
}
