# Security Model

Patchbay is shaped like remote infrastructure access software, so the default
security posture must be conservative.

## v0 Security Boundary

v0 is read-only.

Allowed:

- Host and OS metadata.
- Process listing.
- Disk usage.
- Network connection listing.
- Log search from configured paths.

Denied:

- Shell execution.
- File writes.
- Secret reads.
- Service restarts.
- Deployment rollbacks.
- Kubernetes mutations.
- Database writes.

Remediation gate:

- No remediation capability namespace exists in v0.
- The control plane does not expose restart, rollback, delete, shell, or write
  routes.
- Future write actions must use a separate capability namespace and require an
  explicit security review, operator approval, idempotency, and rollback plan.

## Defense In Depth

Network layer:

- Tailscale private connectivity.
- Tagged machine identities.
- No public inbound agent port.
- Short-lived auth keys where possible.
- Explicit agent revocation also attempts to delete the associated Tailscale
  auth key; cleanup failures are recorded without delaying local credential
  invalidation.
- Tailscale device removal remains an operator recovery action because deleting
  a bootstrap auth key does not necessarily disconnect an already-enrolled
  ephemeral node immediately.

Control plane:

- Optional operator bearer token for dashboard and human-operated APIs.
- Optional signed agent bearer token requirement for task polling and event
  uploads.
- Signed agent tokens carry an expiry; the default TTL is 24 hours and the
  configured maximum is capped at 7 days.
- Signed enrollment and agent tokens must be exactly two-segment HMAC envelopes;
  appended token segments and extra bearer header words are rejected.
- Agents can refresh signed API tokens before expiry, but expired tokens are
  rejected and require re-enrollment.
- Task event ingestion verifies the signed agent identity is assigned to the
  task being updated.
- Terminal task states cannot be rewritten by later agent events.
- Session expiration and explicit operator close.
- Closed or expired sessions reject late task event writes.
- Capability allowlists.
- Task audit log.
- Environment-scoped agents.
- Provider-based LLM integration.
- JSON API request bodies are capped by `PATCHBAY_MAX_JSON_BODY_BYTES`, which
  defaults to 1 MiB and is bounded to a maximum of 10 MiB.

Agent:

- Local policy guard.
- Explicit capability registry.
- Command timeouts.
- Bounded output.
- Redaction before upload.

LLM:

- Redacted evidence only.
- Structured synthesis output.
- No direct executor access.

## Secret Handling

Patchbay should assume diagnostics may accidentally observe sensitive data.

Minimum requirements:

- Redact common token patterns before evidence leaves the agent.
- Redact common token patterns again before LLM synthesis, report export, and
  dashboard diagnostic rendering.
- Treat env-style, YAML/JSON-style, and camelCase secret key forms as sensitive.
- Never send raw secrets to Gemini.
- Keep `GEMINI_API_KEY`, `PATCHBAY_OPERATOR_TOKEN`,
  `PATCHBAY_ENROLLMENT_SECRET`, and `PATCHBAY_AGENT_AUTH_SECRET` in ignored local
  or deployment secret stores.
- Keep `TAILSCALE_OAUTH_CLIENT_ID`, `TAILSCALE_OAUTH_CLIENT_SECRET`, and
  `TAILSCALE_TAILNET` in the same protected secret/configuration store. The
  OAuth client should be restricted to the minimum Patchbay tag permissions.
- Required enrollment and agent authentication modes must fail closed when
  their dedicated signing secret is empty; signing secrets are never shared
  across those authentication boundaries.
- Authentication configuration is validated before enrollment persists an
  agent or requests a Tailscale key. Public failures use a sanitized HTTP 503
  response rather than exposing configuration names or values.
- Use `pnpm env:local` to create the ignored `apps/web/.env.local` envelope
  with generated local signing tokens before adding real provider credentials.
- Keep artifact retention configurable with `PATCHBAY_ARTIFACT_RETENTION_DAYS`;
  old task result payloads, task events, and syntheses are pruned while
  session/task metadata and audit history are preserved.
- Make persistence optional for self-hosted deployments.

Initial redaction targets:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `GITHUB_TOKEN`
- `DATABASE_URL`
- Bearer tokens
- Kubernetes service account tokens
- Private key blocks

Operational recovery procedures are documented in
[`docs/RECOVERY.md`](./RECOVERY.md). In particular, revoke a lost agent at the
Patchbay boundary first, then remove its Tailscale device if it remains
connected.
