import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const expectedCapabilities = [
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
const expectedGoSymbols = new Map([
  ["workload.discover", "CapabilityWorkloadDiscover"],
  ["cloud.metadata", "CapabilityCloudMetadata"],
  ["system.info", "CapabilitySystemInfo"],
  ["process.list", "CapabilityProcessList"],
  ["disk.usage", "CapabilityDiskUsage"],
  ["network.connections", "CapabilityNetworkConnections"],
  ["logs.search", "CapabilityLogsSearch"],
  ["docker.containers", "CapabilityDockerContainers"],
  ["kubernetes.resources", "CapabilityKubernetesResources"]
]);
const forbiddenCapabilityMarkers = [
  "shell.exec",
  "file.write",
  "secret.read",
  "service.restart",
  "deployment.rollback",
  "remediation.",
  "kubernetes.delete",
  "database.write"
];
const forbiddenRouteMarkers = [
  "remediation",
  "rollback",
  "restart",
  "mutate",
  "shell",
  "write",
  "delete"
];
const failures = [];
const typesSource = readText("apps/web/src/lib/types.ts");
const protocolSource = readText("agent/internal/protocol/protocol.go");
const registrySource = readText("agent/internal/capabilities/registry.go");
const productSource = readText("docs/PRODUCT.md");
const securitySource = readText("docs/SECURITY.md");
const readmeSource = readText("README.md");

const capabilityBlock = typesSource.match(
  /READ_ONLY_CAPABILITIES\s*=\s*\[([\s\S]*?)\]\s+as const/
);
const actualCapabilities = capabilityBlock
  ? [...capabilityBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
  : [];
if (JSON.stringify(actualCapabilities) !== JSON.stringify(expectedCapabilities)) {
  failures.push(
    `READ_ONLY_CAPABILITIES changed: expected ${expectedCapabilities.join(", ")}, got ${actualCapabilities.join(", ")}`
  );
}

for (const capability of expectedCapabilities) {
  if (!protocolSource.includes(`"${capability}"`)) {
    failures.push(`Go protocol is missing read-only capability ${capability}`);
  }
  if (!registrySource.includes(expectedGoSymbols.get(capability))) {
    failures.push(`Go registry is missing read-only capability ${capability}`);
  }
}

for (const marker of forbiddenCapabilityMarkers) {
  if (typesSource.includes(`"${marker}`) || protocolSource.includes(`"${marker}`)) {
    failures.push(`forbidden capability marker found: ${marker}`);
  }
}

const routeRoot = join(root, "apps/web/src/app/api");
for (const route of collectFiles(routeRoot)) {
  const routeName = relative(routeRoot, route).toLowerCase();
  for (const marker of forbiddenRouteMarkers) {
    if (routeName.includes(marker)) {
      failures.push(`forbidden mutation route found: apps/web/src/app/api/${routeName}`);
    }
  }
}

for (const [label, source, markers] of [
  ["README", readmeSource, ["No remediation actions execute in v0."]],
  ["product brief", productSource, ["Out of scope for v0:", "Autonomous remediation."]],
  ["security model", securitySource, ["v0 is read-only.", "Database writes."]]
]) {
  for (const marker of markers) {
    if (!source.includes(marker)) {
      failures.push(`${label} is missing read-only boundary marker: ${marker}`);
    }
  }
}

if (!readText("apps/web/src/components/control-plane-dashboard.tsx").includes("Remediation deferred")) {
  failures.push("dashboard is missing the remediation deferred indicator");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Read-only boundary check passed.");

function readText(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectFiles(path));
    } else if (entry === "route.ts") {
      files.push(path);
    }
  }
  return files;
}
