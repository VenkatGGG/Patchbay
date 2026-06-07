export type TailscaleAuthKey = {
  available: boolean;
  id?: string;
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

export class TailscaleIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TailscaleIntegrationError";
  }
}

export async function createAgentAuthKey(environmentId: string): Promise<TailscaleAuthKey> {
  const { apiBaseUrl, tailnet, clientId, clientSecret } = tailscaleConfig();
  const tags = ["tag:patchbay-agent", tailscaleEnvironmentTag(environmentId)];

  if (!tailnet || !clientId || !clientSecret) {
    return {
      available: false,
      preview: "tailscale-disabled-local-dev",
      tags
    };
  }

  const tokenResponse = await tailscaleFetch(
    tailscaleApiUrl(apiBaseUrl, "/api/v2/oauth/token"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret
      })
    },
    "token"
  );

  if (!tokenResponse.ok) {
    throw new TailscaleIntegrationError(
      `Tailscale token request failed: ${tokenResponse.status}`
    );
  }

  const token = await tailscaleJson<TailscaleOAuthToken>(tokenResponse, "token");
  if (!token.access_token) {
    throw new TailscaleIntegrationError(
      "Tailscale token response did not include access_token"
    );
  }

  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const keyResponse = await tailscaleFetch(
    tailscaleApiUrl(apiBaseUrl, `/api/v2/tailnet/${encodeURIComponent(tailnet)}/keys`),
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
    },
    "auth key"
  );

  if (!keyResponse.ok) {
    throw new TailscaleIntegrationError(
      `Tailscale auth key request failed: ${keyResponse.status}`
    );
  }

  const payload = await tailscaleJson<{
    id?: string;
    key: string;
  }>(keyResponse, "auth key");
  if (!payload.key) {
    throw new TailscaleIntegrationError(
      "Tailscale auth key response did not include key"
    );
  }

  return {
    available: true,
    id: payload.id,
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
    apiBaseUrl: (
      process.env.TAILSCALE_API_BASE_URL?.trim() || "https://api.tailscale.com"
    ).replace(/\/+$/u, ""),
    tailnet: process.env.TAILSCALE_TAILNET?.trim(),
    clientId: process.env.TAILSCALE_OAUTH_CLIENT_ID?.trim(),
    clientSecret: process.env.TAILSCALE_OAUTH_CLIENT_SECRET?.trim()
  };
}

function tailscaleApiUrl(apiBaseUrl: string, path: string) {
  return `${apiBaseUrl}${path}`;
}

async function tailscaleFetch(
  url: string,
  init: RequestInit,
  label: string
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new TailscaleIntegrationError(
      `Tailscale ${label} request failed before response`
    );
  }
}

async function tailscaleJson<T>(response: Response, label: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new TailscaleIntegrationError(
      `Tailscale ${label} response was not valid JSON`
    );
  }
}
