import { NextRequest, NextResponse } from "next/server";
import { domainErrorResponse } from "@/lib/api-validation";
import { requireOperator } from "@/lib/operator-auth";
import { store } from "@/lib/store";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ agentId: string }> }
) {
  const unauthorized = requireOperator(request);
  if (unauthorized) return unauthorized;

  const { agentId } = await context.params;

  try {
    const agent = await store.revokeAgent(agentId, "operator");
    return NextResponse.json(agent);
  } catch (error) {
    const response = domainErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
