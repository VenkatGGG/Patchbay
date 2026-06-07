import { Agent, DebugSession, DiagnosticTask, TaskEvent } from "../types";

export type EvidencePayload = {
  agents: Agent[];
  tasks: DiagnosticTask[];
  events: TaskEvent[];
};

export type SynthesisResult = {
  provider: string;
  summary: string;
};

export type LLMProviderStatus = {
  id: string;
  displayName: string;
  configured: boolean;
  selected: boolean;
};

export type LLMProvider = {
  id: string;
  displayName: string;
  isConfigured(): boolean;
  synthesize(session: DebugSession, evidence: EvidencePayload): Promise<SynthesisResult>;
};

