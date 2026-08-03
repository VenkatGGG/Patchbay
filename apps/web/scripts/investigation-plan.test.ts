import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOfflineInvestigationPlan,
  validateInvestigationPlan
} from "../src/lib/investigation-plan.ts";

test("offline planner emits a stable read-only dependency graph", () => {
  const plan = buildOfflineInvestigationPlan({ objective: "Investigate API latency" });

  assert.equal(plan.version, 1);
  assert.equal(plan.objective, "Investigate API latency");
  assert.deepEqual(
    plan.nodes.map((node) => node.capability),
    [
      "workload.discover",
      "cloud.metadata",
      "system.info",
      "process.list",
      "disk.usage",
      "network.connections",
      "logs.search",
      "docker.containers",
      "kubernetes.resources"
    ]
  );
  assert.deepEqual(plan.nodes[1]?.dependsOn, ["node_workload_discover"]);
  assert.deepEqual(plan.nodes.at(-1)?.dependsOn, ["node_workload_discover"]);
});

test("offline planner only selects capabilities available to the agent pool", () => {
  const plan = buildOfflineInvestigationPlan({
    capabilities: ["workload.discover", "system.info"]
  });

  assert.deepEqual(
    plan.nodes.map((node) => node.capability),
    ["workload.discover", "system.info"]
  );
});

test("plan validation rejects unknown dependencies and cycles", () => {
  assert.throws(
    () =>
      validateInvestigationPlan({
        version: 1,
        title: "Invalid",
        objective: "Test",
        nodes: [
          {
            id: "node_one",
            capability: "system.info",
            params: {},
            dependsOn: ["node_missing"],
            rationale: "Test"
          }
        ]
      }),
    /unknown dependency/i
  );

  assert.throws(
    () =>
      validateInvestigationPlan({
        version: 1,
        title: "Invalid",
        objective: "Test",
        nodes: [
          {
            id: "node_one",
            capability: "system.info",
            params: {},
            dependsOn: ["node_two"],
            rationale: "Test"
          },
          {
            id: "node_two",
            capability: "process.list",
            params: {},
            dependsOn: ["node_one"],
            rationale: "Test"
          }
        ]
      }),
    /cycle/i
  );
});
