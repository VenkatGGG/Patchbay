# Architecture

Patchbay is a self-hosted control plane plus one or more environment-local Go
agents. Tailscale provides private connectivity and machine identity. Patchbay
owns product authorization, task policy, audit, evidence handling, and LLM
synthesis.

## High-Level Shape

```text
User
  |
  v
Next.js Control Plane
  |-- sessions
  |-- agents
  |-- tasks
  |-- audit
  |-- Gemini synthesis
  |
  v
Tailscale Integration
  |-- auth key creation
  |-- tagged node identity
  |-- session-scoped enrollment
  |
  v
Go Agents
  |-- capability registry
  |-- local policy guard
  |-- read-only collectors
  |-- event streaming
```

## Control Plane

The control plane is implemented as a TypeScript/Next.js app for the initial
self-hosted project.

Responsibilities:

- Environment registry.
- Agent registry.
- Debug session lifecycle.
- Task dispatch.
- Event ingestion.
- Audit log.
- LLM provider abstraction.
- Tailscale automation boundary.
- Operator authentication for dashboard and human API access.
- Signed agent API tokens for polling and event ingestion.

For v0, the control plane can use an in-memory store for local development. The
data model should stay close to what a later Postgres implementation needs.

Operator authentication is disabled when `PATCHBAY_OPERATOR_TOKEN` is empty so a
single developer can run the local prototype quickly. When the token is set,
dashboard and operator API requests must send it as a bearer token. Agent
enrollment and task polling remain on their own protocol path.

Agent enrollment uses an environment-scoped enrollment token. The enrollment
response includes a signed, expiring agent API token, which the Go agent uses for
task polling and event ingestion. `PATCHBAY_REQUIRE_AGENT_TOKEN=true` enforces
this post-enrollment token path; local development can leave it disabled. Agents
refresh their signed API token through an authenticated agent endpoint before
expiry. Task event ingestion also verifies the authenticated agent owns the task
before accepting status or result updates.

## Agent

The agent is a Go process deployed inside each target environment.

Responsibilities:

- Enroll with the control plane.
- Report capabilities.
- Poll for assigned tasks.
- Enforce local read-only policy.
- Execute diagnostics.
- Stream task events and results.

The agent exposes capabilities rather than arbitrary commands.

Initial capabilities:

- `workload.discover`
- `cloud.metadata`
- `system.info`
- `process.list`
- `disk.usage`
- `network.connections`
- `logs.search`
- `docker.containers`
- `kubernetes.resources`

Capabilities are grouped into workload packs. A workload pack can be present but
unavailable on a specific machine; for example, the Docker pack should return a
read-only "docker not available" result instead of failing enrollment.

Initial workload packs:

- Host: OS, process, disk, network, and log diagnostics.
- Cloud host: safe AWS, GCP, and Azure metadata detection without querying
  credential or user-data endpoints.
- Docker: container inventory and status.
- Kubernetes: pods, deployments, events, and node-level inventory.

Future packs should use the same task/event protocol for ECS, EC2, CloudWatch,
GCE, GKE, Cloud Logging, databases, queues, and service meshes.

## Session Model

Every task belongs to a debug session.

```text
DebugSession
  id
  name
  environment_id
  mode = read_only
  requested_by
  status
  expires_at
  allowed_capabilities
```

Agents should reject work outside an active session.

## Tailscale Model

Patchbay should automate Tailscale rather than requiring users to hand-wire the
network every time.

Target model:

1. User configures Tailscale OAuth credentials in the self-hosted control plane.
2. Patchbay creates tagged, short-lived auth keys for agents.
3. Agents join with session or environment-scoped identity.
4. Patchbay tears down access after the session or environment expires.

Tags should distinguish agents, environments, and future coordinators:

```text
tag:patchbay-agent
tag:patchbay-env-prod
tag:patchbay-session
```

Tailscale controls network reachability. Patchbay still performs capability and
session authorization.

## LLM Provider

The LLM layer is provider-based. Gemini is the first implementation, but the
control plane should select providers through a registry rather than direct SDK
calls from routes.

The LLM receives redacted evidence and emits structured synthesis:

- Summary.
- Evidence list.
- Likely causes.
- Recommended next diagnostic steps.

The LLM does not receive raw secrets and does not directly execute actions.

Provider contract:

```text
LLMProvider
  id
  display_name
  configured()
  synthesize(session, evidence)
```

The fallback provider must stay available for local development and tests.
