import { NextResponse } from "next/server";
import { agentAuthStatus } from "@/lib/agent-auth";
import { listLLMProviders } from "@/lib/llm";
import { operatorAuthStatus } from "@/lib/operator-auth";
import { getStoreRuntime, store } from "@/lib/store";

export async function GET() {
  try {
    const state = await store.snapshot();

    return NextResponse.json(
      {
        status: "ready",
        service: "patchbay",
        timestamp: new Date().toISOString(),
        agentAuth: agentAuthStatus(),
        operatorAuth: operatorAuthStatus(),
        runtime: getStoreRuntime(),
        counts: {
          environments: state.environments.length,
          agents: state.agents.length,
          sessions: state.sessions.length,
          tasks: state.tasks.length,
          auditEvents: state.audit.length
        },
        llmProviders: listLLMProviders()
      },
      {
        headers: {
          "cache-control": "no-store"
        }
      }
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: "not_ready",
        service: "patchbay",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown readiness failure"
      },
      { status: 503 }
    );
  }
}
