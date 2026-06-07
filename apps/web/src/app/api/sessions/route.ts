import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperator } from "@/lib/operator-auth";
import { store } from "@/lib/store";

const createSessionSchema = z.object({
  environmentId: z.string().min(1),
  name: z.string().min(1),
  requestedBy: z.string().min(1).default("local-oncall"),
  ttlMinutes: z.number().int().positive().max(240).default(30)
});

export async function GET(request: NextRequest) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  return NextResponse.json((await store.snapshot()).sessions);
}

export async function POST(request: NextRequest) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  const body = createSessionSchema.parse(await request.json());
  const session = await store.createSession(body);
  return NextResponse.json(session, { status: 201 });
}
