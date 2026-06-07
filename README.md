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

### Local Secret Envelope

The app reads local secrets from an ignored local envelope file:

```text
apps/web/.env.local
```

Create or backfill it from the tracked template:

```bash
pnpm env:local
```

This generates local-only values for operator auth, enrollment signing, and
agent API token signing without printing those values to the terminal. It leaves
the Gemini key blank until you have it. When you have the key, set:

```text
GEMINI_API_KEY=<your-key>
```

Do not commit `.env.local`; it is ignored by Git. `pnpm test:env` checks that
the tracked `.env.example` keeps every required key present and keeps real
secret values out of the template.

### Operator Token

Local development stays open when `PATCHBAY_OPERATOR_TOKEN` is empty. Set it for
shared or production-like deployments to require a bearer token on operator
control-plane APIs and the dashboard:

```text
PATCHBAY_OPERATOR_TOKEN=<strong-random-token>
```

The dashboard prompts for this token and stores it in local browser storage.
CLI calls can pass it with:

```bash
curl http://localhost:3000/api/state \
  -H "authorization: Bearer $PATCHBAY_OPERATOR_TOKEN"
```

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

Run the self-hosted web stack:

```bash
pnpm env:local
docker compose up --build
```

The compose stack reads `apps/web/.env.local` as an optional secret envelope and
overrides `DATABASE_URL` for the in-network Postgres service. If you deploy from
a shell or CI secret store instead, export the same variables before running
compose. The tracked compose defaults require signed enrollment and signed agent
API tokens.

### Tests

```bash
pnpm check
```

`pnpm check` runs:

- Secret guard for tracked files.
- Env template completeness check.
- Next.js typecheck.
- Next.js production build.
- Go agent tests.
- End-to-end integration smoke test with operator auth, signed enrollment,
  signed agent API tokens, agent diagnostics, report export, and offline Gemini
  synthesis.

Run the same end-to-end test against Postgres:

```bash
pnpm db:up
pnpm test:integration:postgres
```

After `GEMINI_API_KEY` is present in `apps/web/.env.local`, validate the live
Gemini path:

```bash
pnpm test:gemini:live
```

This starts a secured local control plane, checks that readiness reports Gemini
as configured, creates one read-only diagnostic session, and fails unless
synthesis returns the live `gemini:<model>` provider instead of the offline
fallback. The command is intentionally not part of `pnpm check` because it calls
the external Gemini API.

After `TAILSCALE_TAILNET`, `TAILSCALE_OAUTH_CLIENT_ID`, and
`TAILSCALE_OAUTH_CLIENT_SECRET` are present in `apps/web/.env.local`, validate
the live Tailscale path:

```bash
pnpm test:tailscale:live
```

This starts a secured local control plane, checks that readiness reports
Tailscale as configured, and fails unless agent enrollment mints a tagged,
ephemeral, non-reusable Tailscale auth key through the real OAuth API. The
command does not print the auth key and is intentionally not part of
`pnpm check`.

### Readiness Posture

`/api/ready` returns service liveness plus structured readiness checks for
persistence, operator auth, enrollment auth, agent API auth, Gemini, and
Tailscale automation. The dashboard renders the same checks in the Runtime
Posture area so local/demo gaps are visible before production-like use.

### Agent Enrollment Tokens

For local development, enrollment tokens are optional by default. To require
signed environment-scoped tokens:

```bash
PATCHBAY_REQUIRE_ENROLLMENT_TOKEN=true
```

Mint a token:

```bash
curl -X POST http://localhost:3000/api/environments/env_local/enrollment-token \
  -H "authorization: Bearer $PATCHBAY_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"ttlMinutes":60}'
```

Run an agent with the token:

```bash
PATCHBAY_ENROLLMENT_TOKEN=<token> pnpm agent:run
```

### Agent API Tokens

Enrollment tokens are used only to enroll an agent. After enrollment, the
control plane returns a signed agent API token and the Go agent uses it for task
polling and event uploads. The Go agent refreshes this token before expiry while
the current token is still valid.

For local development, post-enrollment agent tokens are optional by default. To
require them:

```bash
PATCHBAY_REQUIRE_AGENT_TOKEN=true
PATCHBAY_AGENT_AUTH_SECRET=<strong-random-secret>
PATCHBAY_AGENT_TOKEN_TTL_MINUTES=1440
```

The TTL defaults to 24 hours and is capped at 7 days.

### Optional Tailscale Bootstrap

If the control plane is configured with Tailscale OAuth credentials, an agent can
join Tailscale automatically after enrollment:

```bash
PATCHBAY_TAILSCALE_UP=true pnpm agent:run
```

This is disabled by default.
