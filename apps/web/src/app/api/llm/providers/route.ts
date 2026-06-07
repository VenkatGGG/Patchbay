import { NextResponse } from "next/server";
import { listLLMProviders } from "@/lib/llm";

export async function GET() {
  return NextResponse.json(listLLMProviders());
}

