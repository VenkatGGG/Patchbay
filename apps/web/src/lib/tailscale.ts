export type TailscaleAuthKey = {
  available: boolean;
  key?: string;
  preview: string;
  tags: string[];
  expiresAt?: string;
};

type TailscaleOAuthToken = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

export async function createAgentAuthKey(environmentId: string): Promise<TailscaleAuthKey> {
  const { tailnet, clientId, clientSecret } = tailscaleConfig();
  const tags = ["tag:patchbay-agent", tailscaleEnvironmentTag(environmentId)];

  if (!tailnet || !clientId || !clientSecret) {
    return {
      available: false,
      preview: "tailscale-disabled-local-dev",
      tags
    };
  }

  const tokenResponse = await fetch("https://api.tailscale.com/api/v2/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  if (!tokenResponse.ok) {
    throw new Error(`Tailscale token request failed: ${tokenResponse.status}`);
  }

  const token = (await tokenResponse.json()) as TailscaleOAuthToken;
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const keyResponse = await fetch(
    `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/keys`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        capabilities: {
          devices: {
            create: {
              reusable: false,
              ephemeral: true,
              preauthorized: true,
              tags
            }
          }
        },
        expirySeconds: 1800,
        description: `Patchbay agent enrollment for ${environmentId}`
      })
    }
  );

  if (!keyResponse.ok) {
    throw new Error(`Tailscale auth key request failed: ${keyResponse.status}`);
  }

  const payload = (await keyResponse.json()) as { key: string };
  return {
    available: true,
    key: payload.key,
    preview: `${payload.key.slice(0, 8)}...${payload.key.slice(-4)}`,
    tags,
    expiresAt
  };
}

export function tailscaleEnvironmentTag(environmentId: string) {
  const normalized = environmentId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `tag:patchbay-${normalized || "environment"}`;
}

export function tailscaleRuntimeStatus() {
  const { tailnet, clientId, clientSecret } = tailscaleConfig();

  return {
    configured: Boolean(tailnet && clientId && clientSecret),
    tailnetConfigured: Boolean(tailnet),
    oauthClientConfigured: Boolean(clientId && clientSecret)
  };
}

function tailscaleConfig() {
  return {
    tailnet: process.env.TAILSCALE_TAILNET?.trim(),
    clientId: process.env.TAILSCALE_OAUTH_CLIENT_ID?.trim(),
    clientSecret: process.env.TAILSCALE_OAUTH_CLIENT_SECRET?.trim()
  };
}
