import { NextRequest, NextResponse } from "next/server";
import { verifyAgentAuthorization } from "@/lib/agent-auth";
import { domainErrorResponse } from "@/lib/api-validation";
import { authConfigurationFailure } from "@/lib/auth-configuration";
import { store } from "@/lib/store";

export async function GET(request: NextRequest) {
  const agentId = request.nextUrl.searchParams.get("agentId");
  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  let agentAuth;
  try {
    agentAuth = verifyAgentAuthorization(
      request.headers.get("authorization"),
      agentId
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

  try {
    if (agentAuth.agentId) {
      const state = await store.snapshot();
      const agent = state.agents.find((candidate) => candidate.id === agentAuth.agentId);
      if (!agent) {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
      }
      if (
        agent.status === "offline" ||
        agent.credentialGeneration !== agentAuth.credentialGeneration
      ) {
        return NextResponse.json({ error: "Agent token revoked" }, { status: 401 });
      }
    }
    const tasks = await store.claimTasks(agentId);
    return NextResponse.json(tasks);
  } catch (error) {
    const response = domainErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
