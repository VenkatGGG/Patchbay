import { GoogleGenAI } from "@google/genai";
import { DebugSession } from "../types";
import { EvidencePayload, LLMProvider, SynthesisResult } from "./types";
import { offlineProvider } from "./offline";

type GeminiRestResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

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
    try {
      if (process.env.PATCHBAY_GEMINI_FORCE_FAILURE === "true") {
        throw new Error("Forced Gemini provider failure");
      }

      const contents = geminiContents(evidence);
      const response = process.env.GEMINI_API_BASE_URL?.trim()
        ? { text: await generateWithGeminiRest(apiKey, model, contents) }
        : await withTimeout(
            ai.models.generateContent({
              model,
              contents
            }),
            geminiTimeoutMs()
          );

      return {
        provider: `gemini:${model}`,
        summary:
          response.text ??
          (await offlineProvider.synthesize(session, evidence)).summary
      };
    } catch {
      const fallback = await offlineProvider.synthesize(session, evidence);
      return {
        provider: `gemini:${model}:offline-fallback`,
        summary: [
          "Summary",
          "Gemini synthesis was unavailable, so Patchbay generated an offline fallback from the collected evidence.",
          "",
          fallback.summary
        ].join("\n")
      };
    }
  }
};

function geminiTimeoutMs() {
  const value = Number(process.env.GEMINI_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(value) || value < 1_000) {
    return 30_000;
  }
  return Math.min(value, 120_000);
}

function geminiContents(evidence: EvidencePayload) {
  return [
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
  ];
}

async function generateWithGeminiRest(
  apiKey: string,
  model: string,
  contents: ReturnType<typeof geminiContents>
) {
  const apiBaseUrl = (process.env.GEMINI_API_BASE_URL ?? "").replace(/\/+$/u, "");
  const response = await withTimeout(
    fetch(
      `${apiBaseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ contents })
      }
    ),
    geminiTimeoutMs()
  );

  if (!response.ok) {
    throw new Error(`Gemini REST request failed: ${response.status}`);
  }

  const payload = (await response.json()) as GeminiRestResponse;
  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini REST response did not include text");
  }

  return text;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Gemini synthesis timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
