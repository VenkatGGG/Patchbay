"use client";

import {
  Activity,
  Boxes,
  Cable,
  FileText,
  Gauge,
  Network,
  RefreshCcw,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ControlPlaneState, DebugSession, DiagnosticTask } from "@/lib/types";

const emptyState: ControlPlaneState = {
  environments: [],
  agents: [],
  sessions: [],
  tasks: [],
  events: [],
  syntheses: [],
  audit: []
};

export function ControlPlaneDashboard() {
  const [state, setState] = useState<ControlPlaneState>(emptyState);
  const [sessionName, setSessionName] = useState("checkout latency investigation");
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [busyAction, setBusyAction] = useState<
    "refresh" | "session" | "diagnostic" | "synthesis" | null
  >(null);
  const [notice, setNotice] = useState<string>("");
  const [error, setError] = useState<string>("");

  const selectedSession = useMemo(
    () =>
      state.sessions.find((session) => session.id === selectedSessionId) ??
      state.sessions.at(-1),
    [selectedSessionId, state.sessions]
  );

  const selectedEnvironment = state.environments[0];
  const selectedTasks = selectedSession
    ? state.tasks.filter((task) => task.sessionId === selectedSession.id)
    : [];
  const selectedEvents = selectedSession
    ? state.events
        .filter((event) => event.sessionId === selectedSession.id)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    : [];
  const selectedCompletedTasks = selectedTasks.filter(
    (task) => task.status === "completed" && task.result !== undefined
  );
  const latestSynthesis = selectedSession
    ? state.syntheses
        .filter((synthesis) => synthesis.sessionId === selectedSession.id)
        .at(-1)
    : undefined;
  const taskSummary = summarizeTasks(selectedTasks);
  const completionPercent =
    selectedTasks.length === 0
      ? 0
      : Math.round((taskSummary.completed / selectedTasks.length) * 100);
  const onlineAgents = state.agents.filter((agent) => agent.status === "online").length;

  async function refresh() {
    setBusyAction("refresh");
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`State refresh failed with ${response.status}`);
      }
      setState(await response.json());
      setError("");
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusyAction(null);
    }
  }

  async function createSession() {
    if (!selectedEnvironment) return;
    setBusyAction("session");
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          environmentId: selectedEnvironment.id,
          name: sessionName,
          requestedBy: "local-oncall",
          ttlMinutes: 30
        })
      });
      if (!response.ok) {
        throw new Error(`Session creation failed with ${response.status}`);
      }
      const session = (await response.json()) as DebugSession;
      setSelectedSessionId(session.id);
      setNotice(`Started ${session.name}`);
      setError("");
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusyAction(null);
    }
  }

  async function runDiagnostic() {
    if (!selectedSession) return;
    setBusyAction("diagnostic");
    try {
      const response = await fetch(`/api/sessions/${selectedSession.id}/diagnostics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: "latency_spike" })
      });
      if (!response.ok) {
        throw new Error(`Diagnostic run failed with ${response.status}`);
      }
      const tasks = (await response.json()) as DiagnosticTask[];
      setNotice(`Queued ${tasks.length} read-only diagnostics`);
      setError("");
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusyAction(null);
    }
  }

  async function synthesize() {
    if (!selectedSession) return;
    setBusyAction("synthesis");
    try {
      const response = await fetch(`/api/sessions/${selectedSession.id}/synthesize`, {
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Synthesis failed with ${response.status}`);
      }
      setNotice("Generated investigation synthesis");
      setError("");
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusyAction(null);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Cable size={19} />
          </div>
          <div>
            <h1>Patchbay</h1>
            <p>Control Plane</p>
          </div>
        </div>

        <nav className="nav-group" aria-label="Primary">
          <div className="nav-item active">
            <Gauge size={17} />
            Sessions
          </div>
          <div className="nav-item">
            <Boxes size={17} />
            Agents
          </div>
          <div className="nav-item">
            <ShieldCheck size={17} />
            Policy
          </div>
        </nav>

        <SidebarStats state={state} />
      </aside>

      <section className="main">
        <div className="topbar">
          <div>
            <h2>Incident Sessions</h2>
            <p>Read-only diagnostics across enrolled agents.</p>
          </div>
          <div className="toolbar">
            <button
              className="button secondary"
              type="button"
              onClick={refresh}
              disabled={busyAction !== null}
            >
              <RefreshCcw size={16} />
              {busyAction === "refresh" ? "Refreshing" : "Refresh"}
            </button>
            <button
              className="button"
              type="button"
              onClick={runDiagnostic}
              disabled={!selectedSession || busyAction !== null}
            >
              <Activity size={16} />
              {busyAction === "diagnostic" ? "Queueing" : "Run Latency Diagnostic"}
            </button>
            <button
              className="button"
              type="button"
              onClick={synthesize}
              disabled={!selectedSession || busyAction !== null}
            >
              <Sparkles size={16} />
              {busyAction === "synthesis" ? "Synthesizing" : "Synthesize"}
            </button>
          </div>
        </div>

        {(error || notice) && (
          <div className={`banner ${error ? "error" : "info"}`} role="status">
            {error || notice}
          </div>
        )}

        <div className="grid">
          <div className="stack">
            <Panel
              icon={<Network size={17} />}
              title="Environment"
              subtitle={selectedEnvironment?.name ?? "No environment"}
            >
              <div className="metric-grid">
                <Metric label="Agents" value={state.agents.length} />
                <Metric label="Online" value={onlineAgents} />
                <Metric label="Sessions" value={state.sessions.length} />
                <Metric label="Queued Tasks" value={countTasks(state, "queued")} />
              </div>
            </Panel>

            <Panel
              icon={<Activity size={17} />}
              title="Session Control"
              subtitle="Session-scoped read-only authority"
            >
              <div className="form-row">
                <input
                  className="input"
                  value={sessionName}
                  onChange={(event) => setSessionName(event.target.value)}
                  aria-label="Session name"
                />
                <button
                  className="button"
                  type="button"
                  onClick={createSession}
                  disabled={busyAction !== null || !selectedEnvironment}
                >
                  {busyAction === "session" ? "Starting" : "Start Session"}
                </button>
              </div>
            </Panel>

            <Panel
              icon={<Gauge size={17} />}
              title="Session Health"
              subtitle={selectedSession?.id ?? "No active session"}
            >
              {selectedSession ? (
                <div className="session-health">
                  <div className="health-row">
                    <span>Progress</span>
                    <strong>{completionPercent}%</strong>
                  </div>
                  <div className="progress-track" aria-label="Task completion">
                    <div
                      className="progress-fill"
                      style={{ width: `${completionPercent}%` }}
                    />
                  </div>
                  <div className="health-grid">
                    <Metric label="Completed" value={taskSummary.completed} />
                    <Metric label="Running" value={taskSummary.running} />
                    <Metric label="Queued" value={taskSummary.queued} />
                    <Metric label="Failed" value={taskSummary.failed} />
                  </div>
                </div>
              ) : (
                <div className="empty">Start a session to track diagnostic progress.</div>
              )}
            </Panel>

            <Panel
              icon={<Boxes size={17} />}
              title="Agents"
              subtitle="Environment-local diagnostic workers"
            >
              {state.agents.length === 0 ? (
                <div className="empty">No agents enrolled.</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Capabilities</th>
                      <th>Tailscale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.agents.map((agent) => (
                      <tr key={agent.id}>
                        <td>
                          <strong>{agent.name}</strong>
                          <div className="mono">{agent.id}</div>
                        </td>
                        <td>
                          <StatusPill value={agent.status} />
                        </td>
                        <td>
                          <strong>{agent.capabilities.length}</strong>
                          <div className="muted-line">
                            {agent.capabilities.slice(0, 3).join(", ")}
                          </div>
                        </td>
                        <td>
                          {agent.tailscale.enabled
                            ? agent.tailscale.authKeyPreview ?? "enabled"
                            : "local dev"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel
              icon={<FileText size={17} />}
              title="Tasks"
              subtitle={selectedSession?.name ?? "No session selected"}
            >
              {selectedTasks.length === 0 ? (
                <div className="empty">No diagnostic tasks yet.</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Capability</th>
                      <th>Agent</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedTasks.map((task) => (
                      <tr key={task.id}>
                        <td className="mono">{task.capability}</td>
                        <td className="mono">{task.agentId}</td>
                        <td>
                          <StatusPill value={task.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>

          <div className="stack">
            <Panel
              icon={<Activity size={17} />}
              title="Sessions"
              subtitle="Active and historical"
            >
              {state.sessions.length === 0 ? (
                <div className="empty">No sessions started.</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.sessions.map((session) => (
                      <tr
                        key={session.id}
                        onClick={() => setSelectedSessionId(session.id)}
                        style={{ cursor: "pointer" }}
                      >
                        <td>
                          <strong>{session.name}</strong>
                          <div className="mono">{session.id}</div>
                        </td>
                        <td>
                          <StatusPill value={session.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel icon={<FileText size={17} />} title="Event Stream" subtitle="Newest first">
              <div className="event-stream">
                {selectedEvents.length === 0 ? (
                  <div className="empty">No task events collected.</div>
                ) : (
                  selectedEvents.map((event) => (
                    <div className="event" key={event.id}>
                      <div className="event-heading">
                        <strong>{event.message}</strong>
                        <StatusPill value={event.level} />
                      </div>
                      <p className="mono">
                        {event.taskId} · {new Date(event.createdAt).toLocaleTimeString()}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </Panel>

            <Panel
              icon={<FileText size={17} />}
              title="Diagnostic Results"
              subtitle={`${selectedCompletedTasks.length} completed payloads`}
            >
              {selectedCompletedTasks.length === 0 ? (
                <div className="empty">No completed diagnostic payloads yet.</div>
              ) : (
                <div className="result-list">
                  {selectedCompletedTasks.map((task) => (
                    <DiagnosticResult task={task} key={task.id} />
                  ))}
                </div>
              )}
            </Panel>

            <Panel
              icon={<Sparkles size={17} />}
              title="Gemini Synthesis"
              subtitle={latestSynthesis?.provider ?? "Not synthesized"}
            >
              {latestSynthesis ? (
                <div className="summary">{latestSynthesis.summary}</div>
              ) : (
                <div className="empty">No synthesis available.</div>
              )}
            </Panel>
          </div>
        </div>
      </section>
    </main>
  );
}

function SidebarStats({ state }: { state: ControlPlaneState }) {
  return (
    <div className="sidebar-section">
      <p className="section-label">Runtime</p>
      <div className="status-list">
        <div className="status-row">
          <span>Mode</span>
          <strong>Read-only</strong>
        </div>
        <div className="status-row">
          <span>LLM</span>
          <strong>Gemini</strong>
        </div>
        <div className="status-row">
          <span>Audit Events</span>
          <strong>{state.audit.length}</strong>
        </div>
      </div>
    </div>
  );
}

function Panel({
  icon,
  title,
  subtitle,
  children
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          {icon}
          <div>
            <h3>{title}</h3>
            <p>{subtitle}</p>
          </div>
        </div>
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ value }: { value: string }) {
  return <span className={`pill ${value}`}>{value}</span>;
}

function summarizeTasks(tasks: DiagnosticTask[]) {
  return {
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length
  };
}

function DiagnosticResult({ task }: { task: DiagnosticTask }) {
  return (
    <details className="result-item">
      <summary>
        <span className="mono">{task.capability}</span>
        <StatusPill value={task.status} />
      </summary>
      <pre className="result-json">{formatResult(task.result)}</pre>
    </details>
  );
}

function formatResult(result: unknown) {
  const rendered = JSON.stringify(result, null, 2) ?? "";
  return rendered.length > 2200 ? `${rendered.slice(0, 2200)}\n...` : rendered;
}

function countTasks(state: ControlPlaneState, status: string) {
  return state.tasks.filter((task) => task.status === status).length;
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected control plane error";
}
