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
  const parsed = createTokenSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid enrollment token request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      },
      { status: 400 }
    );
  }

  const body = parsed.data;
  const token = createEnrollmentToken(environmentId, body.ttlMinutes);

  return NextResponse.json({
    token,
    environmentId,
    expiresAt: new Date(Date.now() + body.ttlMinutes * 60_000).toISOString()
  });
}
