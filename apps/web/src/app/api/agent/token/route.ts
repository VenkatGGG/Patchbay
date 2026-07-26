import { NextRequest, NextResponse } from "next/server";
import {
  assertAgentAuthConfigured,
  createAgentTokenEnvelope,
  isAgentTokenRequired,
  verifyAgentAuthorization
} from "@/lib/agent-auth";
import { authConfigurationFailure } from "@/lib/auth-configuration";
import { store } from "@/lib/store";

export async function POST(request: NextRequest) {
  if (!isAgentTokenRequired()) {
    return NextResponse.json({
      authRequired: false
    });
  }

  let agentAuth;
  try {
    assertAgentAuthConfigured();
    agentAuth = verifyAgentAuthorization(
      request.headers.get("authorization"),
      undefined,
      { requireToken: true }
    );
  } catch (error) {
    const failure = authConfigurationFailure(error);
    if (failure) {
      return NextResponse.json(failure.body, { status: failure.status });
    }
    throw error;
  }
  if (!agentAuth.ok) {
    return NextResponse.json({ error: agentAuth.reason }, { status: 401 });
  }

  const state = await store.snapshot();
  const agent = state.agents.find((candidate) => candidate.id === agentAuth.agentId);
  if (!agent || agent.environmentId !== agentAuth.environmentId) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  if (
    agent.status === "offline" ||
    agent.credentialGeneration !== agentAuth.credentialGeneration
  ) {
    return NextResponse.json({ error: "Agent token revoked" }, { status: 401 });
  }

  return NextResponse.json({
    agentId: agent.id,
    environmentId: agent.environmentId,
    ...createAgentTokenEnvelope(
      agent.id,
      agent.environmentId,
      agent.credentialGeneration
    )
  });
}
