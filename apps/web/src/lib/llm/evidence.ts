import { ControlPlaneState } from "../types";
import { EvidencePayload } from "./types";

export function buildEvidencePayload(
  sessionId: string,
  state: ControlPlaneState
): EvidencePayload {
  const tasks = state.tasks.filter((task) => task.sessionId === sessionId);
  const events = state.events.filter((event) => event.sessionId === sessionId);
  const agents = state.agents.filter((agent) =>
    tasks.some((task) => task.agentId === agent.id)
  );

  const capabilities = [...new Set(tasks.map((task) => task.capability))].sort();

  return {
    summary: {
      agentCount: agents.length,
      taskCount: tasks.length,
      completedTaskCount: tasks.filter((task) => task.status === "completed").length,
      failedTaskCount: tasks.filter((task) => task.status === "failed").length,
      eventCount: events.length,
      capabilities
    },
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      environmentId: agent.environmentId,
      status: agent.status,
      capabilities: agent.capabilities,
      tailscaleEnabled: agent.tailscale.enabled
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      agentId: task.agentId,
      capability: task.capability,
      status: task.status,
      result: compact(task.result),
      error: task.error
    })),
    events: events.slice(-50).map((event) => ({
      taskId: event.taskId,
      agentId: event.agentId,
      level: event.level,
      message: event.message,
      payload: compact(event.payload)
    }))
  };
}

function compact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redact(value).slice(0, 2_000);
  }

  if (typeof value !== "object") {
    return value;
  }

  if (depth > 4) {
    return "[TRUNCATED_DEPTH]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => compact(item, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 80)
      .map(([key, item]) => [key, compact(item, depth + 1)])
  );
}

function redact(value: string) {
  return value
    .replace(
      /(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|DATABASE_URL)=\S+/gi,
      "[REDACTED_SECRET]"
    )
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED_TOKEN]")
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]"
    );
}
