# Self-Hosted Deployment

Patchbay is deployed as a control plane plus one or more agents inside the
environments being inspected.

```text
Operator browser
      |
      v
Next.js control plane ---- PostgreSQL
      |
      | Tailscale OAuth creates short-lived bootstrap keys
      v
Environment-local Go agents
```

The control plane should be reachable only through a private ingress, VPN, or
an authenticated reverse proxy. Tailscale connectivity protects agent traffic;
the Patchbay operator token and signed agent tokens still enforce application
authorization.

## Prerequisites

- Docker Engine with Compose, or Node.js, pnpm, Go, and PostgreSQL installed
  separately.
- A PostgreSQL database dedicated to Patchbay.
- A Tailscale OAuth client with permission to create tagged device auth keys.
- A tag policy allowing the tags requested by `TAILSCALE_AUTH_KEY_TAGS`.
- A Gemini API key when Gemini planning or synthesis is enabled.

## Compose Deployment

1. Create the local secret envelope and install dependencies:

   ```bash
   pnpm install --frozen-lockfile
   pnpm env:local
   ```

2. Put deployment secrets in `apps/web/.env.local` or in the deployment
   secret store. At minimum, configure:

   ```text
   PATCHBAY_OPERATOR_TOKEN=<operator-token>
   PATCHBAY_ENROLLMENT_SECRET=<enrollment-signing-secret>
   PATCHBAY_AGENT_AUTH_SECRET=<agent-signing-secret>
   TAILSCALE_TAILNET=<tailnet>
   TAILSCALE_OAUTH_CLIENT_ID=<oauth-client-id>
   TAILSCALE_OAUTH_CLIENT_SECRET=<oauth-client-secret>
   GEMINI_API_KEY=<gemini-key>
   ```

   Do not put these values in the repository, Dockerfile, image layers, or
   shell history. `pnpm test:secrets` and `pnpm test:env` validate the tracked
   configuration surface.

3. Start the stack:

   ```bash
   docker compose up --build -d
   ```

   The web container applies migrations before starting. The Compose Postgres
   volume is persistent and must be backed up independently.

4. Check readiness through the private endpoint:

   ```bash
   curl -H "authorization: Bearer $PATCHBAY_OPERATOR_TOKEN" \
     http://localhost:3000/api/ready
   ```

   A production-like deployment should report signed enrollment, signed agent
   authentication, PostgreSQL, Gemini, and Tailscale as ready.

5. Create an environment enrollment token from the dashboard or the operator
   API. The token is single-use and environment-scoped. Start an agent in the
   target environment with:

   ```text
   PATCHBAY_CONTROL_PLANE_URL=https://patchbay.internal
   PATCHBAY_ENVIRONMENT_ID=<environment-id>
   PATCHBAY_AGENT_NAME=<stable-agent-name>
   PATCHBAY_ENROLLMENT_TOKEN=<single-use-enrollment-token>
   PATCHBAY_TAILSCALE_UP=true
   ```

   The agent enrolls, receives a signed API token and a short-lived Tailscale
   bootstrap key, then polls only for capabilities it advertised. The raw
   Tailscale key is used during enrollment and is not persisted in Patchbay;
   only a non-secret key ID and preview are retained.

## Production Posture

- Put TLS and operator authentication in front of the dashboard and API.
- Keep `PATCHBAY_REQUIRE_ENROLLMENT_TOKEN=true` and
  `PATCHBAY_REQUIRE_AGENT_TOKEN=true`.
- Use separate, randomly generated values for the operator, enrollment, and
  agent signing secrets.
- Use a managed or separately backed-up PostgreSQL service for important
  incidents.
- Restrict Tailscale OAuth tag permissions to Patchbay agent and environment
  tags. Do not grant broad device or admin permissions.
- Keep the agent read-only. No capability in this release executes shell,
  writes files, mutates Kubernetes, changes cloud resources, or restarts
  services.
- Do not publish port `3000` directly to the public internet.
- Set `PATCHBAY_ARTIFACT_RETENTION_DAYS` to match the incident-data policy and
  confirm that database backups have the same retention protections.

## Upgrade Procedure

1. Back up PostgreSQL and record the current image or Git revision.
2. Run `pnpm check` in CI, including the Postgres smoke tests.
3. Deploy the new image or revision. The startup command applies idempotent
   migrations before serving traffic.
4. Check `/api/ready`, then run a small read-only investigation against a
   noncritical environment.
5. Roll back the application image only if the new application fails before
   migrations complete. Review migration compatibility before restoring an old
   image after a migration has been applied.

## Tailscale Lifecycle

Patchbay requests auth keys that are tagged, preauthorized, ephemeral,
non-reusable, and limited to 30 minutes. Explicit operator revocation also
deletes the retained auth-key identity through the Tailscale API. If that API
is unavailable, Patchbay still revokes the local agent credential and records
the cleanup failure for recovery.

Deleting an auth key does not guarantee that an already-connected device
vanishes immediately. For an emergency network disconnect, remove or disable
the corresponding ephemeral device in Tailscale, then revoke the Patchbay
agent from the dashboard or `/api/agents/<agent-id>/revoke`.
