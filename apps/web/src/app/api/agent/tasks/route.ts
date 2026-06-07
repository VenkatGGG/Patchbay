import { NextRequest, NextResponse } from "next/server";
import { verifyAgentAuthorization } from "@/lib/agent-auth";
import { store } from "@/lib/store";

export async function GET(request: NextRequest) {
  const agentId = request.nextUrl.searchParams.get("agentId");
  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  const agentAuth = verifyAgentAuthorization(
    request.headers.get("authorization"),
    agentId
  );
  if (!agentAuth.ok) {
    return NextResponse.json({ error: agentAuth.reason }, { status: 401 });
  }

  const tasks = await store.claimTasks(agentId);
  return NextResponse.json(tasks);
}
