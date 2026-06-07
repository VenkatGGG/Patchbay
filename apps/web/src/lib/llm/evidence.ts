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

  return {
    agents,
    tasks,
    events
  };
}

