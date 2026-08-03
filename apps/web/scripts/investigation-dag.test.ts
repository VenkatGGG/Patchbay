import assert from "node:assert/strict";
import test from "node:test";
import {
  failedNodeAction,
  readyInvestigationNodes,
  blockedInvestigationNodes
} from "../src/lib/investigation-dag.ts";
import type { InvestigationNodeStatus } from "../src/lib/types.ts";

const node = (
  nodeKey: string,
  status: InvestigationNodeStatus = "pending",
  dependsOn: string[] = [],
  attempts = 0
) => ({
  nodeKey,
  status,
  dependsOn,
  attempts,
  maxAttempts: 2
});

test("DAG scheduler returns only nodes whose dependencies completed", () => {
  const ready = readyInvestigationNodes([
    node("node_discover"),
    node("node_system", "pending", ["node_discover"]),
    node("node_process", "pending", ["node_system"])
  ]);

  assert.deepEqual(ready.map(({ nodeKey }) => nodeKey), ["node_discover"]);
});

test("DAG scheduler identifies nodes blocked by failed dependencies", () => {
  const blocked = blockedInvestigationNodes([
    node("node_discover", "failed"),
    node("node_system", "pending", ["node_discover"]),
    node("node_process", "pending", ["node_system"])
  ]);

  assert.deepEqual(blocked.map(({ nodeKey }) => nodeKey), ["node_system"]);
});

test("DAG scheduler retries a failed node until its attempt budget is exhausted", () => {
  assert.equal(failedNodeAction(node("node_system", "failed", [], 1)), "retry");
  assert.equal(failedNodeAction(node("node_system", "failed", [], 2)), "fail");
});
