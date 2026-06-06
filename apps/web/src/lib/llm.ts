import { GoogleGenAI } from "@google/genai";
import { ControlPlaneState, DebugSession } from "./types";

export type SynthesisResult = {
  provider: string;
  summary: string;
};

export async function synthesizeSession(
  session: DebugSession,
  state: ControlPlaneState
): Promise<SynthesisResult> {
  const evidence = buildEvidencePayload(session.id, state);
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  if (!apiKey) {
    return {
      provider: "gemini:offline",
      summary: fallbackSummary(session, evidence)
    };
  }

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "You are Patchbay, a read-only incident investigation assistant.",
              "Use only the evidence provided.",
              "Do not recommend privileged actions as executed actions.",
              "Return concise sections: Summary, Evidence, Likely Causes, Next Diagnostics.",
              JSON.stringify(evidence, null, 2)
            ].join("\n\n")
          }
        ]
      }
    ]
  });

  return {
    provider: `gemini:${model}`,
    summary: response.text ?? fallbackSummary(session, evidence)
  };
}

function buildEvidencePayload(sessionId: string, state: ControlPlaneState) {
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

function fallbackSummary(session: DebugSession, evidence: unknown) {
  const serialized = JSON.stringify(evidence);
  const eventCount = Array.isArray((evidence as { events?: unknown[] }).events)
    ? (evidence as { events: unknown[] }).events.length
    : 0;

  return [
    "Summary",
    `Session ${session.name} has ${eventCount} collected task events.`,
    "",
    "Evidence",
    serialized.length > 2
      ? "Read-only agent evidence is available in the event stream."
      : "No agent evidence has been collected yet.",
    "",
    "Likely Causes",
    "Gemini is not configured, so Patchbay cannot rank causes yet.",
    "",
    "Next Diagnostics",
    "Set GEMINI_API_KEY to enable provider-backed synthesis."
  ].join("\n");
}

