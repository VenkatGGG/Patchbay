import pg from "pg";
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

const { Pool } = pg;

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

export class TaskAssignmentError extends Error {
  constructor(taskId: string, agentId: string) {
    super(`Agent ${agentId} is not assigned to task ${taskId}`);
    this.name = "TaskAssignmentError";
  }
}

export class TaskStatusTransitionError extends Error {
  constructor(taskId: string, currentStatus: TaskStatus, nextStatus?: TaskStatus) {
    super(
      nextStatus
        ? `Task ${taskId} cannot transition from ${currentStatus} to ${nextStatus}`
        : `Task ${taskId} is already terminal with status ${currentStatus}`
    );
    this.name = "TaskStatusTransitionError";
  }
}

export type PatchbayStore = {
  snapshot(): Promise<ControlPlaneState>;
  createEnvironment(
    name: string,
    provider?: Environment["provider"]
  ): Promise<Environment>;
  enrollAgent(input: EnrollAgentInput): Promise<Agent>;
  createSession(input: CreateSessionInput): Promise<DebugSession>;
  getSession(sessionId: string): Promise<DebugSession | undefined>;
  closeSession(sessionId: string, actor?: string): Promise<DebugSession>;
  createLatencyDiagnostic(sessionId: string): Promise<DiagnosticTask[]>;
  claimTasks(agentId: string): Promise<DiagnosticTask[]>;
  addTaskEvent(taskId: string, input: AddTaskEventInput): Promise<TaskEvent>;
  addSynthesis(
    sessionId: string,
    provider: string,
    summary: string
  ): Promise<Synthesis>;
};

const globalForStore = globalThis as unknown as {
  patchbayStore?: PatchbayStore;
  patchbayPgPool?: pg.Pool;
};

const now = () => new Date().toISOString();

const makeId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

class MemoryStore implements PatchbayStore {
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

