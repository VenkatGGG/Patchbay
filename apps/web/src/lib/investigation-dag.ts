import type { InvestigationNodeStatus } from "./types";

export type SchedulableInvestigationNode = {
  nodeKey: string;
  status: InvestigationNodeStatus;
  dependsOn: string[];
  attempts: number;
  maxAttempts: number;
};

export function readyInvestigationNodes<T extends SchedulableInvestigationNode>(
  nodes: readonly T[]
): T[] {
  const byKey = new Map(nodes.map((node) => [node.nodeKey, node]));
  return nodes.filter(
    (node) =>
      node.status === "pending" &&
      node.dependsOn.every((dependency) => byKey.get(dependency)?.status === "completed")
  );
}

export function blockedInvestigationNodes<T extends SchedulableInvestigationNode>(
  nodes: readonly T[]
): T[] {
  const byKey = new Map(nodes.map((node) => [node.nodeKey, node]));
  return nodes.filter(
    (node) =>
      node.status === "pending" &&
      node.dependsOn.some((dependency) => {
        const dependencyNode = byKey.get(dependency);
        return dependencyNode?.status === "failed" || dependencyNode?.status === "blocked";
      })
  );
}

export function failedNodeAction(
  node: Pick<SchedulableInvestigationNode, "attempts" | "maxAttempts">
): "retry" | "fail" {
  return node.attempts < node.maxAttempts ? "retry" : "fail";
}
