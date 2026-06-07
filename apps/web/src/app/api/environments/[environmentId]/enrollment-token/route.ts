import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createEnrollmentToken } from "@/lib/enrollment-token";
import { requireOperator } from "@/lib/operator-auth";

const createTokenSchema = z.object({
  ttlMinutes: z.number().int().positive().max(24 * 60).default(60)
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ environmentId: string }> }
) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  const { environmentId } = await context.params;
  const body = createTokenSchema.parse(await request.json().catch(() => ({})));
  const token = createEnrollmentToken(environmentId, body.ttlMinutes);

  return NextResponse.json({
    token,
    environmentId,
    expiresAt: new Date(Date.now() + body.ttlMinutes * 60_000).toISOString()
  });
}
