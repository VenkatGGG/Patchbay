import { NextResponse } from "next/server";
import { synthesizeSession } from "@/lib/llm";
import { store } from "@/lib/store";

export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await context.params;
  const session = store.getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const result = await synthesizeSession(session, store.snapshot());
  const synthesis = store.addSynthesis(sessionId, result.provider, result.summary);
  return NextResponse.json(synthesis, { status: 201 });
}

