import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";

const diagnosticSchema = z.object({
  scenario: z.enum(["latency_spike"]).default("latency_spike")
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  await diagnosticSchema.parseAsync(await request.json().catch(() => ({})));
  const { sessionId } = await context.params;
  const tasks = await store.createLatencyDiagnostic(sessionId);
  return NextResponse.json(tasks, { status: 201 });
}
