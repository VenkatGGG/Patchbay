import { NextRequest, NextResponse } from "next/server";
import { domainErrorResponse } from "@/lib/api-validation";
import { requireOperator } from "@/lib/operator-auth";
import { store } from "@/lib/store";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  const { sessionId } = await context.params;
  try {
    const session = await store.closeSession(sessionId);
    return NextResponse.json(session);
  } catch (error) {
    const response = domainErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
