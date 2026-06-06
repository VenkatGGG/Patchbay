import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";

export async function GET(request: NextRequest) {
  const agentId = request.nextUrl.searchParams.get("agentId");
  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  const tasks = store.claimTasks(agentId);
  return NextResponse.json(tasks);
}

