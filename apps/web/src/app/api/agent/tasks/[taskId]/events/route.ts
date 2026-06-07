import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";

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
  const body = eventSchema.parse(await request.json());
  const event = await store.addTaskEvent(taskId, body);
  return NextResponse.json(event, { status: 201 });
}
