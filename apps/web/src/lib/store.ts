import pg from "pg";
import { defaultCapabilityParams } from "./investigation-plan";
import { artifactRetentionCutoffMs } from "./retention";
import {
  Agent,
  AuditEvent,
  Capability,
  ControlPlaneState,
  DebugSession,
  DiagnosticTask,
  Environment,
  Investigation,
  InvestigationNode,
  READ_ONLY_CAPABILITIES,
  Synthesis,
  TaskEvent,
  TaskEventLevel,
  TaskStatus,
  TailscaleState,
  WorkloadPackMetadata
} from "./types";
import type { InvestigationPlan } from "./investigation-plan";

const { Pool } = pg;

type EnrollAgentInput = {
  environmentId: string;
  name: string;
  version: string;
  capabilities: Capability[];
  packs?: WorkloadPackMetadata[];
  tailscale?: Partial<TailscaleState>;
};

type CreateEnrollmentInvitationInput = {
  tokenHash: string;
  environmentId: string;
  expiresAt: string;
  createdBy: string;
};

type ConsumeEnrollmentInvitationInput = {
  tokenHash: string;
  environmentId: string;
};

type CreateSessionInput = {
  environmentId: string;
  name: string;
  requestedBy: string;
  ttlMinutes?: number;
  ttlSeconds?: number;
};

type AddTaskEventInput = {
  agentId: string;
  level?: TaskEventLevel;
  message: string;
  idempotencyKey?: string;
  payload?: unknown;
  status?: TaskStatus;
  result?: unknown;
  error?: string;
};

