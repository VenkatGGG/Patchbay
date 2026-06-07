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

## Defense In Depth

Network layer:

- Tailscale private connectivity.
- Tagged machine identities.
- No public inbound agent port.
- Short-lived auth keys where possible.

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
- Keep `GEMINI_API_KEY`, `PATCHBAY_OPERATOR_TOKEN`, and
  `PATCHBAY_AGENT_AUTH_SECRET` in ignored local or deployment secret stores.
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