  async snapshot(): Promise<ControlPlaneState> {
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

  async createEnvironment(
    name: string,
    provider: Environment["provider"] = "any"
  ): Promise<Environment> {
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

  async enrollAgent(input: EnrollAgentInput): Promise<Agent> {
    const environment = this.environments.get(input.environmentId);
    if (!environment) {
      throw new Error(`Unknown environment: ${input.environmentId}`);
    }

    const existing = [...this.agents.values()].find(
      (agent) =>
        agent.environmentId === input.environmentId && agent.name === input.name
    );

    const enrolledAt = now();
    const tailscale = normalizeTailscale(input.tailscale);
    const agent: Agent = {
      id: existing?.id ?? makeId("agt"),
      environmentId: input.environmentId,
      name: input.name,
      version: input.version,
      status: "online",
      capabilities: filterReadOnlyCapabilities(input.capabilities),
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

  async createSession(input: CreateSessionInput): Promise<DebugSession> {
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

  async getSession(sessionId: string): Promise<DebugSession | undefined> {
    this.expireSessions();
    return this.sessions.get(sessionId);
  }

  async closeSession(sessionId: string, actor = "operator"): Promise<DebugSession> {
    this.expireSessions();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (session.status !== "active") {
      throw new Error("Session is not active");
    }

    const closedAt = now();
    const closedSession: DebugSession = { ...session, status: "closed" };
    let deniedTasks = 0;
    this.sessions.set(session.id, closedSession);

    for (const task of this.tasks.values()) {
      if (
        task.sessionId === session.id &&
        (task.status === "queued" || task.status === "running")
      ) {
        this.tasks.set(task.id, {
          ...task,
          status: "denied",
          completedAt: closedAt,
          error: "Session closed"
        });
        deniedTasks += 1;
      }
    }

    this.addAudit("session.closed", actor, session.id, { deniedTasks });
    return closedSession;
  }

  async createLatencyDiagnostic(sessionId: string): Promise<DiagnosticTask[]> {
    const session = await this.getSession(sessionId);
    if (!session || session.status !== "active") {
      throw new Error("Session is not active");
    }

    const agents = [...this.agents.values()].filter(
      (agent) => agent.environmentId === session.environmentId
    );

    const tasks = createDiagnosticTasks(sessionId, agents);
    for (const task of tasks) {
      this.tasks.set(task.id, task);
    }

    this.addAudit("diagnostic.latency.created", "user", sessionId, {
      taskCount: tasks.length,
      agentCount: agents.length
    });
    return tasks;
  }

  async claimTasks(agentId: string): Promise<DiagnosticTask[]> {
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

    const claimedAt = now();
    const claimedTasks = [...this.tasks.values()].filter((task) => {
      const session = this.sessions.get(task.sessionId);
      return (
        task.agentId === agentId &&
        task.status === "queued" &&
        session?.status === "active"
      );
    });

    for (const task of claimedTasks) {
      this.tasks.set(task.id, {
        ...task,
        status: "running",
        startedAt: task.startedAt ?? claimedAt
      });
    }

    return claimedTasks.map((task) => ({
      ...task,
      status: "running",
      startedAt: task.startedAt ?? claimedAt
    }));
  }

  async addTaskEvent(taskId: string, input: AddTaskEventInput): Promise<TaskEvent> {
    this.expireSessions();
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    ensureTaskAssignedToAgent(task, input.agentId);
    const session = this.sessions.get(task.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${task.sessionId}`);
    }
    if (session.status !== "active") {
      throw new Error("Session is not active");
    }
    ensureTaskEventCanApply(task, input);

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
    this.tasks.set(task.id, nextTaskState(task, event.createdAt, input));
    return event;
  }

  async addSynthesis(
    sessionId: string,
    provider: string,
    summary: string
  ): Promise<Synthesis> {
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

class PostgresStore implements PatchbayStore {
  constructor(private readonly pool: pg.Pool) {}

  async snapshot(): Promise<ControlPlaneState> {
    await this.ensureDefaultEnvironment();
    await this.expireSessions();

    const [
      environments,
      agents,
      sessions,
      tasks,
      events,
      syntheses,
      audit
    ] = await Promise.all([
      this.pool.query("SELECT * FROM environments ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM agents ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM sessions ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM session_tasks ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM task_events ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM syntheses ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM audit_log ORDER BY created_at ASC")
    ]);

    return {
      environments: environments.rows.map(toEnvironment),
      agents: agents.rows.map(toAgent),
      sessions: sessions.rows.map(toSession),
      tasks: tasks.rows.map(toTask),
      events: events.rows.map(toTaskEvent),
      syntheses: syntheses.rows.map(toSynthesis),
      audit: audit.rows.map(toAuditEvent)
    };
  }

  async createEnvironment(
    name: string,
    provider: Environment["provider"] = "any"
  ): Promise<Environment> {
    const id = makeId("env");
    const result = await this.pool.query(
      `
        INSERT INTO environments (id, name, provider)
        VALUES ($1, $2, $3)
        RETURNING *
      `,
      [id, name, provider]
    );
    await this.addAudit("environment.created", "user", id, { provider });
    return toEnvironment(result.rows[0]);
  }

  async enrollAgent(input: EnrollAgentInput): Promise<Agent> {
    await this.ensureEnvironment(input.environmentId);
    const existing = await this.pool.query(
      "SELECT * FROM agents WHERE environment_id = $1 AND name = $2",
      [input.environmentId, input.name]
    );
    const id = existing.rows[0]?.id ?? makeId("agt");
    const tailscale = normalizeTailscale(input.tailscale);
    const capabilities = filterReadOnlyCapabilities(input.capabilities);

    const result = await this.pool.query(
      `
        INSERT INTO agents (
          id,
          environment_id,
          name,
          version,
          status,
          capabilities,
          tailscale,
          last_seen_at,
          created_at
        )
        VALUES ($1, $2, $3, $4, 'online', $5, $6, now(), now())
        ON CONFLICT (environment_id, name)
        DO UPDATE SET
          version = EXCLUDED.version,
          status = 'online',
          capabilities = EXCLUDED.capabilities,
          tailscale = EXCLUDED.tailscale,
          last_seen_at = now()
        RETURNING *
      `,
      [
        id,
        input.environmentId,
        input.name,
        input.version,
        capabilities,
        JSON.stringify(tailscale)
      ]
    );

    const agent = toAgent(result.rows[0]);
    await this.addAudit(
      existing.rows.length > 0 ? "agent.updated" : "agent.enrolled",
      agent.id,
      agent.id,
      {
        environmentId: input.environmentId,
        capabilities: agent.capabilities
      }
    );
    return agent;
  }

  async createSession(input: CreateSessionInput): Promise<DebugSession> {
    await this.ensureEnvironment(input.environmentId);
    const id = makeId("sess");
    const ttlMinutes = input.ttlMinutes ?? 30;
    const result = await this.pool.query(
      `
        INSERT INTO sessions (
          id,
          environment_id,
          name,
          requested_by,
          mode,
          status,
          allowed_capabilities,
          expires_at
        )
        VALUES ($1, $2, $3, $4, 'read_only', 'active', $5, now() + ($6 || ' minutes')::interval)
        RETURNING *
      `,
      [id, input.environmentId, input.name, input.requestedBy, [...READ_ONLY_CAPABILITIES], ttlMinutes]
    );

    await this.addAudit("session.created", input.requestedBy, id, {
      environmentId: input.environmentId,
      ttlMinutes
    });
    return toSession(result.rows[0]);
  }

  async getSession(sessionId: string): Promise<DebugSession | undefined> {
    await this.expireSessions();
    const result = await this.pool.query("SELECT * FROM sessions WHERE id = $1", [
      sessionId
    ]);
    return result.rows[0] ? toSession(result.rows[0]) : undefined;
  }

  async closeSession(sessionId: string, actor = "operator"): Promise<DebugSession> {
    await this.expireSessions();
    const sessionResult = await this.pool.query("SELECT * FROM sessions WHERE id = $1", [
      sessionId
    ]);
    const session = sessionResult.rows[0] ? toSession(sessionResult.rows[0]) : undefined;
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (session.status !== "active") {
      throw new Error("Session is not active");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const closedResult = await client.query(
        "UPDATE sessions SET status = 'closed' WHERE id = $1 RETURNING *",
        [sessionId]
      );
      const deniedResult = await client.query(
        `
          UPDATE session_tasks
          SET
            status = 'denied',
            completed_at = now(),
            error = 'Session closed'
          WHERE session_id = $1
            AND status IN ('queued', 'running')
          RETURNING id
        `,
        [sessionId]
      );
      await client.query(
        `
          INSERT INTO audit_log (id, action, actor, target, metadata)
          VALUES ($1, 'session.closed', $2, $3, $4)
        `,
        [
          makeId("aud"),
          actor,
          sessionId,
          JSON.stringify({ deniedTasks: deniedResult.rowCount ?? 0 })
        ]
      );
      await client.query("COMMIT");
      return toSession(closedResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createLatencyDiagnostic(sessionId: string): Promise<DiagnosticTask[]> {
    const session = await this.getSession(sessionId);
    if (!session || session.status !== "active") {
      throw new Error("Session is not active");
    }

    const agentsResult = await this.pool.query(
      "SELECT * FROM agents WHERE environment_id = $1 ORDER BY created_at ASC",
      [session.environmentId]
    );
    const agents = agentsResult.rows.map(toAgent);
    const tasks = createDiagnosticTasks(sessionId, agents);

    for (const task of tasks) {
      await this.pool.query(
        `
          INSERT INTO session_tasks (
            id,
            session_id,
            agent_id,
            capability,
            params,
            status,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          task.id,
          task.sessionId,
          task.agentId,
          task.capability,
          JSON.stringify(task.params),
          task.status,
          task.createdAt
        ]
      );
    }

    await this.addAudit("diagnostic.latency.created", "user", sessionId, {
      taskCount: tasks.length,
      agentCount: agents.length
    });
    return tasks;
  }

  async claimTasks(agentId: string): Promise<DiagnosticTask[]> {
    const agent = await this.pool.query("SELECT id FROM agents WHERE id = $1", [agentId]);
    if (agent.rowCount === 0) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    await this.pool.query(
      "UPDATE agents SET status = 'online', last_seen_at = now() WHERE id = $1",
      [agentId]
    );

    const result = await this.pool.query(
      `
        UPDATE session_tasks task
        SET
          status = 'running',
          started_at = COALESCE(task.started_at, now())
        FROM sessions session
        WHERE session.id = task.session_id
          AND task.agent_id = $1
          AND task.status = 'queued'
          AND session.status = 'active'
        RETURNING task.*
      `,
      [agentId]
    );

    return result.rows
      .map(toTask)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  async addTaskEvent(taskId: string, input: AddTaskEventInput): Promise<TaskEvent> {
    await this.expireSessions();
    const taskResult = await this.pool.query(
      `
        SELECT task.*, session.status AS session_status
        FROM session_tasks task
        JOIN sessions session ON session.id = task.session_id
        WHERE task.id = $1
      `,
      [taskId]
    );
    const task = taskResult.rows[0] ? toTask(taskResult.rows[0]) : undefined;
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    ensureTaskAssignedToAgent(task, input.agentId);
    if (taskResult.rows[0].session_status !== "active") {
      throw new Error("Session is not active");
    }
    ensureTaskEventCanApply(task, input);

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
    const nextTask = nextTaskState(task, event.createdAt, input);

    await this.pool.query(
      `
        INSERT INTO task_events (
          id,
          task_id,
          session_id,
          agent_id,
          level,
          message,
          payload,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        event.id,
        event.taskId,
        event.sessionId,
        event.agentId,
        event.level,
        event.message,
        JSON.stringify(event.payload ?? null),
        event.createdAt
      ]
    );

    await this.pool.query(
      `
        UPDATE session_tasks
        SET
          status = $2,
          started_at = $3,
          completed_at = $4,
          result = $5,
          error = $6
        WHERE id = $1
      `,
      [
        taskId,
        nextTask.status,
        nextTask.startedAt ?? null,
        nextTask.completedAt ?? null,
        JSON.stringify(nextTask.result ?? null),
        nextTask.error ?? null
      ]
    );

    return event;
  }

  async addSynthesis(
    sessionId: string,
    provider: string,
    summary: string
  ): Promise<Synthesis> {
    const synthesis: Synthesis = {
      id: makeId("syn"),
      sessionId,
      provider,
      summary,
      createdAt: now()
    };

    const result = await this.pool.query(
      `
        INSERT INTO syntheses (id, session_id, provider, summary, created_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
      [
        synthesis.id,
        synthesis.sessionId,
        synthesis.provider,
        synthesis.summary,
        synthesis.createdAt
      ]
    );
    await this.addAudit("session.synthesized", provider, sessionId, {
      synthesisId: synthesis.id
    });
    return toSynthesis(result.rows[0]);
  }

  private async ensureDefaultEnvironment() {
    await this.pool.query(
      `
        INSERT INTO environments (id, name, provider)
        VALUES ('env_local', 'Local incident lab', 'any')
        ON CONFLICT (id) DO NOTHING
      `
    );
  }

  private async ensureEnvironment(environmentId: string) {
    await this.ensureDefaultEnvironment();
    const result = await this.pool.query("SELECT id FROM environments WHERE id = $1", [
      environmentId
    ]);
    if (result.rowCount === 0) {
      throw new Error(`Unknown environment: ${environmentId}`);
    }
  }

  private async expireSessions() {
    await this.pool.query(
      "UPDATE sessions SET status = 'expired' WHERE status = 'active' AND expires_at <= now()"
    );
  }

  private async addAudit(
    action: string,
    actor: string,
    target: string,
    metadata: Record<string, unknown>
  ) {
    await this.pool.query(
      `
        INSERT INTO audit_log (id, action, actor, target, metadata)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [makeId("aud"), action, actor, target, JSON.stringify(metadata)]
    );
  }
}

const createDiagnosticTasks = (sessionId: string, agents: Agent[]) => {
  const desired: Capability[] = [
    "workload.discover",
    "cloud.metadata",
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
      tasks.push({
        id: makeId("task"),
        sessionId,
        agentId: agent.id,
        capability,
        params: paramsFor(capability),
        status: "queued",
        createdAt: now()
      });
    }
  }

  return tasks;
};

const nextTaskState = (
  task: DiagnosticTask,
  eventCreatedAt: string,
  input: AddTaskEventInput
): DiagnosticTask => {
  const nextStatus = input.status ?? task.status;
  return {
    ...task,
    status: nextStatus,
    startedAt:
      task.startedAt ??
      (nextStatus === "running" || isTerminalTaskStatus(nextStatus)
        ? eventCreatedAt
        : undefined),
    completedAt:
      isTerminalTaskStatus(nextStatus)
        ? eventCreatedAt
        : task.completedAt,
    result: input.result ?? task.result,
    error: input.error ?? task.error
  };
};

const ensureTaskAssignedToAgent = (task: DiagnosticTask, agentId: string) => {
  if (task.agentId !== agentId) {
    throw new TaskAssignmentError(task.id, agentId);
  }
};

const ensureTaskEventCanApply = (task: DiagnosticTask, input: AddTaskEventInput) => {
  const mutatesTask =
    input.status !== undefined || input.result !== undefined || input.error !== undefined;

  if (!mutatesTask) {
    return;
  }

  if (isTerminalTaskStatus(task.status)) {
    throw new TaskStatusTransitionError(task.id, task.status, input.status);
  }

  if (input.status === "queued") {
    throw new TaskStatusTransitionError(task.id, task.status, input.status);
  }
};

const isTerminalTaskStatus = (status: TaskStatus) =>
  status === "completed" || status === "failed" || status === "denied";

const paramsFor = (capability: Capability): Record<string, unknown> => {
  switch (capability) {
    case "logs.search":
      return {
        pattern: "timeout|latency|connection|pool|error",
        paths: []
      };
    case "cloud.metadata":
      return {
        timeoutMs: 800
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

const filterReadOnlyCapabilities = (capabilities: Capability[]) =>
  capabilities.filter((capability) => READ_ONLY_CAPABILITIES.includes(capability));

const normalizeTailscale = (tailscale?: Partial<TailscaleState>): TailscaleState => ({
  enabled: Boolean(tailscale?.enabled),
  tailnet: tailscale?.tailnet,
  nodeId: tailscale?.nodeId,
  hostname: tailscale?.hostname,
  tags: tailscale?.tags ?? ["tag:patchbay-agent"],
  authKeyPreview: tailscale?.authKeyPreview
});

const toEnvironment = (row: Record<string, unknown>): Environment => ({
  id: stringValue(row.id),
  name: stringValue(row.name),
  provider: stringValue(row.provider) as Environment["provider"],
  createdAt: isoValue(row.created_at)
});

const toAgent = (row: Record<string, unknown>): Agent => ({
  id: stringValue(row.id),
  environmentId: stringValue(row.environment_id),
  name: stringValue(row.name),
  version: stringValue(row.version),
  status: stringValue(row.status) as Agent["status"],
  capabilities: stringArray(row.capabilities) as Capability[],
  tailscale: jsonValue<TailscaleState>(row.tailscale, {
    enabled: false,
    tags: ["tag:patchbay-agent"]
  }),
  lastSeenAt: isoValue(row.last_seen_at),
  createdAt: isoValue(row.created_at)
});

const toSession = (row: Record<string, unknown>): DebugSession => ({
  id: stringValue(row.id),
  environmentId: stringValue(row.environment_id),
  name: stringValue(row.name),
  requestedBy: stringValue(row.requested_by),
  mode: "read_only",
  status: stringValue(row.status) as DebugSession["status"],
  allowedCapabilities: stringArray(row.allowed_capabilities) as Capability[],
  createdAt: isoValue(row.created_at),
  expiresAt: isoValue(row.expires_at)
});

const toTask = (row: Record<string, unknown>): DiagnosticTask => ({
  id: stringValue(row.id),
  sessionId: stringValue(row.session_id),
  agentId: stringValue(row.agent_id),
  capability: stringValue(row.capability) as Capability,
  params: jsonValue<Record<string, unknown>>(row.params, {}),
  status: stringValue(row.status) as TaskStatus,
  createdAt: isoValue(row.created_at),
  startedAt: optionalIsoValue(row.started_at),
  completedAt: optionalIsoValue(row.completed_at),
  result: row.result ?? undefined,
  error: row.error === null ? undefined : stringValue(row.error)
});

const toTaskEvent = (row: Record<string, unknown>): TaskEvent => ({
  id: stringValue(row.id),
  taskId: stringValue(row.task_id),
  sessionId: stringValue(row.session_id),
  agentId: stringValue(row.agent_id),
  level: stringValue(row.level) as TaskEventLevel,
  message: stringValue(row.message),
  payload: row.payload ?? undefined,
  createdAt: isoValue(row.created_at)
});

const toSynthesis = (row: Record<string, unknown>): Synthesis => ({
  id: stringValue(row.id),
  sessionId: stringValue(row.session_id),
  provider: stringValue(row.provider),
  summary: stringValue(row.summary),
  createdAt: isoValue(row.created_at)
});

const toAuditEvent = (row: Record<string, unknown>): AuditEvent => ({
  id: stringValue(row.id),
  action: stringValue(row.action),
  actor: stringValue(row.actor),
  target: stringValue(row.target),
  metadata: jsonValue<Record<string, unknown>>(row.metadata, {}),
  createdAt: isoValue(row.created_at)
});

const stringValue = (value: unknown) => String(value ?? "");

const stringArray = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

const jsonValue = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
};

const isoValue = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

const optionalIsoValue = (value: unknown) =>
  value === null || value === undefined ? undefined : isoValue(value);

const shouldUsePostgres = () =>
  process.env.PATCHBAY_STORAGE === "postgres" && Boolean(process.env.DATABASE_URL);

export const getStoreRuntime = () => ({
  storage: shouldUsePostgres() ? "postgres" : "memory",
  postgresConfigured: Boolean(process.env.DATABASE_URL)
});

const createStore = (): PatchbayStore => {
  if (!shouldUsePostgres()) {
    return new MemoryStore();
  }

  const pool =
    globalForStore.patchbayPgPool ??
    new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10
    });
  globalForStore.patchbayPgPool = pool;
  return new PostgresStore(pool);
};

export const store = globalForStore.patchbayStore ?? createStore();
globalForStore.patchbayStore = store;
