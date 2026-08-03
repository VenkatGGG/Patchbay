import { z } from "zod";
import { READ_ONLY_CAPABILITIES } from "./types.ts";
import type { Capability } from "./types.ts";

const planNodeId = z.string().regex(/^node_[a-z0-9_]+$/);

export const investigationPlanNodeSchema = z.object({
  id: planNodeId,
  capability: z.enum(READ_ONLY_CAPABILITIES),
  params: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(planNodeId).default([]),
  rationale: z.string().trim().min(1).max(500)
});

export const investigationPlanSchema = z
  .object({
    version: z.literal(1),
    title: z.string().trim().min(1).max(120),
    objective: z.string().trim().min(1).max(2_000),
    nodes: z.array(investigationPlanNodeSchema).min(1).max(32)
  })
  .superRefine((plan, context) => {
    const ids = new Set<string>();
    for (const [index, node] of plan.nodes.entries()) {
      if (ids.has(node.id)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: `duplicate node id ${node.id}`
        });
      }
      ids.add(node.id);
    }

    const nodesById = new Map(plan.nodes.map((node) => [node.id, node]));
    for (const [index, node] of plan.nodes.entries()) {
      for (const dependency of node.dependsOn) {
        if (!nodesById.has(dependency)) {
          context.addIssue({
            code: "custom",
            path: ["nodes", index, "dependsOn"],
            message: `unknown dependency ${dependency}`
          });
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string): boolean => {
      if (visiting.has(nodeId)) {
        return true;
      }
      if (visited.has(nodeId)) {
        return false;
      }

      visiting.add(nodeId);
      const node = nodesById.get(nodeId);
      const hasCycle = node?.dependsOn.some((dependency) => visit(dependency)) ?? false;
      visiting.delete(nodeId);
      visited.add(nodeId);
      return hasCycle;
    };

    for (const node of plan.nodes) {
      if (visit(node.id)) {
        context.addIssue({
          code: "custom",
          path: ["nodes"],
          message: "investigation plan contains a dependency cycle"
        });
        break;
      }
    }
  });

export type InvestigationPlan = z.infer<typeof investigationPlanSchema>;
export type InvestigationPlanNode = InvestigationPlan["nodes"][number];

export type OfflinePlannerInput = {
  objective?: string;
  capabilities?: readonly Capability[];
};

const plannerOrder: readonly Capability[] = [...READ_ONLY_CAPABILITIES];

export function validateInvestigationPlan(input: unknown): InvestigationPlan {
  return investigationPlanSchema.parse(input);
}

export function enforcePlanCapabilities(
  plan: InvestigationPlan,
  capabilities: readonly Capability[]
): InvestigationPlan {
  const allowed = new Set(capabilities);
  for (const node of plan.nodes) {
    if (!allowed.has(node.capability)) {
      throw new Error(`Plan capability ${node.capability} is not allowed`);
    }
  }
  return validateInvestigationPlan(plan);
}

export function buildOfflineInvestigationPlan(
  input: OfflinePlannerInput = {}
): InvestigationPlan {
  const objective = input.objective?.trim() || "Investigate the active incident";
  const available = new Set(input.capabilities ?? READ_ONLY_CAPABILITIES);
  const selected = plannerOrder.filter((capability) => available.has(capability));

  if (selected.length === 0) {
    throw new Error("No supported read-only capabilities are available for planning");
  }

  const discoveryId = nodeIdFor("workload.discover");
  const nodes = selected.map((capability) => ({
    id: nodeIdFor(capability),
    capability,
    params: defaultCapabilityParams(capability),
    dependsOn:
      capability === "workload.discover" || !available.has("workload.discover")
        ? []
        : [discoveryId],
    rationale: rationaleFor(capability)
  }));

  return validateInvestigationPlan({
    version: 1,
    title: `Read-only investigation: ${objective}`.slice(0, 120),
    objective,
    nodes
  });
}

export function defaultCapabilityParams(
  capability: Capability
): Record<string, unknown> {
  switch (capability) {
    case "logs.search":
      return {
        pattern: "timeout|latency|connection|pool|error",
        paths: []
      };
    case "cloud.metadata":
      return { timeoutMs: 800 };
    case "process.list":
      return { limit: 40 };
    case "network.connections":
      return { limit: 60 };
    case "docker.containers":
      return { limit: 60 };
    case "kubernetes.resources":
      return { namespaces: "all", limit: 80 };
    default:
      return {};
  }
}

function nodeIdFor(capability: Capability) {
  return `node_${capability.replaceAll(".", "_")}`;
}

function rationaleFor(capability: Capability) {
  switch (capability) {
    case "workload.discover":
      return "Establish which workload surfaces and read-only tools are visible on the agent.";
    case "cloud.metadata":
      return "Identify cloud placement and instance metadata without reading application secrets.";
    case "system.info":
      return "Capture host identity and runtime context for evidence correlation.";
    case "process.list":
      return "Check for process-level symptoms associated with the incident objective.";
    case "disk.usage":
      return "Check filesystem pressure that could affect workload latency or availability.";
    case "network.connections":
      return "Inspect bounded established connections for connectivity symptoms.";
    case "logs.search":
      return "Search explicitly configured log paths for bounded incident-related matches.";
    case "docker.containers":
      return "Inspect container state when Docker visibility is available.";
    case "kubernetes.resources":
      return "Inspect cluster resources and recent events when Kubernetes visibility is available.";
  }
}
