import { redactString, isSensitiveKey } from "./redaction.ts";
import type { Capability } from "./types.ts";

export type FindingDraft = {
  title: string;
  severity: "info" | "low" | "medium";
  summary: string;
};

export function compactEvidenceValue(value: unknown, depth = 0): any {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value).slice(0, 2_000);
  if (typeof value !== "object") return value;
  if (depth > 4) return "[TRUNCATED_DEPTH]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => compactEvidenceValue(item, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 80)
      .map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED_SECRET]" : compactEvidenceValue(item, depth + 1)
      ])
  );
}

export function draftFinding(
  capability: Capability,
  status: "completed" | "failed",
  result?: Record<string, unknown>,
  error?: string
): FindingDraft {
  const label = capabilityLabel(capability);
  if (status === "failed") {
    return {
      title: `${label} collection failed`,
      severity: "medium",
      summary: error || `${label} returned a failed task status.`
    };
  }

  if (result?.available === false) {
    return {
      title: `${label} unavailable`,
      severity: "info",
      summary: stringValue(result.notice) || `${label} was not available on the agent.`
    };
  }

  return {
    title: `${label} evidence collected`,
    severity: "low",
    summary: `${label} completed as a read-only investigation step.`
  };
}

function capabilityLabel(capability: Capability) {
  const [first, ...rest] = capability.split(".");
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}
