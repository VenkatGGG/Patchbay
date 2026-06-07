import { ControlPlaneState, DebugSession } from "../types";
import { buildEvidencePayload } from "./evidence";
import { geminiProvider } from "./gemini";
import { offlineProvider } from "./offline";
import { LLMProvider, LLMProviderStatus, SynthesisResult } from "./types";

const providers: LLMProvider[] = [geminiProvider, offlineProvider];

export function listLLMProviders(): LLMProviderStatus[] {
  const selected = selectedProviderId();
  return providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    configured: provider.isConfigured(),
    selected: provider.id === selected
  }));
}

export async function synthesizeSession(
  session: DebugSession,
  state: ControlPlaneState
): Promise<SynthesisResult> {
  const evidence = buildEvidencePayload(session.id, state);
  const provider = selectProvider();
  return provider.synthesize(session, evidence);
}

function selectProvider() {
  const selected = selectedProviderId();
  const provider = providers.find((candidate) => candidate.id === selected);

  if (provider?.isConfigured()) {
    return provider;
  }

  if (provider?.id === "gemini") {
    return provider;
  }

  return offlineProvider;
}

function selectedProviderId() {
  return process.env.PATCHBAY_LLM_PROVIDER ?? "gemini";
}

