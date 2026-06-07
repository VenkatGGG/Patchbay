import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAgentAuthorization } from "@/lib/agent-auth";
import { parseJsonBody } from "@/lib/api-validation";
import { store, TaskAssignmentError } from "@/lib/store";

const eventSchema = z.object({
  agentId: z.string().min(1),
  level: z.enum(["info", "warning", "error"]).default("info"),
  message: z.string().min(1),
  payload: z.unknown().optional(),
  status: z.enum(["queued", "running", "completed", "failed", "denied"]).optional(),
  result: z.unknown().optional(),
  error: z.string().optional()
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await context.params;
  const parsed = await parseJsonBody(request, eventSchema, "Invalid task event");
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  const agentAuth = verifyAgentAuthorization(
    request.headers.get("authorization"),
    body.agentId
  );
  if (!agentAuth.ok) {
    return NextResponse.json({ error: agentAuth.reason }, { status: 401 });
  }

  try {
    const event = await store.addTaskEvent(taskId, body);
    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    if (error instanceof TaskAssignmentError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof Error && error.message.startsWith("Unknown task:")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
