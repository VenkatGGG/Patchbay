import { ControlPlaneState, DebugSession, DiagnosticTask } from "./types";
import { redactValue } from "./redaction";

export function buildSessionReport(
  session: DebugSession,
  state: ControlPlaneState
) {
  const agentsById = new Map(state.agents.map((agent) => [agent.id, agent]));
  const tasks = state.tasks.filter((task) => task.sessionId === session.id);
  const events = state.events.filter((event) => event.sessionId === session.id);
  const syntheses = state.syntheses.filter(
    (synthesis) => synthesis.sessionId === session.id
  );
  const latestSynthesis = syntheses.at(-1);
  const taskCounts = summarizeTasks(tasks);
  const completedTasks = tasks.filter(
    (task) => task.status === "completed" && task.result !== undefined
  );

  const lines = [
    "# Patchbay Session Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Session",
    "",
    `- Name: ${session.name}`,
    `- ID: ${session.id}`,
    `- Status: ${session.status}`,
    `- Environment: ${session.environmentId}`,
    `- Requested by: ${session.requestedBy}`,
    `- Mode: ${session.mode}`,
    `- Created: ${session.createdAt}`,
    `- Expires: ${session.expiresAt}`,
    "",
    "## Coverage",
    "",
    `- Agents in environment: ${
      state.agents.filter((agent) => agent.environmentId === session.environmentId).length
    }`,
    `- Tasks: ${tasks.length}`,
    `- Completed: ${taskCounts.completed}`,
    `- Running: ${taskCounts.running}`,
    `- Queued: ${taskCounts.queued}`,
    `- Failed: ${taskCounts.failed}`,
    `- Events: ${events.length}`,
    `- Syntheses: ${syntheses.length}`,
    "",
    "## Tasks",
    "",
    "| Capability | Agent | Status | Completed |",
    "| --- | --- | --- | --- |",
    ...tasks.map((task) => taskRow(task, agentsById.get(task.agentId)?.name)),
    ""
  ];

  if (latestSynthesis) {
    lines.push(
      "## Latest Synthesis",
      "",
      `Provider: ${latestSynthesis.provider}`,
      "",
      latestSynthesis.summary,
      ""
    );
  }

  if (completedTasks.length > 0) {
    lines.push("## Diagnostic Payloads", "");
    for (const task of completedTasks) {
      lines.push(
        `### ${task.capability}`,
        "",
        `- Agent: ${agentsById.get(task.agentId)?.name ?? task.agentId}`,
        `- Status: ${task.status}`,
        "",
        "```json",
        renderResult(task.result),
        "```",
        ""
      );
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function summarizeTasks(tasks: DiagnosticTask[]) {
  return {
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length
  };
}

function taskRow(task: DiagnosticTask, agentName?: string) {
  return `| ${markdownCell(task.capability)} | ${markdownCell(
    agentName ?? task.agentId
  )} | ${markdownCell(task.status)} | ${markdownCell(task.completedAt ?? "")} |`;
}

function markdownCell(value: string) {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function renderResult(result: unknown) {
  const rendered = JSON.stringify(redactValue(result), null, 2) ?? "null";
  return rendered.length > 6000 ? `${rendered.slice(0, 6000)}\n...` : rendered;
}
