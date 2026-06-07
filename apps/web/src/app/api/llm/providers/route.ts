import { NextRequest, NextResponse } from "next/server";
import { listLLMProviders } from "@/lib/llm";
import { requireOperator } from "@/lib/operator-auth";

export async function GET(request: NextRequest) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  return NextResponse.json(listLLMProviders());
}
