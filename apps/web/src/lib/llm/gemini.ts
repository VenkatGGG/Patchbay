import { GoogleGenAI } from "@google/genai";
import { DebugSession } from "../types";
import { EvidencePayload, LLMProvider, SynthesisResult } from "./types";
import { offlineProvider } from "./offline";

export const geminiProvider: LLMProvider = {
  id: "gemini",
  displayName: "Google Gemini",
  isConfigured() {
    return Boolean(process.env.GEMINI_API_KEY);
  },
  async synthesize(
    session: DebugSession,
    evidence: EvidencePayload
  ): Promise<SynthesisResult> {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

    if (!apiKey) {
      const fallback = await offlineProvider.synthesize(session, evidence);
      return {
        ...fallback,
        provider: "gemini:offline"
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
      summary:
        response.text ??
        (await offlineProvider.synthesize(session, evidence)).summary
    };
  }
};

