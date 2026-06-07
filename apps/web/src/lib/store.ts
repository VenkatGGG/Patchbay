import {
  Agent,
  AuditEvent,
  Capability,
  ControlPlaneState,
  DebugSession,
  DiagnosticTask,
  Environment,
  READ_ONLY_CAPABILITIES,
  Synthesis,
  TaskEvent,
  TaskEventLevel,
  TaskStatus,
  TailscaleState
} from "./types";

type EnrollAgentInput = {
  environmentId: string;
  name: string;
  version: string;
  capabilities: Capability[];
  tailscale?: Partial<TailscaleState>;
};

type CreateSessionInput = {
  environmentId: string;
  name: string;
  requestedBy: string;
  ttlMinutes?: number;
};

type AddTaskEventInput = {
  agentId: string;
  level?: TaskEventLevel;
  message: string;
  payload?: unknown;
  status?: TaskStatus;
  result?: unknown;
  error?: string;
};

const globalForStore = globalThis as unknown as {
  patchbayStore?: PatchbayStore;
};

const now = () => new Date().toISOString();

const makeId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

class PatchbayStore {
  private environments = new Map<string, Environment>();
  private agents = new Map<string, Agent>();
  private sessions = new Map<string, DebugSession>();
  private tasks = new Map<string, DiagnosticTask>();
  private events = new Map<string, TaskEvent>();
  private syntheses = new Map<string, Synthesis>();
  private audit = new Map<string, AuditEvent>();

  constructor() {
    const localEnvironment: Environment = {
      id: "env_local",
      name: "Local incident lab",
      provider: "any",
      createdAt: now()
    };
    this.environments.set(localEnvironment.id, localEnvironment);
    this.addAudit("environment.seeded", "system", localEnvironment.id, {
      provider: localEnvironment.provider
    });
  }

  snapshot(): ControlPlaneState {
    this.expireSessions();

    return {
      environments: [...this.environments.values()],
      agents: [...this.agents.values()],
      sessions: [...this.sessions.values()],
      tasks: [...this.tasks.values()],
      events: [...this.events.values()],
      syntheses: [...this.syntheses.values()],
      audit: [...this.audit.values()]
    };
  }

  createEnvironment(name: string, provider: Environment["provider"] = "any") {
    const environment: Environment = {
      id: makeId("env"),
      name,
      provider,
      createdAt: now()
    };

    this.environments.set(environment.id, environment);
    this.addAudit("environment.created", "user", environment.id, { provider });
    return environment;
  }

  enrollAgent(input: EnrollAgentInput) {
    const environment = this.environments.get(input.environmentId);
    if (!environment) {
      throw new Error(`Unknown environment: ${input.environmentId}`);
    }

    const existing = [...this.agents.values()].find(
      (agent) =>
        agent.environmentId === input.environmentId && agent.name === input.name
    );

    const enrolledAt = now();
    const tailscale: TailscaleState = {
      enabled: Boolean(input.tailscale?.enabled),
      tailnet: input.tailscale?.tailnet,
      nodeId: input.tailscale?.nodeId,
      hostname: input.tailscale?.hostname,
      tags: input.tailscale?.tags ?? ["tag:patchbay-agent"],
      authKeyPreview: input.tailscale?.authKeyPreview
    };

    const agent: Agent = {
      id: existing?.id ?? makeId("agt"),
      environmentId: input.environmentId,
      name: input.name,
      version: input.version,
      status: "online",
      capabilities: input.capabilities.filter((capability) =>
        READ_ONLY_CAPABILITIES.includes(capability)
      ),
      tailscale,
      lastSeenAt: enrolledAt,
      createdAt: existing?.createdAt ?? enrolledAt
    };

    this.agents.set(agent.id, agent);
    this.addAudit(existing ? "agent.updated" : "agent.enrolled", agent.id, agent.id, {
      environmentId: input.environmentId,
      capabilities: agent.capabilities
    });
    return agent;
  }

  createSession(input: CreateSessionInput) {
    const environment = this.environments.get(input.environmentId);
    if (!environment) {
      throw new Error(`Unknown environment: ${input.environmentId}`);
    }

    const createdAt = new Date();
    const ttlMinutes = input.ttlMinutes ?? 30;
    const session: DebugSession = {
      id: makeId("sess"),
      environmentId: input.environmentId,
      name: input.name,
      requestedBy: input.requestedBy,
      mode: "read_only",
      status: "active",
      allowedCapabilities: [...READ_ONLY_CAPABILITIES],
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMinutes * 60_000).toISOString()
    };

