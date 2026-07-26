import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "@/lib/api-validation";
import { authConfigurationFailure } from "@/lib/auth-configuration";
import {
  assertEnrollmentAuthConfigured,
  createEnrollmentTokenEnvelope,
  enrollmentTokenMintingStatus
} from "@/lib/enrollment-token";
import { hashEnrollmentTokenId } from "@/lib/enrollment-token";
import { requireOperator } from "@/lib/operator-auth";
import { store } from "@/lib/store";

const createTokenSchema = z.object({
  ttlMinutes: z.number().int().positive().max(24 * 60).default(60)
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ environmentId: string }> }
) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  const minting = enrollmentTokenMintingStatus();
  if (!minting.required && !minting.available) {
    return NextResponse.json(
      {
        error: "Enrollment authentication is disabled",
        code: "ENROLLMENT_AUTH_DISABLED"
      },
      { status: 409 }
    );
  }

  try {
    assertEnrollmentAuthConfigured();
  } catch (error) {
    const failure = authConfigurationFailure(error);
    if (failure) {
      return NextResponse.json(failure.body, { status: failure.status });
    }
    throw error;
  }

  const { environmentId } = await context.params;
  const state = await store.snapshot();
  if (!state.environments.some((environment) => environment.id === environmentId)) {
    return NextResponse.json(
      { error: `Unknown environment: ${environmentId}` },
      { status: 404 }
    );
  }

  const parsed = await parseJsonBody(
    request,
    createTokenSchema,
    "Invalid enrollment token request"
  );
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  let envelope;
  try {
    envelope = createEnrollmentTokenEnvelope(environmentId, body.ttlMinutes);
  } catch (error) {
    const failure = authConfigurationFailure(error);
    if (failure) {
      return NextResponse.json(failure.body, { status: failure.status });
    }
    throw error;
  }

  await store.createEnrollmentInvitation({
    tokenHash: hashEnrollmentTokenId(envelope.payload.jti),
    environmentId,
    expiresAt: envelope.payload.expiresAt,
    createdBy: "operator"
  });

  return NextResponse.json({
    token: envelope.token,
    environmentId,
    expiresAt: envelope.payload.expiresAt
  });
}
