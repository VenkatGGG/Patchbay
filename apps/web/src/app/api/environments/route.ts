import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperator } from "@/lib/operator-auth";
import { store } from "@/lib/store";

const createEnvironmentSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(["any", "aws", "gcp", "kubernetes", "vm", "docker"]).default("any")
});

export async function GET(request: NextRequest) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  return NextResponse.json((await store.snapshot()).environments);
}

export async function POST(request: NextRequest) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  const body = createEnvironmentSchema.parse(await request.json());
  const environment = await store.createEnvironment(body.name, body.provider);
  return NextResponse.json(environment, { status: 201 });
}
