import {
  Capability,
  DebugSession,
  EvidenceArtifact,
  Finding,
  TaskEventLevel,
  TaskStatus
} from "../types";
import type { InvestigationPlan } from "../investigation-plan";

export type EvidenceSummary = {
  agentCount: number;
  taskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  eventCount: number;
  evidenceCount: number;
  findingCount: number;
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
  agentId?: string;
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
  evidence: EvidenceArtifact[];
  findings: Finding[];
};

export type SynthesisResult = {
  provider: string;
  summary: string;
};

export type PlanningRequest = {
  objective: string;
  capabilities: readonly Capability[];
};

export type PlanningResult = {
  provider: string;
  plan: InvestigationPlan;
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
  plan?(request: PlanningRequest): Promise<PlanningResult>;
  synthesize(session: DebugSession, evidence: EvidencePayload): Promise<SynthesisResult>;
};
