import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "@/lib/api-validation";
import { enforcePlanCapabilities } from "@/lib/investigation-plan";
import { planInvestigation } from "@/lib/llm";
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
  try {
    const session = await store.getSession(sessionId);
    if (!session) {
      return NextResponse.json({ error: `Unknown session: ${sessionId}` }, { status: 404 });
    }

    const state = await store.snapshot();
    const availableCapabilities = [
      ...new Set(
        state.agents
          .filter(
            (agent) =>
              agent.environmentId === session.environmentId &&
              !agent.revokedAt &&
              agent.status !== "offline"
          )
          .flatMap((agent) => agent.capabilities)
      )
    ];
    const requestedCapabilities = parsed.data.capabilities ?? session.allowedCapabilities;
    const allowedCapabilities = requestedCapabilities.filter(
      (capability) =>
        session.allowedCapabilities.includes(capability) &&
        availableCapabilities.includes(capability)
    );
    if (allowedCapabilities.length === 0) {
      return NextResponse.json(
        { error: "No requested read-only capabilities are available from enrolled agents" },
        { status: 409 }
      );
    }

    const planning = await planInvestigation({
      objective: parsed.data.objective,
      capabilities: allowedCapabilities
    });
    const plan = enforcePlanCapabilities(planning.plan, allowedCapabilities);
    const result = await store.createInvestigation({ sessionId, plan });
    const started = await store.startInvestigation(result.investigation.id);
    const stateAfterStart = await store.snapshot();
    return NextResponse.json(
      {
        investigation: started.investigation,
        nodes: stateAfterStart.investigationNodes.filter(
          (node) => node.investigationId === started.investigation.id
        ),
        tasks: started.tasks,
        planner: planning.provider
      },
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
