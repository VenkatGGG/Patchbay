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
import { ControlPlaneState, DebugSession } from "@/lib/types";

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
  const [isBusy, setIsBusy] = useState(false);

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
  const latestSynthesis = selectedSession
    ? state.syntheses
        .filter((synthesis) => synthesis.sessionId === selectedSession.id)
        .at(-1)
    : undefined;

  async function refresh() {
    const response = await fetch("/api/state", { cache: "no-store" });
    setState(await response.json());
  }

  async function createSession() {
    if (!selectedEnvironment) return;
    setIsBusy(true);
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
      const session = (await response.json()) as DebugSession;
      setSelectedSessionId(session.id);
      await refresh();
    } finally {
      setIsBusy(false);
    }
  }

  async function runDiagnostic() {
    if (!selectedSession) return;
    setIsBusy(true);
    try {
      await fetch(`/api/sessions/${selectedSession.id}/diagnostics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: "latency_spike" })
      });
      await refresh();
    } finally {
      setIsBusy(false);
    }
  }

  async function synthesize() {
    if (!selectedSession) return;
    setIsBusy(true);
    try {
      await fetch(`/api/sessions/${selectedSession.id}/synthesize`, {
        method: "POST"
      });
      await refresh();
    } finally {
      setIsBusy(false);
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
            <button className="button secondary" type="button" onClick={refresh}>
              <RefreshCcw size={16} />
              Refresh
            </button>
            <button
              className="button"
              type="button"
              onClick={runDiagnostic}
              disabled={!selectedSession || isBusy}
            >
              <Activity size={16} />
              Run Latency Diagnostic
            </button>
            <button
              className="button"
              type="button"
              onClick={synthesize}
              disabled={!selectedSession || isBusy}
            >
              <Sparkles size={16} />
              Synthesize
            </button>
          </div>
        </div>

        <div className="grid">
          <div className="stack">
            <Panel
              icon={<Network size={17} />}
              title="Environment"
              subtitle={selectedEnvironment?.name ?? "No environment"}
            >
              <div className="metric-grid">
                <Metric label="Agents" value={state.agents.length} />
                <Metric label="Sessions" value={state.sessions.length} />
                <Metric label="Queued Tasks" value={countTasks(state, "queued")} />
                <Metric label="Events" value={state.events.length} />
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
                  disabled={isBusy || !selectedEnvironment}
                >
                  Start Session
                </button>
              </div>
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
                        <td>{agent.capabilities.length}</td>
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
                      <strong>{event.message}</strong>
                      <p className="mono">{event.taskId}</p>
                    </div>
                  ))
                )}
              </div>
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

function countTasks(state: ControlPlaneState, status: string) {
  return state.tasks.filter((task) => task.status === status).length;
}

