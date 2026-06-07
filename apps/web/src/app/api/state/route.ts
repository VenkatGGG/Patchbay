import { NextRequest, NextResponse } from "next/server";
import { requireOperator } from "@/lib/operator-auth";
import { store } from "@/lib/store";

export async function GET(request: NextRequest) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  return NextResponse.json(await store.snapshot());
}
