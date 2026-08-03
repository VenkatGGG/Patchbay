import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "@/lib/api-validation";
import { buildOfflineInvestigationPlan } from "@/lib/investigation-plan";
import { requireOperator } from "@/lib/operator-auth";
import { store } from "@/lib/store";
import { READ_ONLY_CAPABILITIES } from "@/lib/types";

const investigationSchema = z.object({
  objective: z.string().trim().min(1).max(2_000),
  capabilities: z.array(z.enum(READ_ONLY_CAPABILITIES)).min(1).optional()
});

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  const { sessionId } = await context.params;
  const state = await store.snapshot();
  if (!state.sessions.some((session) => session.id === sessionId)) {
    return NextResponse.json({ error: `Unknown session: ${sessionId}` }, { status: 404 });
  }

  const investigations = state.investigations.filter(
    (investigation) => investigation.sessionId === sessionId
  );
  return NextResponse.json({
    investigations,
    nodes: state.investigationNodes.filter((node) =>
      investigations.some((investigation) => investigation.id === node.investigationId)
    )
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  const parsed = await parseJsonBody(
    request,
    investigationSchema,
    "Invalid investigation request"
  );
  if (!parsed.ok) return parsed.response;

  const { sessionId } = await context.params;
  const plan = buildOfflineInvestigationPlan(parsed.data);
  try {
    return NextResponse.json(
      await store.createInvestigation({ sessionId, plan }),
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown session:")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof Error && error.message === "Session is not active") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
