import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAgentAuthKey } from "@/lib/tailscale";
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
  const body = enrollSchema.parse(await request.json());
  const authKey = await createAgentAuthKey(body.environmentId);
  const agent = await store.enrollAgent({
    ...body,
    tailscale: {
      ...body.tailscale,
      enabled: body.tailscale?.enabled ?? authKey.available,
      tags: body.tailscale?.tags ?? authKey.tags,
      authKeyPreview: authKey.preview
    }
  });

  return NextResponse.json(
    {
      agent,
      tailscale: {
        available: authKey.available,
        authKey: authKey.key,
        authKeyPreview: authKey.preview,
        tags: authKey.tags,
        expiresAt: authKey.expiresAt
      }
    },
    { status: 201 }
  );
}
