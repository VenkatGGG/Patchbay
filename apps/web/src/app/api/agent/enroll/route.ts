import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAgentTokenEnvelope } from "@/lib/agent-auth";
import { domainErrorResponse, parseJsonBody } from "@/lib/api-validation";
import {
  enrollmentTokenFromAuthorization,
  verifyEnrollmentToken
} from "@/lib/enrollment-token";
import {
  createAgentAuthKey,
  TailscaleIntegrationError,
  type TailscaleAuthKey
} from "@/lib/tailscale";
import { store } from "@/lib/store";
import { READ_ONLY_CAPABILITIES } from "@/lib/types";

const enrollSchema = z.object({
  environmentId: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  capabilities: z.array(z.enum(READ_ONLY_CAPABILITIES)).min(1),
  tailscale: z
    .object({
      enabled: z.boolean().optional(),
      tailnet: z.string().optional(),
      nodeId: z.string().optional(),
      hostname: z.string().optional(),
      tags: z.array(z.string()).optional()
    })
    .optional()
});

export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody(request, enrollSchema, "Invalid enrollment request");
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  const verification = verifyEnrollmentToken(
    enrollmentTokenFromAuthorization(request.headers.get("authorization")),
    body.environmentId
  );

  if (!verification.ok) {
    return NextResponse.json(
      { error: verification.reason ?? "Enrollment token rejected" },
      { status: 401 }
    );
  }

  const state = await store.snapshot();
  if (!state.environments.some((environment) => environment.id === body.environmentId)) {
    return NextResponse.json(
      { error: `Unknown environment: ${body.environmentId}` },
      { status: 404 }
    );
  }

  let authKey: TailscaleAuthKey;
  try {
    authKey = await createAgentAuthKey(body.environmentId);
  } catch (error) {
    if (error instanceof TailscaleIntegrationError) {
      return NextResponse.json(
        {
          error: "Tailscale enrollment failed",
          detail: error.message
        },
        { status: 502 }
      );
    }
    throw error;
  }

  let agent;
  try {
    agent = await store.enrollAgent({
      ...body,
      tailscale: {
        ...body.tailscale,
        enabled: body.tailscale?.enabled ?? authKey.available,
        tags: body.tailscale?.tags ?? authKey.tags,
        authKeyPreview: authKey.preview
      }
    });
  } catch (error) {
    const response = domainErrorResponse(error);
    if (response) return response;
    throw error;
  }
  const agentToken = createAgentTokenEnvelope(agent.id, agent.environmentId);

  return NextResponse.json(
    {
      agent,
      ...agentToken,
      tailscale: {
        available: authKey.available,
        authKeyId: authKey.id,
        authKey: authKey.key,
        authKeyPreview: authKey.preview,
        tags: authKey.tags,
        expiresAt: authKey.expiresAt
      }
    },
    { status: 201 }
  );
}
