import { NextResponse } from "next/server";
import { agentAuthStatus } from "@/lib/agent-auth";
import { apiValidationStatus } from "@/lib/api-validation";
import { enrollmentAuthStatus } from "@/lib/enrollment-token";
import { listLLMProviders } from "@/lib/llm";
import { operatorAuthStatus } from "@/lib/operator-auth";
import { buildReadinessPosture } from "@/lib/readiness";
import { getStoreRuntime, store } from "@/lib/store";
import { tailscaleRuntimeStatus } from "@/lib/tailscale";

export async function GET() {
  try {
    const state = await store.snapshot();
    const agentAuth = agentAuthStatus();
    const apiValidation = apiValidationStatus();
    const enrollmentAuth = enrollmentAuthStatus();
    const llmProviders = listLLMProviders();
    const operatorAuth = operatorAuthStatus();
    const runtime = getStoreRuntime();
    const tailscale = tailscaleRuntimeStatus();
    const posture = buildReadinessPosture({
      agentAuth,
      apiValidation,
      enrollmentAuth,
      llmProviders,
      operatorAuth,
      runtime,
      tailscale
    });

    return NextResponse.json(
      {
        status: "ready",
        service: "patchbay",
        timestamp: new Date().toISOString(),
        agentAuth,
        apiValidation,
        enrollmentAuth,
        operatorAuth,
        runtime,
        tailscale,
        posture,
        counts: {
          environments: state.environments.length,
          agents: state.agents.length,
          sessions: state.sessions.length,
          tasks: state.tasks.length,
          auditEvents: state.audit.length
        },
        llmProviders
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
