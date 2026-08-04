# Operations And Read-Only Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an environment-safe Tailscale setup surface, production deployment safeguards, and automated enforcement that Patchbay remains read-only.

**Architecture:** The dashboard reads the existing `/api/ready` runtime contract and presents Tailscale configuration state without accepting or persisting OAuth secrets. Production deployment remains Docker Compose based, with Caddy as an optional HTTPS edge, health checks, backup scripts, and managed-Postgres guidance. A repository check validates the capability namespace and denied operation policy so remediation cannot enter the v0 task path accidentally.

**Tech Stack:** Next.js/React, TypeScript, CSS, Docker Compose, Caddy, PostgreSQL CLI, Node.js check scripts, Go capability registry.

## Global Constraints

- Tailscale OAuth secrets remain environment/deployment-secret-store only; never persist them in Postgres, browser storage, task events, or logs.
- The HTTPS edge is optional for local development and must not change the internal web service contract.
- Production defaults require operator auth, signed enrollment, signed agent API tokens, Postgres, and private ingress.
- v0 remains read-only: no shell execution, file writes, secret reads, restarts, rollbacks, Kubernetes mutations, database writes, or remediation namespace.
- Use existing project patterns, focused tests, `apply_patch`, and one meaningful commit per milestone.

### Task 1: Tailscale Setup Surface

**Files:**
- Modify: `apps/web/src/components/control-plane-dashboard.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `README.md`
- Test: `scripts/integration/ui-smoke.mjs`

**Interfaces:**
- Consumes: `RuntimeStatus.tailscale` and readiness check `tailscale` from `/api/ready`.
- Produces: Dashboard “Network Setup” panel with configured state, tailnet visibility, tag guidance, timeout, and deployment-runbook link. No new secret-writing API.

- [ ] Add a UI smoke assertion for the Tailscale setup panel and remediation-deferred indicator.
- [ ] Run `pnpm test:ui` and verify the new assertions fail before the panel exists.
- [ ] Render the panel from existing readiness data, showing only booleans, tailnet display value, configured tags, and `TAILSCALE_TIMEOUT_MS` guidance; do not render OAuth client secrets.
- [ ] Add responsive styles that fit the existing dashboard layout and retain keyboard focus behavior.
- [ ] Update README setup instructions with the panel’s environment-only secret boundary.
- [ ] Run `pnpm test:ui`, `pnpm web:typecheck`, and `pnpm web:build`.
- [ ] Commit as `feat: add Tailscale setup surface` and push the branch.

### Task 2: Production Deployment Safeguards

**Files:**
- Create: `docker-compose.production.yml`
- Create: `ops/Caddyfile`
- Create: `scripts/ops/backup-postgres.mjs`
- Create: `scripts/ops/restore-postgres.mjs`
- Create: `scripts/checks/production-deployment.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `.env.example`
- Test: `scripts/checks/production-deployment.mjs`

**Interfaces:**
- Consumes: Existing web image, Compose environment variables, `DATABASE_URL`, and Postgres CLI tools.
- Produces: Optional `docker compose -f docker-compose.yml -f docker-compose.production.yml up -d` deployment, Caddy HTTPS boundary, health checks, and explicit backup/restore commands.

- [ ] Add a check fixture/test that fails when the production overlay omits health checks, private web binding, required auth defaults, or the backup scripts.
- [ ] Run `pnpm test:production-deployment` and verify it fails before the production overlay/check exists.
- [ ] Add the production Compose overlay with Caddy on `80/443`, web bound to loopback, health checks, and no secret defaults.
- [ ] Add Caddy configuration that proxies only to the internal web service and redirects HTTP to HTTPS when a domain is configured.
- [ ] Add backup and restore scripts that require an explicit `DATABASE_URL` and destination/source path, refuse empty paths, and never print credentials.
- [ ] Add managed-Postgres, backup, TLS, and restore guidance to the deployment docs and tracked env template.
- [ ] Run `pnpm test:production-deployment`, `pnpm test:compose`, `pnpm test:docker`, and `git diff --check`.
- [ ] Commit as `feat: add production deployment safeguards` and push the branch.

### Task 3: Read-Only Scope Guard

**Files:**
- Create: `scripts/checks/read-only-boundary.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/PRODUCT.md`
- Modify: `docs/SECURITY.md`
- Modify: `apps/web/src/components/control-plane-dashboard.tsx`

**Interfaces:**
- Consumes: `READ_ONLY_CAPABILITIES`, Go registry declarations, API route tree, and product/security scope documents.
- Produces: A deterministic check that rejects mutation-like capability names or routes and a dashboard indicator that remediation is deferred.

- [ ] Add failing boundary assertions for the current capability list, route list, and denied-operation markers.
- [ ] Run `pnpm test:read-only-boundary` and verify it fails before the check exists.
- [ ] Implement the static boundary check with explicit allowed capabilities and denied operation markers.
- [ ] Add the check to `pnpm check` and document that remediation requires a separate approved milestone.
- [ ] Add a compact dashboard scope indicator without creating remediation controls.
- [ ] Run `pnpm test:read-only-boundary`, `pnpm test:secrets`, `pnpm web:typecheck`, and `pnpm web:build`.
- [ ] Commit as `guard: enforce read-only v0 scope` and push the branch.

### Task 4: Final Verification

**Files:**
- Modify: `docs/superpowers/plans/2026-08-03-operations-and-read-only-guardrails.md`

- [ ] Run `pnpm check` and the production deployment check.
- [ ] Run `docker compose -f docker-compose.yml -f docker-compose.production.yml config` without starting the production edge.
- [ ] Run `git diff --check` and verify the worktree is clean.
- [ ] Record verification results and remaining external prerequisites in this plan.
- [ ] Commit as `docs: record operations verification` and push the branch.
