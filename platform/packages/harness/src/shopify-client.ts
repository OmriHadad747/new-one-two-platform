import { getSecret } from "@new-one-two/crypto";

interface ShopifyClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  readonly callCount: number;
}

// Cache access tokens to avoid a Secret Manager round-trip per invocation
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getAccessToken(secretName: string): Promise<string> {
  const cached = tokenCache.get(secretName);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }
  const token = await getSecret(secretName);
  tokenCache.set(secretName, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

export async function buildShopifyClient(
  shopDomain: string,
  accessTokenSecretName: string | null
): Promise<ShopifyClient> {
  let callCount = 0;

  // If no access token secret configured (e.g. Phase 2 test), return a stub
  // that logs warnings rather than failing hard.
  if (!accessTokenSecretName) {
    return {
      get: async (path: string) => {
        callCount++;
        console.warn(`[shopify stub] GET ${path} — no access token configured`);
        return {};
      },
      post: async (path: string) => {
        callCount++;
        console.warn(`[shopify stub] POST ${path} — no access token configured`);
        return {};
      },
      get callCount() { return callCount; },
    };
  }

  const accessToken = await getAccessToken(accessTokenSecretName);
  const baseUrl = `https://${shopDomain}/admin/api/2026-01`;

  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": accessToken,
  };

  return {
    async get(path: string): Promise<unknown> {
      callCount++;
      const res = await fetch(`${baseUrl}${path}`, { headers });
      if (!res.ok) throw new Error(`Shopify GET ${path} failed: ${res.status}`);
      return res.json();
    },
    async post(path: string, body: unknown): Promise<unknown> {
      callCount++;
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Shopify POST ${path} failed: ${res.status}`);
      return res.json();
    },
    get callCount() { return callCount; },
  };
}