type CreateInvestigationInput = {
  sessionId: string;
  plan: InvestigationPlan;
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

export class AgentNameConflictError extends Error {
  constructor(environmentId: string, name: string) {
    super(`Agent name ${name} is already enrolled in environment ${environmentId}`);
    this.name = "AgentNameConflictError";
  }
}

export class EnrollmentInvitationError extends Error {
  constructor(message = "Enrollment invitation is invalid or has already been used") {
    super(message);
    this.name = "EnrollmentInvitationError";
  }
}

export type PatchbayStore = {
  snapshot(): Promise<ControlPlaneState>;
  createEnvironment(
    name: string,
    provider?: Environment["provider"]
  ): Promise<Environment>;
  createEnrollmentInvitation(input: CreateEnrollmentInvitationInput): Promise<void>;
  consumeEnrollmentInvitation(input: ConsumeEnrollmentInvitationInput): Promise<void>;
  enrollAgent(input: EnrollAgentInput): Promise<Agent>;
  revokeAgent(agentId: string, actor?: string): Promise<Agent>;
  createSession(input: CreateSessionInput): Promise<DebugSession>;
  getSession(sessionId: string): Promise<DebugSession | undefined>;
  createInvestigation(input: CreateInvestigationInput): Promise<{
    investigation: Investigation;
    nodes: InvestigationNode[];
  }>;
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
  private investigations = new Map<string, Investigation>();
  private investigationNodes = new Map<string, InvestigationNode>();
  private audit = new Map<string, AuditEvent>();
  private enrollmentInvitations = new Map<
    string,
    CreateEnrollmentInvitationInput & { consumedAt?: string }
  >();

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
    this.expireRunningTasks();
    this.expireStaleAgents();
    this.applyArtifactRetention();

    return {
      environments: [...this.environments.values()],
      agents: [...this.agents.values()],
      sessions: [...this.sessions.values()],
      tasks: [...this.tasks.values()],
      events: [...this.events.values()],
      syntheses: [...this.syntheses.values()],
      investigations: [...this.investigations.values()],
      investigationNodes: [...this.investigationNodes.values()],
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

  async createEnrollmentInvitation(input: CreateEnrollmentInvitationInput): Promise<void> {
    const environment = this.environments.get(input.environmentId);
    if (!environment) {
      throw new Error(`Unknown environment: ${input.environmentId}`);
    }

    this.enrollmentInvitations.set(input.tokenHash, input);
    this.addAudit("enrollment.invitation.created", input.createdBy, input.environmentId, {
      expiresAt: input.expiresAt
    });
  }

  async consumeEnrollmentInvitation(input: ConsumeEnrollmentInvitationInput): Promise<void> {
    const invitation = this.enrollmentInvitations.get(input.tokenHash);
    if (
      !invitation ||
      invitation.environmentId !== input.environmentId ||
      invitation.consumedAt ||
      Date.parse(invitation.expiresAt) <= Date.now()
    ) {
      throw new EnrollmentInvitationError();
    }

    invitation.consumedAt = now();
    this.enrollmentInvitations.set(input.tokenHash, invitation);
    this.addAudit("enrollment.invitation.consumed", "agent", input.environmentId, {});
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
    if (existing) {
      throw new AgentNameConflictError(input.environmentId, input.name);
    }

    const enrolledAt = now();
    const tailscale = normalizeTailscale(input.tailscale);
    const agent: Agent = {
      id: makeId("agt"),
      environmentId: input.environmentId,
      name: input.name,
      version: input.version,
      status: "online",
      credentialGeneration: 0,
      capabilities: filterReadOnlyCapabilities(input.capabilities),
      packs: normalizeWorkloadPacks(input.packs),
      tailscale,
      lastSeenAt: enrolledAt,
      leaseExpiresAt: leaseExpiry(enrolledAt),
      createdAt: enrolledAt
    };

    this.agents.set(agent.id, agent);
    this.addAudit("agent.enrolled", agent.id, agent.id, {
      environmentId: input.environmentId,
      capabilities: agent.capabilities,
      packs: agent.packs
    });
    return agent;
  }

  async revokeAgent(agentId: string, actor = "operator"): Promise<Agent> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    const revokedAt = now();
    const revokedAgent: Agent = {
      ...agent,
      status: "offline",
      credentialGeneration: agent.credentialGeneration + 1,
      revokedAt
    };
    this.agents.set(agent.id, revokedAgent);
    this.addAudit("agent.revoked", actor, agent.id, {
      environmentId: agent.environmentId,
      credentialGeneration: revokedAgent.credentialGeneration
    });
    return revokedAgent;
  }

  async createSession(input: CreateSessionInput): Promise<DebugSession> {
    const environment = this.environments.get(input.environmentId);
    if (!environment) {
      throw new Error(`Unknown environment: ${input.environmentId}`);
    }

    const createdAt = new Date();
    const ttlSeconds = sessionTtlSeconds(input);
    const session: DebugSession = {
      id: makeId("sess"),
      environmentId: input.environmentId,
      name: input.name,
      requestedBy: input.requestedBy,
      mode: "read_only",
      status: "active",
      allowedCapabilities: [...READ_ONLY_CAPABILITIES],
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlSeconds * 1000).toISOString()
    };

    this.sessions.set(session.id, session);
    this.addAudit("session.created", input.requestedBy, session.id, {
      environmentId: input.environmentId,
      ttlSeconds
    });
    return session;
  }

  async getSession(sessionId: string): Promise<DebugSession | undefined> {
    this.expireSessions();
    return this.sessions.get(sessionId);
  }

  async createInvestigation(input: CreateInvestigationInput) {
    const session = await this.getSession(input.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${input.sessionId}`);
    }
    if (session.status !== "active") {
      throw new Error("Session is not active");
    }

    const createdAt = now();
    const investigation: Investigation = {
      id: makeId("inv"),
      sessionId: input.sessionId,
      title: input.plan.title,
      objective: input.plan.objective,
      status: "planned",
      planVersion: input.plan.version,
      createdAt,
      updatedAt: createdAt
    };
    const nodes = input.plan.nodes.map(
      (node): InvestigationNode => ({
        id: makeId("inode"),
        investigationId: investigation.id,
        nodeKey: node.id,
        capability: node.capability,
        params: node.params,
        dependsOn: node.dependsOn,
        rationale: node.rationale,
        status: "pending",
        createdAt,
        updatedAt: createdAt
      })
    );

    this.investigations.set(investigation.id, investigation);
    for (const node of nodes) {
      this.investigationNodes.set(node.id, node);
    }
    this.addAudit("investigation.created", "operator", investigation.id, {
      sessionId: investigation.sessionId,
      nodeCount: nodes.length
    });
    return { investigation, nodes };
  }

  async closeSession(sessionId: string, actor = "operator"): Promise<DebugSession> {
    this.expireSessions();
    this.expireRunningTasks();
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
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (session.status !== "active") {
      throw new Error("Session is not active");
    }

    const tasks = createDiagnosticTasks(sessionId);
    for (const task of tasks) {
      this.tasks.set(task.id, task);
    }

    this.addAudit("diagnostic.latency.created", "user", sessionId, {
      taskCount: tasks.length,
      agentCount: [...this.agents.values()].filter(
        (agent) => agent.environmentId === session.environmentId
      ).length
    });
    return tasks;
  }

  async claimTasks(agentId: string): Promise<DiagnosticTask[]> {
    this.expireSessions();
    this.expireRunningTasks();
    this.expireStaleAgents();
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    const heartbeatAt = now();
    this.agents.set(agent.id, {
      ...agent,
      status: "online",
      lastSeenAt: heartbeatAt,
      leaseExpiresAt: leaseExpiry(heartbeatAt)
    });

    const claimedAt = now();
    const claimedTasks = [...this.tasks.values()].filter((task) => {
      const session = this.sessions.get(task.sessionId);
      return (
        (task.agentId === undefined || task.agentId === agentId) &&
        task.status === "queued" &&
        session?.status === "active" &&
        agent.capabilities.includes(task.capability)
      );
    });

    for (const task of claimedTasks) {
      this.tasks.set(task.id, {
        ...task,
        agentId,
        status: "running",
        startedAt: task.startedAt ?? claimedAt
      });
    }

    return claimedTasks.map((task) => ({
      ...task,
      agentId,
      status: "running",
      startedAt: task.startedAt ?? claimedAt
    }));
  }

  async addTaskEvent(taskId: string, input: AddTaskEventInput): Promise<TaskEvent> {
    this.expireSessions();
    this.expireRunningTasks();
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    ensureTaskAssignedToAgent(task, input.agentId);
    const session = this.sessions.get(task.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${task.sessionId}`);
    }
    const existingEvent = this.findTaskEventByIdempotencyKey(taskId, input);
    if (existingEvent) {
      return existingEvent;
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
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      createdAt: now()
    };

    this.events.set(event.id, event);
    this.tasks.set(task.id, nextTaskState(task, event.createdAt, input));
    return event;
  }

  private findTaskEventByIdempotencyKey(
    taskId: string,
    input: AddTaskEventInput
  ): TaskEvent | undefined {
    if (!input.idempotencyKey) {
      return undefined;
    }

    return [...this.events.values()].find(
      (event) =>
        event.taskId === taskId &&
        event.agentId === input.agentId &&
        event.idempotencyKey === input.idempotencyKey
    );
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
    const expiredAt = now();
    for (const session of this.sessions.values()) {
      if (session.status === "active" && Date.parse(session.expiresAt) <= currentTime) {
        this.sessions.set(session.id, { ...session, status: "expired" });
        let deniedTasks = 0;
        for (const task of this.tasks.values()) {
          if (
            task.sessionId === session.id &&
            (task.status === "queued" || task.status === "running")
          ) {
            this.tasks.set(task.id, {
              ...task,
              status: "denied",
              completedAt: expiredAt,
              error: "Session expired"
            });
            deniedTasks += 1;
          }
        }
        this.addAudit("session.expired", "system", session.id, { deniedTasks });
      }
    }
  }

  private expireStaleAgents() {
    const currentTime = Date.now();
    for (const agent of this.agents.values()) {
      if (
        agent.revokedAt ||
        agent.status === "offline" ||
        Date.parse(agent.leaseExpiresAt) > currentTime
      ) {
        continue;
      }

      this.agents.set(agent.id, { ...agent, status: "offline" });
      this.addAudit("agent.lease.expired", "system", agent.id, {
        environmentId: agent.environmentId,
        lastSeenAt: agent.lastSeenAt,
        leaseExpiresAt: agent.leaseExpiresAt
      });

      for (const task of this.tasks.values()) {
        if (
          task.agentId !== agent.id ||
          (task.status !== "queued" && task.status !== "running")
        ) {
          continue;
        }

        this.tasks.set(task.id, {
          ...task,
          agentId: undefined,
          status: "queued",
          startedAt: undefined,
          completedAt: undefined,
          result: undefined,
          error: undefined
        });
        this.addAudit("task.requeued", "system", task.id, {
          reason: "agent_lease_expired",
          agentId: agent.id,
          sessionId: task.sessionId
        });
      }
    }
  }

  private expireRunningTasks() {
    const timeoutSeconds = taskTimeoutSeconds();
    const deadline = Date.now() - timeoutSeconds * 1000;
    const expiredAt = now();

    for (const task of this.tasks.values()) {
      const startedAtMs = task.startedAt ? Date.parse(task.startedAt) : Number.NaN;
      if (
        task.status === "running" &&
        Number.isFinite(startedAtMs) &&
        startedAtMs <= deadline
      ) {
        this.tasks.set(task.id, {
          ...task,
          status: "failed",
          completedAt: expiredAt,
          error: taskTimeoutMessage(timeoutSeconds)
        });
        this.addAudit("task.timed_out", "system", task.id, {
          sessionId: task.sessionId,
          agentId: task.agentId,
          timeoutSeconds
        });
      }
    }
  }

  private applyArtifactRetention() {
    const cutoffMs = artifactRetentionCutoffMs();
    if (cutoffMs === undefined) {
      return;
    }

    let prunedTaskResults = 0;
    let prunedTaskEvents = 0;
    let prunedSyntheses = 0;

    for (const task of this.tasks.values()) {
      const retentionAt = Date.parse(task.completedAt ?? task.createdAt);
      if (
        task.result !== undefined &&
        isTerminalTaskStatus(task.status) &&
        Number.isFinite(retentionAt) &&
        retentionAt <= cutoffMs
      ) {
        this.tasks.set(task.id, { ...task, result: undefined });
        prunedTaskResults += 1;
      }
    }

    for (const event of this.events.values()) {
      const createdAt = Date.parse(event.createdAt);
      if (Number.isFinite(createdAt) && createdAt <= cutoffMs) {
        this.events.delete(event.id);
        prunedTaskEvents += 1;
      }
    }

    for (const synthesis of this.syntheses.values()) {
      const createdAt = Date.parse(synthesis.createdAt);
      if (Number.isFinite(createdAt) && createdAt <= cutoffMs) {
        this.syntheses.delete(synthesis.id);
        prunedSyntheses += 1;
      }
    }

    if (prunedTaskResults + prunedTaskEvents + prunedSyntheses > 0) {
      this.addAudit("artifact.retention.pruned", "system", "retention", {
        cutoff: new Date(cutoffMs).toISOString(),
        taskResults: prunedTaskResults,
        taskEvents: prunedTaskEvents,
        syntheses: prunedSyntheses
      });
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
    await this.expireStaleAgents();
    await this.expireSessions();
    await this.expireRunningTasks();
    await this.applyArtifactRetention();

    const [
      environments,
      agents,
      sessions,
      tasks,
      events,
      syntheses,
      investigations,
      investigationNodes,
      audit
    ] = await Promise.all([
      this.pool.query("SELECT * FROM environments ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM agents ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM sessions ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM session_tasks ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM task_events ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM syntheses ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM investigations ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM investigation_nodes ORDER BY created_at ASC"),
      this.pool.query("SELECT * FROM audit_log ORDER BY created_at ASC")
    ]);

    return {
      environments: environments.rows.map(toEnvironment),
      agents: agents.rows.map(toAgent),
      sessions: sessions.rows.map(toSession),
      tasks: tasks.rows.map(toTask),
      events: events.rows.map(toTaskEvent),
      syntheses: syntheses.rows.map(toSynthesis),
      investigations: investigations.rows.map(toInvestigation),
      investigationNodes: investigationNodes.rows.map(toInvestigationNode),
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

  async createEnrollmentInvitation(input: CreateEnrollmentInvitationInput): Promise<void> {
    await this.ensureEnvironment(input.environmentId);
    await this.pool.query(
      `
        INSERT INTO enrollment_invitations (
          token_hash,
          environment_id,
          expires_at,
          created_by
        )
        VALUES ($1, $2, $3, $4)
      `,
      [input.tokenHash, input.environmentId, input.expiresAt, input.createdBy]
    );
    await this.addAudit("enrollment.invitation.created", input.createdBy, input.environmentId, {
      expiresAt: input.expiresAt
    });
  }

  async consumeEnrollmentInvitation(input: ConsumeEnrollmentInvitationInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
          SELECT token_hash, environment_id, expires_at, consumed_at
          FROM enrollment_invitations
          WHERE token_hash = $1
          FOR UPDATE
        `,
        [input.tokenHash]
      );
      const invitation = result.rows[0];
      if (
        !invitation ||
        stringValue(invitation.environment_id) !== input.environmentId ||
        invitation.consumed_at ||
        Date.parse(isoValue(invitation.expires_at)) <= Date.now()
      ) {
        throw new EnrollmentInvitationError();
      }

      await client.query(
        "UPDATE enrollment_invitations SET consumed_at = now() WHERE token_hash = $1",
        [input.tokenHash]
      );
      await client.query(
        `
          INSERT INTO audit_log (id, action, actor, target, metadata)
          VALUES ($1, 'enrollment.invitation.consumed', 'agent', $2, '{}'::jsonb)
        `,
        [makeId("aud"), input.environmentId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async enrollAgent(input: EnrollAgentInput): Promise<Agent> {
    await this.ensureEnvironment(input.environmentId);
    const existing = await this.pool.query(
      "SELECT * FROM agents WHERE environment_id = $1 AND name = $2",
      [input.environmentId, input.name]
    );
    if (existing.rows.length > 0) {
      throw new AgentNameConflictError(input.environmentId, input.name);
    }

    const id = makeId("agt");
    const tailscale = normalizeTailscale(input.tailscale);
    const capabilities = filterReadOnlyCapabilities(input.capabilities);
    const packs = normalizeWorkloadPacks(input.packs);

    const result = await this.pool.query(
      `
        INSERT INTO agents (
          id,
          environment_id,
          name,
          version,
          status,
          credential_generation,
          revoked_at,
          capabilities,
          capability_packs,
          tailscale,
          last_seen_at,
          lease_expires_at,
          created_at
        )
        VALUES ($1, $2, $3, $4, 'online', 0, NULL, $5, $6, $7, now(), now() + make_interval(secs => $8::int), now())
        RETURNING *
      `,
      [
        id,
        input.environmentId,
        input.name,
        input.version,
        capabilities,
        JSON.stringify(packs),
        JSON.stringify(tailscale),
        agentLeaseSeconds()
      ]
    );

    const agent = toAgent(result.rows[0]);
    await this.addAudit("agent.enrolled", agent.id, agent.id, {
      environmentId: input.environmentId,
      capabilities: agent.capabilities,
      packs: agent.packs
    });
    return agent;
  }

  async revokeAgent(agentId: string, actor = "operator"): Promise<Agent> {
    const result = await this.pool.query(
      `
        UPDATE agents
        SET
          status = 'offline',
          credential_generation = credential_generation + 1,
          revoked_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [agentId]
    );
    if (result.rows.length === 0) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    const agent = toAgent(result.rows[0]);
    await this.addAudit("agent.revoked", actor, agent.id, {
      environmentId: agent.environmentId,
      credentialGeneration: agent.credentialGeneration
    });
    return agent;
  }

  async createSession(input: CreateSessionInput): Promise<DebugSession> {
    await this.ensureEnvironment(input.environmentId);
    const id = makeId("sess");
    const ttlSeconds = sessionTtlSeconds(input);
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
        VALUES ($1, $2, $3, $4, 'read_only', 'active', $5, now() + make_interval(secs => $6::int))
        RETURNING *
      `,
      [id, input.environmentId, input.name, input.requestedBy, [...READ_ONLY_CAPABILITIES], ttlSeconds]
    );

    await this.addAudit("session.created", input.requestedBy, id, {
      environmentId: input.environmentId,
      ttlSeconds
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
    await this.expireRunningTasks();
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

  async createInvestigation(input: CreateInvestigationInput) {
    const session = await this.getSession(input.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${input.sessionId}`);
    }
    if (session.status !== "active") {
      throw new Error("Session is not active");
    }

    const createdAt = now();
    const investigation: Investigation = {
      id: makeId("inv"),
      sessionId: input.sessionId,
      title: input.plan.title,
      objective: input.plan.objective,
      status: "planned",
      planVersion: input.plan.version,
      createdAt,
      updatedAt: createdAt
    };
    const nodes = input.plan.nodes.map(
      (node): InvestigationNode => ({
        id: makeId("inode"),
        investigationId: investigation.id,
        nodeKey: node.id,
        capability: node.capability,
        params: node.params,
        dependsOn: node.dependsOn,
        rationale: node.rationale,
        status: "pending",
        createdAt,
        updatedAt: createdAt
      })
    );

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO investigations (
            id, session_id, title, objective, status, plan_version, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          investigation.id,
          investigation.sessionId,
          investigation.title,
          investigation.objective,
          investigation.status,
          investigation.planVersion,
          investigation.createdAt,
          investigation.updatedAt
        ]
      );
      for (const node of nodes) {
        await client.query(
          `
            INSERT INTO investigation_nodes (
              id, investigation_id, node_key, capability, params, depends_on,
              rationale, status, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `,
          [
            node.id,
            node.investigationId,
            node.nodeKey,
            node.capability,
            JSON.stringify(node.params),
            node.dependsOn,
            node.rationale,
            node.status,
            node.createdAt,
            node.updatedAt
          ]
        );
      }
      await client.query(
        `
          INSERT INTO audit_log (id, action, actor, target, metadata)
          VALUES ($1, 'investigation.created', 'operator', $2, $3)
        `,
        [
          makeId("aud"),
          investigation.id,
          JSON.stringify({ sessionId: investigation.sessionId, nodeCount: nodes.length })
        ]
      );
      await client.query("COMMIT");
      return { investigation, nodes };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createLatencyDiagnostic(sessionId: string): Promise<DiagnosticTask[]> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (session.status !== "active") {
      throw new Error("Session is not active");
    }

    const tasks = createDiagnosticTasks(sessionId);
    const agentCountResult = await this.pool.query(
      "SELECT count(*)::int AS count FROM agents WHERE environment_id = $1",
      [session.environmentId]
    );

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
          task.agentId ?? null,
          task.capability,
          JSON.stringify(task.params),
          task.status,
          task.createdAt
        ]
      );
    }

    await this.addAudit("diagnostic.latency.created", "user", sessionId, {
      taskCount: tasks.length,
      agentCount: Number(agentCountResult.rows[0]?.count ?? 0)
    });
    return tasks;
  }

  async claimTasks(agentId: string): Promise<DiagnosticTask[]> {
    await this.expireSessions();
    await this.expireRunningTasks();
    await this.expireStaleAgents();
    const agent = await this.pool.query(
      "SELECT id, capabilities FROM agents WHERE id = $1",
      [agentId]
    );
    if (agent.rowCount === 0) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    await this.pool.query(
      "UPDATE agents SET status = 'online', last_seen_at = now(), lease_expires_at = now() + make_interval(secs => $2::int) WHERE id = $1",
      [agentId, agentLeaseSeconds()]
    );

    const result = await this.pool.query(
      `
        WITH candidates AS (
          SELECT task.id
          FROM session_tasks task
          JOIN sessions session ON session.id = task.session_id
          WHERE (task.agent_id IS NULL OR task.agent_id = $1)
            AND task.status = 'queued'
            AND session.status = 'active'
            AND task.capability = ANY($2::text[])
          ORDER BY task.created_at ASC
          FOR UPDATE OF task SKIP LOCKED
        )
        UPDATE session_tasks task
        SET
          agent_id = $1,
          status = 'running',
          started_at = COALESCE(task.started_at, now())
        FROM candidates
        WHERE task.id = candidates.id
        RETURNING task.*
      `,
      [agentId, stringArray(agent.rows[0].capabilities)]
    );

    return result.rows
      .map(toTask)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  async addTaskEvent(taskId: string, input: AddTaskEventInput): Promise<TaskEvent> {
    await this.expireSessions();
    await this.expireRunningTasks();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const taskResult = await client.query(
        `
          SELECT task.*, session.status AS session_status
          FROM session_tasks task
          JOIN sessions session ON session.id = task.session_id
          WHERE task.id = $1
          FOR UPDATE OF task
        `,
        [taskId]
      );
      const task = taskResult.rows[0] ? toTask(taskResult.rows[0]) : undefined;
      if (!task) {
        throw new Error(`Unknown task: ${taskId}`);
      }
      ensureTaskAssignedToAgent(task, input.agentId);

      const existingEvent = await this.findTaskEventByIdempotencyKey(
        client,
        taskId,
        input
      );
      if (existingEvent) {
        await client.query("COMMIT");
        return existingEvent;
      }

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
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
        createdAt: now()
      };
      const nextTask = nextTaskState(task, event.createdAt, input);

      await client.query(
        `
          INSERT INTO task_events (
            id,
            task_id,
            session_id,
            agent_id,
            level,
            message,
            idempotency_key,
            payload,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          event.id,
          event.taskId,
          event.sessionId,
          event.agentId,
          event.level,
          event.message,
          event.idempotencyKey ?? null,
          JSON.stringify(event.payload ?? null),
          event.createdAt
        ]
      );

      await client.query(
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

      await client.query("COMMIT");
      return event;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async findTaskEventByIdempotencyKey(
    client: pg.PoolClient,
    taskId: string,
    input: AddTaskEventInput
  ): Promise<TaskEvent | undefined> {
    if (!input.idempotencyKey) {
      return undefined;
    }

    const result = await client.query(
      `
        SELECT *
        FROM task_events
        WHERE task_id = $1
          AND agent_id = $2
          AND idempotency_key = $3
      `,
      [taskId, input.agentId, input.idempotencyKey]
    );
    return result.rows[0] ? toTaskEvent(result.rows[0]) : undefined;
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

  private async expireStaleAgents() {
    const result = await this.pool.query(
      `
        UPDATE agents
        SET status = 'offline'
        WHERE revoked_at IS NULL
          AND status IN ('online', 'idle')
          AND lease_expires_at <= now()
        RETURNING id, environment_id, last_seen_at, lease_expires_at
      `
    );

    for (const row of result.rows) {
      const agentId = stringValue(row.id);
      await this.addAudit("agent.lease.expired", "system", agentId, {
        environmentId: stringValue(row.environment_id),
        lastSeenAt: isoValue(row.last_seen_at),
        leaseExpiresAt: isoValue(row.lease_expires_at)
      });

      const requeuedTasks = await this.pool.query(
        `
          UPDATE session_tasks
          SET
            agent_id = NULL,
            status = 'queued',
            started_at = NULL,
            completed_at = NULL,
            result = NULL,
            error = NULL
          WHERE agent_id = $1
            AND status IN ('queued', 'running')
          RETURNING id, session_id
        `,
        [agentId]
      );

      for (const task of requeuedTasks.rows) {
        await this.addAudit("task.requeued", "system", stringValue(task.id), {
          reason: "agent_lease_expired",
          agentId,
          sessionId: stringValue(task.session_id)
        });
      }
    }
  }

  private async expireSessions() {
    const expiredSessions = await this.pool.query(
      "UPDATE sessions SET status = 'expired' WHERE status = 'active' AND expires_at <= now() RETURNING id"
    );

    for (const row of expiredSessions.rows) {
      const sessionId = stringValue(row.id);
      const deniedResult = await this.pool.query(
        `
          UPDATE session_tasks
          SET
            status = 'denied',
            completed_at = now(),
            error = 'Session expired'
          WHERE session_id = $1
            AND status IN ('queued', 'running')
          RETURNING id
        `,
        [sessionId]
      );
      await this.addAudit("session.expired", "system", sessionId, {
        deniedTasks: deniedResult.rowCount ?? 0
      });
    }
  }

  private async expireRunningTasks() {
    const timeoutSeconds = taskTimeoutSeconds();
    const result = await this.pool.query(
      `
        UPDATE session_tasks
        SET
          status = 'failed',
          completed_at = now(),
          error = $2
        WHERE status = 'running'
          AND started_at IS NOT NULL
          AND started_at <= now() - make_interval(secs => $1::int)
        RETURNING id, session_id, agent_id
      `,
      [timeoutSeconds, taskTimeoutMessage(timeoutSeconds)]
    );

    for (const row of result.rows) {
      await this.addAudit("task.timed_out", "system", stringValue(row.id), {
        sessionId: stringValue(row.session_id),
        agentId: stringValue(row.agent_id),
        timeoutSeconds
      });
    }
  }

  private async applyArtifactRetention() {
    const cutoffMs = artifactRetentionCutoffMs();
    if (cutoffMs === undefined) {
      return;
    }

    const cutoff = new Date(cutoffMs).toISOString();
    const prunedTasks = await this.pool.query(
      `
        UPDATE session_tasks
        SET result = NULL
        WHERE result IS NOT NULL
          AND status IN ('completed', 'failed', 'denied')
          AND COALESCE(completed_at, created_at) <= $1
        RETURNING id
      `,
      [cutoff]
    );
    const prunedEvents = await this.pool.query(
      "DELETE FROM task_events WHERE created_at <= $1 RETURNING id",
      [cutoff]
    );
    const prunedSyntheses = await this.pool.query(
      "DELETE FROM syntheses WHERE created_at <= $1 RETURNING id",
      [cutoff]
    );

    const taskResults = prunedTasks.rowCount ?? 0;
    const taskEvents = prunedEvents.rowCount ?? 0;
    const syntheses = prunedSyntheses.rowCount ?? 0;
    if (taskResults + taskEvents + syntheses > 0) {
      await this.addAudit("artifact.retention.pruned", "system", "retention", {
        cutoff,
        taskResults,
        taskEvents,
        syntheses
      });
    }
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

const createDiagnosticTasks = (sessionId: string) => {
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
  return desired.map((capability): DiagnosticTask => ({
    id: makeId("task"),
    sessionId,
    capability,
    params: defaultCapabilityParams(capability),
    status: "queued" as const,
    createdAt: now()
  }));
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

const sessionTtlSeconds = (input: Pick<CreateSessionInput, "ttlMinutes" | "ttlSeconds">) =>
  input.ttlSeconds ?? (input.ttlMinutes ?? 30) * 60;

const taskTimeoutSeconds = () => {
  const value = Number(process.env.PATCHBAY_TASK_TIMEOUT_SECONDS ?? 5 * 60);
  if (!Number.isInteger(value) || value <= 0) {
    return 5 * 60;
  }
  return Math.min(value, 24 * 60 * 60);
};

const agentLeaseSeconds = () => {
  const value = Number(process.env.PATCHBAY_AGENT_LEASE_SECONDS ?? 120);
  if (!Number.isInteger(value) || value <= 0) {
    return 120;
  }
  return Math.min(value, 24 * 60 * 60);
};

const leaseExpiry = (from: string) =>
  new Date(Date.parse(from) + agentLeaseSeconds() * 1000).toISOString();

const taskTimeoutMessage = (timeoutSeconds: number) =>
  `Task timed out after ${timeoutSeconds} seconds`;

const filterReadOnlyCapabilities = (capabilities: Capability[]) =>
  capabilities.filter((capability) => READ_ONLY_CAPABILITIES.includes(capability));

const normalizeWorkloadPacks = (packs?: WorkloadPackMetadata[]) =>
  (packs ?? [])
    .filter((pack) => pack.readOnly)
    .map((pack) => ({
      ...pack,
      capabilities: pack.capabilities.filter(
        (capability) =>
          capability.readOnly && READ_ONLY_CAPABILITIES.includes(capability.name)
      )
    }))
    .filter((pack) => pack.capabilities.length > 0);

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
  credentialGeneration: numberValue(row.credential_generation, 0),
  revokedAt: optionalIsoValue(row.revoked_at),
  capabilities: stringArray(row.capabilities) as Capability[],
  packs: jsonValue<WorkloadPackMetadata[]>(row.capability_packs, []),
  tailscale: jsonValue<TailscaleState>(row.tailscale, {
    enabled: false,
    tags: ["tag:patchbay-agent"]
  }),
  lastSeenAt: isoValue(row.last_seen_at),
  leaseExpiresAt: isoValue(row.lease_expires_at),
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
  agentId: optionalStringValue(row.agent_id),
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
  idempotencyKey: row.idempotency_key ? stringValue(row.idempotency_key) : undefined,
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

const toInvestigation = (row: Record<string, unknown>): Investigation => ({
  id: stringValue(row.id),
  sessionId: stringValue(row.session_id),
  title: stringValue(row.title),
  objective: stringValue(row.objective),
  status: stringValue(row.status) as Investigation["status"],
  planVersion: numberValue(row.plan_version, 1),
  createdAt: isoValue(row.created_at),
  updatedAt: isoValue(row.updated_at)
});

const toInvestigationNode = (row: Record<string, unknown>): InvestigationNode => ({
  id: stringValue(row.id),
  investigationId: stringValue(row.investigation_id),
  nodeKey: stringValue(row.node_key),
  capability: stringValue(row.capability) as Capability,
  params: jsonValue<Record<string, unknown>>(row.params, {}),
  dependsOn: stringArray(row.depends_on),
  rationale: stringValue(row.rationale),
  status: stringValue(row.status) as InvestigationNode["status"],
  taskId: optionalStringValue(row.task_id),
  error: row.error === null ? undefined : optionalStringValue(row.error),
  createdAt: isoValue(row.created_at),
  updatedAt: isoValue(row.updated_at)
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

const optionalStringValue = (value: unknown) =>
  value === null || value === undefined ? undefined : String(value);

const stringArray = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

const numberValue = (value: unknown, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

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
