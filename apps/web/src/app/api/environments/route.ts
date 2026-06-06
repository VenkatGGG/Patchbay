import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";

const createEnvironmentSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(["any", "aws", "gcp", "kubernetes", "vm", "docker"]).default("any")
});

export async function GET() {
  return NextResponse.json(store.snapshot().environments);
}

export async function POST(request: NextRequest) {
  const body = createEnvironmentSchema.parse(await request.json());
  const environment = store.createEnvironment(body.name, body.provider);
  return NextResponse.json(environment, { status: 201 });
}

