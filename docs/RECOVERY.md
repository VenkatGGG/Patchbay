# Recovery Runbook

Use this runbook when Patchbay or an environment-local agent is unhealthy.
Keep all recovery actions read-only until the incident owner explicitly
approves a separate remediation procedure.

## Control Plane Is Down

1. Check the container and recent logs:

   ```bash
   docker compose ps
   docker compose logs --tail=200 web
   ```

2. Check PostgreSQL health:

   ```bash
   docker compose exec postgres pg_isready -U patchbay -d patchbay
   ```

3. Restart only the web service after confirming the database is healthy:

   ```bash
   docker compose restart web
   ```

4. Verify `/api/health` and `/api/ready`. A web restart does not discard
   PostgreSQL-backed sessions, agents, tasks, findings, or audit history.

## PostgreSQL Failure or Restore

Patchbay keeps operational state in PostgreSQL when `PATCHBAY_STORAGE=postgres`.
Use the database provider's point-in-time recovery where available. For a
logical backup:

```bash
pg_dump --format=custom --file=patchbay-$(date +%Y%m%d-%H%M%S).dump "$DATABASE_URL"
```

After a restore, start the web service so migrations can reconcile the schema,
then run:

```bash
pnpm test:postgres:schema
pnpm test:integration:postgres
```

Do not reuse a backup from an untrusted environment. Database backups contain
incident evidence, findings, audit metadata, and potentially sensitive
operator-visible context, even though raw diagnostic values are redacted before
storage and synthesis.

## Agent Is Offline or Stale

1. Check the agent process and its local logs.
2. Check the agent's `lastSeenAt`, `leaseExpiresAt`, and status in the dashboard.
3. Verify the agent can resolve and reach the private control-plane URL.
4. Verify that the Tailscale CLI is installed and that the node is connected:

   ```bash
   tailscale status
   tailscale status --json
   ```

5. Restart the agent. A stale lease requeues its claimed task so another
   eligible agent can claim it.

If the agent token is expired or revoked, mint a new environment-scoped
enrollment token and re-enroll the agent. Do not copy an existing agent token
between machines.

## Lost or Compromised Agent

1. Revoke the agent immediately from the dashboard or API:

   ```bash
   curl -X POST \
     -H "authorization: Bearer $PATCHBAY_OPERATOR_TOKEN" \
     "https://patchbay.internal/api/agents/<agent-id>/revoke"
   ```

2. Confirm the agent is offline and its credential generation changed.
3. Confirm the audit log contains `agent.revoked` and either
   `agent.tailscale.revoked` or `agent.tailscale.revoke.failed`.
4. If the node is still connected, remove or disable it in the Tailscale admin
   console using its hostname or node ID.
5. Rotate the agent signing secret if the token may have been exposed. This
   invalidates all existing signed agent tokens; re-enroll each legitimate
   agent.

## Tailscale OAuth Failure

Readiness reports Tailscale as degraded when the OAuth settings are incomplete.
For a provider outage or rejected tag policy:

1. Keep Patchbay running in local-authenticated mode if existing agents remain
   trusted; do not issue new enrollment tokens until the network boundary is
   restored.
2. Check the OAuth client, tailnet, and allowed tags in Tailscale.
3. Update the secret store, restart the web service, and verify `/api/ready`.
4. Run `pnpm test:tailscale:fake` before the external smoke test, then run
   `pnpm test:tailscale:live` without printing credentials or auth keys.

An agent that is already enrolled does not need a new auth key for every poll.
New enrollment remains blocked until Tailscale key creation succeeds when the
integration is configured.

## Gemini Failure

Gemini planning and synthesis have bounded timeouts and deterministic offline
fallbacks. A provider outage should not grant new capabilities or execute
actions. Check the `gemini:<model>:offline-fallback` provider label, correct the
API key or quota, and rerun the live Gemini smoke test before relying on live
summaries.

## Secret Rotation

Rotate secrets in the deployment secret store, restart the control plane, and
verify readiness. Separate rotations have these effects:

- Operator token: dashboard and operator API clients must authenticate again.
- Enrollment secret: outstanding enrollment invitations become invalid.
- Agent signing secret: all existing agent API tokens become invalid and agents
  must re-enroll.
- Tailscale OAuth secret: new enrollment and explicit auth-key cleanup pause
  until the new client secret works.
- Gemini API key: planning and synthesis use offline fallback until the new key
  is valid.

Never paste a credential into an issue, chat transcript, task event, audit
metadata, or investigation objective. If a credential was exposed, rotate it
first and treat the old value as compromised.