    this.sessions.set(session.id, session);
    this.addAudit("session.created", input.requestedBy, session.id, {
      environmentId: input.environmentId,
      ttlMinutes
    });
    return session;
  }

  getSession(sessionId: string) {
    this.expireSessions();
    return this.sessions.get(sessionId);
  }

  createLatencyDiagnostic(sessionId: string) {
    const session = this.getSession(sessionId);
    if (!session || session.status !== "active") {
      throw new Error("Session is not active");
    }

    const agents = [...this.agents.values()].filter(
      (agent) => agent.environmentId === session.environmentId
    );

    const desired: Capability[] = [
      "workload.discover",
      "system.info",
      "process.list",
      "disk.usage",
      "network.connections",
      "logs.search",
      "docker.containers",
      "kubernetes.resources"
    ];

    const tasks: DiagnosticTask[] = [];
    for (const agent of agents) {
      const supported = desired.filter((capability) =>
        agent.capabilities.includes(capability)
      );

      for (const capability of supported) {
        const task: DiagnosticTask = {
          id: makeId("task"),
          sessionId,
          agentId: agent.id,
          capability,
          params: paramsFor(capability),
          status: "queued",
          createdAt: now()
        };
        this.tasks.set(task.id, task);
        tasks.push(task);
      }
    }

    this.addAudit("diagnostic.latency.created", "user", sessionId, {
      taskCount: tasks.length,
      agentCount: agents.length
    });
    return tasks;
  }

  claimTasks(agentId: string) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    const heartbeatAt = now();
    this.agents.set(agent.id, {
      ...agent,
      status: "online",
      lastSeenAt: heartbeatAt
    });

    return [...this.tasks.values()].filter((task) => {
      const session = this.sessions.get(task.sessionId);
      return (
        task.agentId === agentId &&
        task.status === "queued" &&
        session?.status === "active"
      );
    });
  }

  addTaskEvent(taskId: string, input: AddTaskEventInput) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }

    const event: TaskEvent = {
      id: makeId("evt"),
      taskId,
      sessionId: task.sessionId,
      agentId: input.agentId,
      level: input.level ?? "info",
      message: input.message,
      payload: input.payload,
      createdAt: now()
    };

    this.events.set(event.id, event);

    const nextStatus = input.status ?? task.status;
    this.tasks.set(task.id, {
      ...task,
      status: nextStatus,
      startedAt:
        task.startedAt ??
        (nextStatus === "running" || nextStatus === "completed" ? event.createdAt : undefined),
      completedAt:
        nextStatus === "completed" || nextStatus === "failed"
          ? event.createdAt
          : task.completedAt,
      result: input.result ?? task.result,
      error: input.error ?? task.error
    });

    return event;
  }

  addSynthesis(sessionId: string, provider: string, summary: string) {
    const synthesis: Synthesis = {
      id: makeId("syn"),
      sessionId,
      provider,
      summary,
      createdAt: now()
    };

    this.syntheses.set(synthesis.id, synthesis);
    this.addAudit("session.synthesized", provider, sessionId, {
      synthesisId: synthesis.id
    });
    return synthesis;
  }

  private expireSessions() {
    const currentTime = Date.now();
    for (const session of this.sessions.values()) {
      if (session.status === "active" && Date.parse(session.expiresAt) <= currentTime) {
        this.sessions.set(session.id, { ...session, status: "expired" });
      }
    }
  }

  private addAudit(
    action: string,
    actor: string,
    target: string,
    metadata: Record<string, unknown>
  ) {
    const auditEvent: AuditEvent = {
      id: makeId("aud"),
      action,
      actor,
      target,
      metadata,
      createdAt: now()
    };
    this.audit.set(auditEvent.id, auditEvent);
  }
}

const paramsFor = (capability: Capability): Record<string, unknown> => {
  switch (capability) {
    case "logs.search":
      return {
        pattern: "timeout|latency|connection|pool|error",
        paths: []
      };
    case "process.list":
      return {
        limit: 40
      };
    case "network.connections":
      return {
        limit: 60
      };
    case "docker.containers":
      return {
        limit: 60
      };
    case "kubernetes.resources":
      return {
        namespaces: "all",
        limit: 80
      };
    default:
      return {};
  }
};

export const store = globalForStore.patchbayStore ?? new PatchbayStore();
globalForStore.patchbayStore = store;
