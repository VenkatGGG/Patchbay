import { Capability, DebugSession, TaskEventLevel, TaskStatus } from "../types";

export type EvidenceSummary = {
  agentCount: number;
  taskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  eventCount: number;
  capabilities: Capability[];
};

export type EvidenceAgent = {
  id: string;
  name: string;
  environmentId: string;
  status: string;
  capabilities: Capability[];
  tailscaleEnabled: boolean;
};

export type EvidenceTask = {
  id: string;
  agentId: string;
  capability: Capability;
  status: TaskStatus;
  result?: unknown;
  error?: string;
};

export type EvidenceEvent = {
  taskId: string;
  agentId: string;
  level: TaskEventLevel;
  message: string;
  payload?: unknown;
};

export type EvidencePayload = {
  summary: EvidenceSummary;
  agents: EvidenceAgent[];
  tasks: EvidenceTask[];
  events: EvidenceEvent[];
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
