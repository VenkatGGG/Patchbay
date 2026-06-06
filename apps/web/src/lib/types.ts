export const READ_ONLY_CAPABILITIES = [
  "system.info",
  "process.list",
  "disk.usage",
  "network.connections",
  "logs.search"
] as const;

export type Capability = (typeof READ_ONLY_CAPABILITIES)[number];

export type AgentStatus = "online" | "idle" | "offline";
export type SessionStatus = "active" | "expired" | "closed";
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "denied";
export type TaskEventLevel = "info" | "warning" | "error";

export type Environment = {
  id: string;
  name: string;
  provider: "any" | "aws" | "gcp" | "kubernetes" | "vm" | "docker";
  createdAt: string;
};

export type TailscaleState = {
  enabled: boolean;
  tailnet?: string;
  nodeId?: string;
  hostname?: string;
  tags: string[];
  authKeyPreview?: string;
};

export type Agent = {
  id: string;
  environmentId: string;
  name: string;
  version: string;
  status: AgentStatus;
  capabilities: Capability[];
  tailscale: TailscaleState;
  lastSeenAt: string;
  createdAt: string;
};

export type DebugSession = {
  id: string;
  environmentId: string;
  name: string;
  requestedBy: string;
  mode: "read_only";
  status: SessionStatus;
  allowedCapabilities: Capability[];
  createdAt: string;
  expiresAt: string;
};

export type DiagnosticTask = {
  id: string;
  sessionId: string;
  agentId: string;
  capability: Capability;
  params: Record<string, unknown>;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
};

export type TaskEvent = {
  id: string;
  taskId: string;
  sessionId: string;
  agentId: string;
  level: TaskEventLevel;
  message: string;
  payload?: unknown;
  createdAt: string;
};

export type AuditEvent = {
  id: string;
  action: string;
  actor: string;
  target: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type Synthesis = {
  id: string;
  sessionId: string;
  provider: string;
  summary: string;
  createdAt: string;
};

export type ControlPlaneState = {
  environments: Environment[];
  agents: Agent[];
  sessions: DebugSession[];
  tasks: DiagnosticTask[];
  events: TaskEvent[];
  syntheses: Synthesis[];
  audit: AuditEvent[];
};

