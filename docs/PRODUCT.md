# Patchbay Product Brief

## Target User

Patchbay is for SRE and on-call teams that need fast, controlled visibility into
production-like systems during incidents.

The first user is technical and operationally responsible. They care less about
generic chat and more about trustworthy evidence, bounded permissions, and clear
audit trails.

## Core Promise

Debug production from inside the network without opening the network.

Patchbay installs lightweight agents into an environment, starts temporary
debugging sessions, runs policy-scoped read-only diagnostics, streams evidence
to a control plane, and lets an LLM synthesize the findings.

## MVP Scope

v0 is intentionally read-only.

Supported workflow:

1. Register an environment.
2. Enroll multiple agents.
3. Start a debug session.
4. Dispatch read-only diagnostic tasks.
5. Stream events and artifacts.
6. Ask Gemini to summarize the evidence.
7. Export a session report.

The first implementation should be workload-open rather than environment-bound.
Patchbay should not assume Kubernetes, cloud, Docker, or a specific VM layout.
Agents discover what they can inspect, report capabilities, and receive only
tasks they explicitly support.

Out of scope for v0:

- Shell execution.
- Rollbacks.
- Restarts.
- Kubernetes deletes.
- Secret reads.
- Autonomous remediation.

## First Incident Scenario

The first end-to-end scenario is a latency spike investigation. It is broadly
useful, easy to demonstrate, and maps well to multi-agent evidence collection.

Example question:

```text
Why did checkout latency spike in prod?
```

Example task fanout:

- `system.info`: host and runtime context.
- `process.list`: hot or recently changed processes.
- `disk.usage`: disk saturation signals.
- `network.connections`: connection pressure.
- `logs.search`: timeout and connection pool patterns.

Example synthesis:

```text
Patchbay found elevated timeout errors, increased connection counts, and a
recent deploy marker. The most likely cause is connection pool exhaustion.
```

## Product Principles

- Session-scoped authority beats permanent broad access.
- Capabilities beat raw shell access.
- Evidence comes before LLM conclusions.
- The LLM can recommend, but cannot execute privileged actions.
- Auditability is part of the product, not an enterprise add-on.
- Tailscale is the connectivity substrate, not the whole product.
