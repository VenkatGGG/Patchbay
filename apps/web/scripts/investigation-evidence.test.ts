import assert from "node:assert/strict";
import test from "node:test";
import {
  compactEvidenceValue,
  draftFinding
} from "../src/lib/investigation-evidence.ts";

test("evidence compaction redacts secrets and bounds nested payloads", () => {
  const compacted = compactEvidenceValue({
    API_KEY: "secret-value",
    lines: Array.from({ length: 200 }, (_, index) => `line-${index}`)
  });

  assert.equal(compacted.API_KEY, "[REDACTED_SECRET]");
  assert.equal(compacted.lines.length, 50);
});

test("finding drafts distinguish unavailable and failed read-only evidence", () => {
  assert.deepEqual(
    draftFinding("docker.containers", "completed", {
      available: false,
      notice: "docker CLI not found"
    }),
    {
      title: "Docker containers unavailable",
      severity: "info",
      summary: "docker CLI not found"
    }
  );
  assert.deepEqual(
    draftFinding("system.info", "failed", undefined, "collector failed"),
    {
      title: "System info collection failed",
      severity: "medium",
      summary: "collector failed"
    }
  );
});
