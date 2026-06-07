import type { LLMProviderStatus } from "./llm";

export type ReadinessCheckStatus = "ready" | "warning" | "critical";

export type ReadinessCheck = {
  id: string;
  label: string;
  status: ReadinessCheckStatus;
  summary: string;
  detail: string;
};

export type ReadinessPosture = {
  level: "ready" | "degraded" | "blocked";
  readyCount: number;
  warningCount: number;
  criticalCount: number;
  checks: ReadinessCheck[];
};

type RuntimeStatus = {
  storage: string;
  postgresConfigured: boolean;
};

type RequiredSecretStatus = {
  required: boolean;
  secretConfigured?: boolean;
};

type TailscaleStatus = {
  configured: boolean;
  tailnetConfigured: boolean;
  oauthClientConfigured: boolean;
};

type ReadinessInput = {
  runtime: RuntimeStatus;
  operatorAuth: {
    required: boolean;
  };
  enrollmentAuth: RequiredSecretStatus;
  agentAuth: RequiredSecretStatus & {
    tokenTtlMinutes: number;
  };
  tailscale: TailscaleStatus;
  llmProviders: LLMProviderStatus[];
};

export function buildReadinessPosture(input: ReadinessInput): ReadinessPosture {
  const selectedProvider = input.llmProviders.find((provider) => provider.selected);
  const checks: ReadinessCheck[] = [
    {
      id: "storage",
      label: "Persistent Storage",
      status: input.runtime.storage === "postgres" ? "ready" : "warning",
      summary:
        input.runtime.storage === "postgres"
          ? "Postgres persistence is active"
          : "Memory storage is active",
      detail:
        input.runtime.storage === "postgres"
          ? "Sessions, tasks, events, audit records, and syntheses survive process restarts."
          : "Memory storage is acceptable for local demos only; diagnostic state resets on restart."
    },
    {
      id: "operator_auth",
      label: "Operator Auth",
      status: input.operatorAuth.required ? "ready" : "warning",
      summary: input.operatorAuth.required
        ? "Operator APIs require a bearer token"
        : "Operator APIs are locally open",
      detail: input.operatorAuth.required
        ? "Dashboard and human-operated APIs are protected by PATCHBAY_OPERATOR_TOKEN."
        : "Set PATCHBAY_OPERATOR_TOKEN before shared or production-like use."
    },
    {
      id: "enrollment_auth",
      label: "Enrollment Auth",
      status: requiredSecretStatus(input.enrollmentAuth),
      summary: input.enrollmentAuth.required
        ? "Agent enrollment requires signed tokens"
        : "Agent enrollment does not require signed tokens",
      detail: input.enrollmentAuth.required
        ? "PATCHBAY_ENROLLMENT_SECRET signs short-lived environment-scoped enrollment tokens."
        : "Set PATCHBAY_REQUIRE_ENROLLMENT_TOKEN=true and PATCHBAY_ENROLLMENT_SECRET."
    },
    {
      id: "agent_auth",
      label: "Agent API Auth",
      status: requiredSecretStatus(input.agentAuth),
      summary: input.agentAuth.required
        ? `Agent API tokens expire after ${input.agentAuth.tokenTtlMinutes} minutes`
        : "Agent task APIs accept unsigned local requests",
      detail: input.agentAuth.required
        ? "Polling, token refresh, and task event ingestion require signed agent API tokens."
        : "Set PATCHBAY_REQUIRE_AGENT_TOKEN=true and PATCHBAY_AGENT_AUTH_SECRET."
    },
    {
      id: "llm_provider",
      label: "LLM Provider",
      status: selectedProvider?.configured ? "ready" : "warning",
      summary: selectedProvider
        ? `${selectedProvider.displayName} ${
            selectedProvider.configured ? "is configured" : "will use fallback"
          }`
        : "No LLM provider selected",
      detail: selectedProvider?.configured
        ? "Synthesis can call the selected provider with redacted evidence."
        : "Set GEMINI_API_KEY when you are ready to validate live Gemini synthesis."
    },
    {
      id: "tailscale",
      label: "Tailscale Automation",
      status: input.tailscale.configured ? "ready" : "warning",
      summary: input.tailscale.configured
        ? "Tailscale OAuth credentials are configured"
        : "Tailscale automation is disabled",
      detail: input.tailscale.configured
        ? "Enrollment can mint tagged ephemeral auth keys for agents."
        : "Set TAILSCALE_TAILNET, TAILSCALE_OAUTH_CLIENT_ID, and TAILSCALE_OAUTH_CLIENT_SECRET to validate private-network bootstrap."
    }
  ];

  const criticalCount = checks.filter((check) => check.status === "critical").length;
  const warningCount = checks.filter((check) => check.status === "warning").length;
  const readyCount = checks.filter((check) => check.status === "ready").length;

  return {
    level:
      criticalCount > 0 ? "blocked" : warningCount > 0 ? "degraded" : "ready",
    readyCount,
    warningCount,
    criticalCount,
    checks
  };
}

function requiredSecretStatus(status: RequiredSecretStatus): ReadinessCheckStatus {
  if (!status.required) {
    return "warning";
  }

  return status.secretConfigured ? "ready" : "critical";
}
