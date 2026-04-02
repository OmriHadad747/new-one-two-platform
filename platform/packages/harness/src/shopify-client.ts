import { getSecret } from "@new-one-two/crypto";

interface ShopifyClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
  readonly callCount: number;
}

// In-memory token cache keyed by shopDomain.
// Entries are refreshed when < REFRESH_WINDOW_MS remains before expiry.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const REFRESH_WINDOW_MS = 5 * 60 * 1000; // refresh 5 min before actual expiry

/**
 * Obtains a valid Shopify Admin API access token via the OAuth 2.0
 * client_credentials grant. Tokens expire in ~24 h (expires_in = 86399).
 * The result is cached in-process; a new grant is only issued when the
 * cached token is within REFRESH_WINDOW_MS of expiry.
 */
async function getAccessToken(
  shopDomain: string,
  clientId: string,
  clientSecretName: string
): Promise<string> {
  const cached = tokenCache.get(shopDomain);
  if (cached && Date.now() < cached.expiresAt - REFRESH_WINDOW_MS) {
    return cached.token;
  }

  const clientSecret = await getSecret(clientSecretName);

  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify token refresh failed [${res.status}]: ${body}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = Date.now() + data.expires_in * 1000;
  tokenCache.set(shopDomain, { token: data.access_token, expiresAt });
  return data.access_token;
}

export async function buildShopifyClient(
  shopDomain: string,
  clientId: string | null,
  clientSecretName: string | null
): Promise<ShopifyClient> {
  let callCount = 0;

  // If no client credentials configured (e.g. backend-only apps), return a
  // stub that warns rather than failing hard.
  if (!clientId || !clientSecretName) {
    return {
      get: async (path: string) => {
        callCount++;
        console.warn(`[shopify stub] GET ${path} — no client credentials configured`);
        return {};
      },
      post: async (path: string) => {
        callCount++;
        console.warn(`[shopify stub] POST ${path} — no client credentials configured`);
        return {};
      },
      graphql: async (query: string) => {
        callCount++;
        console.warn(`[shopify stub] graphql — no client credentials configured\n${query}`);
        return {};
      },
      get callCount() { return callCount; },
    };
  }

  const baseUrl = `https://${shopDomain}/admin/api/2026-01`;

  return {
    async get(path: string): Promise<unknown> {
      callCount++;
      const token = await getAccessToken(shopDomain, clientId, clientSecretName);
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      });
      if (!res.ok) throw new Error(`Shopify GET ${path} failed: ${res.status}`);
      return res.json();
    },
    async post(path: string, body: unknown): Promise<unknown> {
      callCount++;
      const token = await getAccessToken(shopDomain, clientId, clientSecretName);
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Shopify POST ${path} failed: ${res.status}`);
      return res.json();
    },
    async graphql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
      callCount++;
      const token = await getAccessToken(shopDomain, clientId, clientSecretName);
      const res = await fetch(`${baseUrl}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) throw new Error(`Shopify GraphQL failed: ${res.status}`);
      const json = (await res.json()) as { data?: unknown; errors?: unknown[] };
      if (json.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
      return json.data;
    },
    get callCount() { return callCount; },
  };
}
