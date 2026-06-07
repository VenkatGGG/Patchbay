# Patchbay

Patchbay is a self-hosted, multi-agent incident debugging platform for SRE and
on-call teams. It creates session-scoped, read-only diagnostic workflows inside
customer environments and uses Tailscale as the private connectivity layer.

The v0 goal is narrow:

- Multi-agent session orchestration from day one.
- Read-only diagnostics only.
- Go agents that expose explicit capabilities.
- A TypeScript/Next.js control plane.
- Pluggable LLM synthesis, with Gemini as the first provider.
- Automated Tailscale setup as part of the product model.

Patchbay is not "SSH with an AI prompt." The product boundary is the session,
policy, audit, capability, and evidence workflow around infrastructure
debugging.

## Repository Layout

```text
apps/web/          Next.js control plane and UI
agent/             Go diagnostic agent
docs/              Product, architecture, and security notes
```

## First Demo Scenario

The initial demo will focus on an on-call latency investigation:

1. Start a read-only debug session.
2. Assign diagnostics to multiple agents.
3. Stream task events back to the control plane.
4. Summarize evidence with Gemini.
5. Export an auditable incident report.

No remediation actions execute in v0.

## Development

Prerequisites:

- Node.js and pnpm
- Go
- A Gemini API key for LLM synthesis
- Tailscale credentials when testing the full network integration

The local prototype can run without a real Tailscale tailnet while the
integration boundary is developed.

### Local Postgres

```bash
pnpm db:up
pnpm db:migrate
PATCHBAY_STORAGE=postgres pnpm dev
```

The default local database URL is:

```text
postgres://patchbay:patchbay@localhost:5432/patchbay
```
