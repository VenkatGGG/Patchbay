# Multi-Agent Foundation Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with focused tests and one meaningful commit per task. Do not dispatch subagents unless a task becomes genuinely independent.

**Goal:** Make Patchbay a reliable, workload-open, multi-agent read-only investigation platform with Gemini-assisted planning and a self-hosted PostgreSQL control plane.

**Architecture:** The Next.js control plane owns sessions, authorization, scheduling, evidence, persistence, and LLM policy enforcement. Go agents advertise capability packs and execute only server-authorized read-only capabilities. Gemini may propose a validated plan, but never executes work or bypasses server-side policy.

**Tech Stack:** TypeScript/Next.js, PostgreSQL migrations, Go agents, Tailscale connectivity, Gemini provider, deterministic offline fallbacks.

## Status

Completed and pushed on `codex/multi-agent-foundation`:

- Capability task scheduling, atomic claiming, leases, stale-task requeue, and
  audit transitions.
- Open Go workload-pack metadata with structured unavailable-tool results for
  host, cloud metadata, Docker, and Kubernetes capabilities.
- Validated offline/Gemini investigation planning with capability enforcement,
  redaction, strict JSON parsing, timeout handling, and fallback behavior.
- Persisted investigation plans, dependency-aware DAG execution, retries,
  blocked descendants, evidence artifacts, findings, and synthesis references.
- Operator views for investigation progress, agent leases, findings, and
  evidence.
- Tailscale auth-key timeout bounds, non-secret key identity persistence, and
  explicit auth-key cleanup on agent revocation with fail-closed local access.
- Deployment and recovery runbooks plus a two-agent release scenario wired into
  the standard check gate.

Remaining verification or product follow-up:

- Run the live PostgreSQL migration and integration suite when a Docker daemon
  is available locally; CI already runs the same Postgres checks.
- Run live Gemini and Tailscale validations only with rotated credentials in an
  external secret store. The repository contains fake-provider tests for both.
- Future product work: OAuth setup UI, direct Tailscale device removal hooks,
  broader workload packs, multi-tenant identity, and controlled remediation.

## Global Constraints

- Keep the platform open to host, Docker, Kubernetes, AWS, GCP, and future workload packs.
- Preserve read-only behavior; no shell execution, service restarts, deploy rollbacks, Kubernetes mutations, or cloud mutations in this phase.
- Keep provider and workload-pack interfaces pluggable; Gemini is the first configured provider.
- Preserve memory-store behavior for local development and PostgreSQL behavior for deployment.
- Run focused tests before each commit, then push to `origin/codex/multi-agent-foundation`.
- Never place API keys, OAuth secrets, or agent tokens in source, logs, fixtures, or commits.

## Execution Sequence

1. [pending] Verify the live PostgreSQL migration and integration suite after Docker is available. Fix only failures found by that gate.
2. [completed] Refactor diagnostic creation and task claiming so one capability task is claimable by one eligible agent, with atomic PostgreSQL claiming.
3. [completed] Add configurable agent leases and heartbeat refresh during polling; mark stale agents offline and audit the transition.
4. [completed] Requeue tasks from stale agents and let another eligible agent claim them without losing event history.
5. [completed] Formalize the Go workload-pack contract and capability metadata while keeping the task protocol stable.
6. [completed] Complete structured read-only host, Docker, and Kubernetes workload packs with unavailable-tool results and bounded redacted output.
7. [completed] Add a schema-validated investigation-plan contract and deterministic offline planner.
8. [completed] Persist investigations and dependency-aware plan nodes in PostgreSQL.
9. [completed] Add Gemini-backed planning with strict JSON validation, redaction, timeout handling, offline fallback, and server-side capability enforcement.
10. [completed] Execute plans as a dependency-aware DAG with idempotent task creation, retries, and failure propagation.
11. [completed] Persist structured findings and evidence lineage separately from raw task events.
12. [completed] Feed plan state, findings, and evidence references into Gemini synthesis and the offline synthesis provider.
13. [completed] Add operator views for plan progress, agent leases, task reassignment, evidence, findings, and synthesis.
14. [completed] Harden Tailscale lifecycle and publish the self-hosted deployment, security, and recovery runbooks.
15. [in progress] Add a complete two-agent incident scenario and run the full release verification suite.

## First Implementation Commit

**Commit:** `refactor: schedule capability tasks across agents`

**Files:** `apps/web/src/lib/store.ts`, `apps/web/src/lib/types.ts`, `apps/web/db/schema.sql`, `apps/web/db/migrations/0005_task_assignment_pool.sql`, and focused integration tests.

**Acceptance criteria:** Diagnostic creation creates one queued task per desired capability instead of duplicating work across every agent. Agent polling claims only tasks matching the caller's capabilities. PostgreSQL claiming is atomic and uses row locking so concurrent agents cannot claim the same task. Existing event authorization, task timeout, session expiry, and idempotency behavior remain intact.

**Verification:** Run the new scheduler regression test, `pnpm test:integration`, `pnpm web:typecheck`, `pnpm test:migrations`, `pnpm test:schema`, `pnpm agent:test`, and `git diff --check` before committing.
