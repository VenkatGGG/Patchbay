import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { domainErrorResponse, parseJsonBody } from "@/lib/api-validation";
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

  const parsed = await parseJsonBody(request, createSessionSchema, "Invalid session request");
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  try {
    const session = await store.createSession(body);
    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    const response = domainErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
