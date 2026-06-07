import { NextRequest, NextResponse } from "next/server";
import { synthesizeSession } from "@/lib/llm";
import { requireOperator } from "@/lib/operator-auth";
import { store } from "@/lib/store";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  const { sessionId } = await context.params;
  const session = await store.getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const result = await synthesizeSession(session, await store.snapshot());
  const synthesis = await store.addSynthesis(sessionId, result.provider, result.summary);
  return NextResponse.json(synthesis, { status: 201 });
}
