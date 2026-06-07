import { DebugSession } from "../types";
import { EvidencePayload, LLMProvider, SynthesisResult } from "./types";

export const offlineProvider: LLMProvider = {
  id: "offline",
  displayName: "Offline fallback",
  isConfigured() {
    return true;
  },
  async synthesize(
    session: DebugSession,
    evidence: EvidencePayload
  ): Promise<SynthesisResult> {
    const serialized = JSON.stringify(evidence);
    const eventCount = evidence.summary.eventCount;

    return {
      provider: "offline",
      summary: [
        "Summary",
        `Session ${session.name} has ${eventCount} collected task events across ${evidence.summary.taskCount} tasks.`,
        "",
        "Evidence",
        serialized.length > 2
          ? `Read-only evidence is available for: ${evidence.summary.capabilities.join(", ")}.`
          : "No agent evidence has been collected yet.",
        "",
        "Likely Causes",
        "No configured LLM provider was available, so Patchbay cannot rank causes yet.",
        "",
        "Next Diagnostics",
        "Set PATCHBAY_LLM_PROVIDER=gemini and GEMINI_API_KEY to enable Gemini-backed synthesis."
      ].join("\n")
    };
  }
};
