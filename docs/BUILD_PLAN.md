# Build Plan

Patchbay should stay open to many infrastructure shapes without turning every
agent into a privileged remote shell. The platform extension points are:

- LLM providers in the control plane.
- Agent capability packs in the Go runtime.
- Workload adapters that describe what kind of machine or workload an agent can
  inspect.

## Milestone 1: Open Diagnostic Core

Goal: one control plane can coordinate many agents across different workload
types.

Deliverables:

- Provider-based LLM interface with Gemini as the first provider.
- Stable evidence payload for synthesis.
- Agent-reported capability list.
- Workload discovery capability.
- Read-only host, Docker, and Kubernetes collectors.
- Diagnostic planner that only queues capabilities an agent reports.

Done when:

- A local agent can enroll and report host/Docker/Kubernetes visibility.
- A session can fan out workload discovery plus latency diagnostics.
- The UI can show the resulting tasks and synthesis.

## Milestone 2: Persistent Self-Hosted Control Plane

Goal: make local demos survive process restarts and prepare for real deployment.

Deliverables:

- Postgres schema for environments, agents, sessions, tasks, events, audit, and
  syntheses.
- Repository layer behind the current in-memory store.
- Docker Compose for web, database, and optional local agent.
- Signed agent enrollment token.
- Basic organization/user model for self-hosted single-tenant use.

## Milestone 3: Tailscale Automation

Goal: agents can join private networks automatically while Patchbay keeps
authorization at the capability/session layer.

Deliverables:

- Tailscale OAuth credential setup screen.
- Tagged, ephemeral auth key creation.
- Agent bootstrap response with auth key and tag metadata.
- Agent-side `tailscale up` helper behind an explicit config flag.
- Session/environment teardown hooks.

## Milestone 4: Workload Packs

Goal: add new workload support without changing the session/task protocol.

Initial packs:

- Host pack: OS, processes, disk, network, logs.
- Docker pack: containers, images, recent container logs.
- Kubernetes pack: pods, deployments, events, node pressure.
- Cloud pack later: AWS ECS/EC2/CloudWatch and GCP GCE/GKE/Cloud Logging.

Each pack must declare:

- Capabilities.
- Required local tools or credentials.
- Read-only policy.
- Output redaction rules.
- Failure behavior when unavailable.

## Milestone 5: Safer Intelligence Layer

Goal: LLMs help investigate without becoming an executor.

Deliverables:

- Provider registry with Gemini, OpenAI, Anthropic, and local/providerless
  fallback.
- Evidence compaction and redaction before provider calls.
- Structured synthesis result with summary, evidence, likely causes, and next
  diagnostics.
- Planner prompt that can request read-only capabilities only.
- Human-readable incident report export.

## Milestone 6: Controlled Remediation

Goal: add write actions only after the read-only investigation loop is solid.

Deliverables:

- Separate remediation capability namespace.
- Explicit approval model.
- Policy checks before every action.
- Dry-run previews.
- Post-action verification tasks.

Out of scope until this milestone:

- Shell execution.
- Service restarts.
- Deploy rollbacks.
- Kubernetes mutations.
- Cloud mutations.

