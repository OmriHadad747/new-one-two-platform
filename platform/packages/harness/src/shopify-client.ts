import { getSecret } from "@new-one-two/crypto";
import type { ShopifyAdminClient, ShopifyStorefrontClient } from "@new-one-two/types";

// ─── Admin API client ─────────────────────────────────────────────────────────

// ShopifyAdminClient and ShopifyStorefrontClient interfaces are defined in
// @new-one-two/types so HandlerContext can reference them without a circular dep.
// callCount is tracked locally inside each builder for harness-internal metrics.

// The offline access token is provisioned once during the merchant's OAuth
// install (see apps/api/src/routes/oauth.ts) and stored in Secret Manager.
// It's long-lived — only invalidated when the merchant uninstalls — so we
// resolve it once per process and cache the promise. Keyed by secret name
// so a process that ever resolves two distinct tenants doesn't cross-wire
// tokens.
const _accessTokenCache = new Map<string, Promise<string>>();

function resolveAccessToken(accessTokenSecretName: string): Promise<string> {
  const cached = _accessTokenCache.get(accessTokenSecretName);
  if (cached) return cached;
  const pending = getSecret(accessTokenSecretName).catch((err: unknown) => {
    _accessTokenCache.delete(accessTokenSecretName);
    throw err;
  });
  _accessTokenCache.set(accessTokenSecretName, pending);
  return pending;
}

export function buildShopifyAdminClient(
  shopDomain: string,
  accessTokenSecretName: string | null
): ShopifyAdminClient & { readonly callCount: number } {
  let callCount = 0;

  // No tenant access token wired (install never completed, or dev-only app).
  // Return a stub that warns rather than failing hard.
  if (!accessTokenSecretName) {
    async function* emptyPaginator(): AsyncGenerator<unknown[], void, unknown> {
      callCount++;
      console.warn(`[shopify stub] paginate — no client credentials configured`);
      // yield nothing; async generator terminates immediately
    }
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
      delete: async (path: string) => {
        callCount++;
        console.warn(`[shopify stub] DELETE ${path} — no client credentials configured`);
        return {};
      },
      graphql: async (query: string) => {
        callCount++;
        console.warn(`[shopify stub] graphql — no client credentials configured\n${query}`);
        return {};
      },
      paginate: emptyPaginator,
      paginateGql: emptyPaginator,
      get callCount() { return callCount; },
    };
  }

  const baseUrl = `https://${shopDomain}/admin/api/2026-01`;

  return {
    async get(path: string): Promise<unknown> {
      callCount++;
      const token = await resolveAccessToken(accessTokenSecretName);
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      });
      if (!res.ok) throw new Error(`Shopify GET ${path} failed: ${res.status}`);
      return res.json();
    },
    async post(path: string, body: unknown): Promise<unknown> {
      callCount++;
      const token = await resolveAccessToken(accessTokenSecretName);
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Shopify POST ${path} failed: ${res.status}`);
      return res.json();
    },
    async delete(path: string): Promise<unknown> {
      callCount++;
      const token = await resolveAccessToken(accessTokenSecretName);
      const res = await fetch(`${baseUrl}${path}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      });
      if (!res.ok) throw new Error(`Shopify DELETE ${path} failed: ${res.status}`);
      // DELETE responses are often 200 with a body or 204 with no body
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    },
    async graphql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
      callCount++;
      const token = await resolveAccessToken(accessTokenSecretName);
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
    paginate(
      path: string,
      params: Record<string, string | number | boolean> = {},
    ): AsyncGenerator<unknown[], void, unknown> {
      return paginateRestImpl(path, params, accessTokenSecretName, baseUrl, () => { callCount++; });
    },
    paginateGql(
      query: string,
      variables: Record<string, unknown>,
      connectionPath: string,
    ): AsyncGenerator<unknown[], void, unknown> {
      return paginateGqlImpl(query, variables, connectionPath, accessTokenSecretName, baseUrl, () => { callCount++; });
    },
    get callCount() { return callCount; },
  };
}

// ─── REST cursor pagination (Link header) ────────────────────────────────────

/**
 * Parse a Shopify `Link` header and return the `page_info` cursor for
 * rel="next", or null if there is no next page.
 *
 * Example header:
 *   <https://x.myshopify.com/admin/api/2026-01/orders.json?limit=250&page_info=abc>; rel="next"
 */
function extractNextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  // Shopify returns comma-separated entries; find the one with rel="next"
  for (const entry of linkHeader.split(",")) {
    const match = entry.match(/<([^>]+)>;\s*rel="next"/);
    if (match) {
      try {
        const url = new URL(match[1]!);
        return url.searchParams.get("page_info");
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Derive the resource key from a Shopify REST list path.
 *   /orders.json                         → "orders"
 *   /products/123/variants.json          → "variants"
 *   /customers.json?status=any           → "customers"
 * The body shape for every list endpoint is `{ "<resource>": [...] }`.
 */
function resourceKeyFromPath(path: string): string {
  const noQuery = path.split("?")[0] ?? path;
  const last = noQuery.split("/").filter(Boolean).pop() ?? "";
  return last.replace(/\.json$/, "");
}

function buildQueryString(params: Record<string, string | number | boolean>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : "";
}

async function* paginateRestImpl(
  path: string,
  params: Record<string, string | number | boolean>,
  accessTokenSecretName: string,
  baseUrl: string,
  bumpCallCount: () => void,
): AsyncGenerator<unknown[], void, unknown> {
  const resource = resourceKeyFromPath(path);
  const limit = params.limit ?? 250;
  // First request: caller's filter params + limit. Subsequent requests: ONLY
  // limit + page_info — Shopify rejects filter params on cursor calls.
  let url = `${baseUrl}${path.split("?")[0]}${buildQueryString({ ...params, limit })}`;
  while (true) {
    bumpCallCount();
    const token = await resolveAccessToken(accessTokenSecretName);
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    });
    if (!res.ok) throw new Error(`Shopify GET ${path} (paginate) failed: ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const batch = (body[resource] as unknown[]) ?? [];
    yield batch;

    const nextPageInfo = extractNextPageInfo(res.headers.get("link"));
    if (!nextPageInfo) return;
    url = `${baseUrl}${path.split("?")[0]}${buildQueryString({ limit, page_info: nextPageInfo })}`;
  }
}

// ─── GraphQL cursor pagination (pageInfo/endCursor) ──────────────────────────

/**
 * Walk a dot-path like "products" or "customer.orders" into a GraphQL response
 * to locate the Relay connection node ({ edges, pageInfo }).
 * Returns null if any segment is missing.
 */
function walkPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const segment of path.split(".")) {
    if (cur && typeof cur === "object" && segment in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[segment];
    } else {
      return null;
    }
  }
  return cur;
}

async function* paginateGqlImpl(
  query: string,
  variables: Record<string, unknown>,
  connectionPath: string,
  accessTokenSecretName: string,
  baseUrl: string,
  bumpCallCount: () => void,
): AsyncGenerator<unknown[], void, unknown> {
  let cursor: string | null = null;
  while (true) {
    bumpCallCount();
    const token = await resolveAccessToken(accessTokenSecretName);
    const res = await fetch(`${baseUrl}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables: { ...variables, cursor } }),
    });
    if (!res.ok) throw new Error(`Shopify GraphQL (paginateGql) failed: ${res.status}`);
    const json = (await res.json()) as { data?: unknown; errors?: unknown[] };
    if (json.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);

    const connection = walkPath(json.data, connectionPath) as
      | { edges?: { node: unknown }[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
      | null;
    if (!connection) {
      throw new Error(`paginateGql: connectionPath "${connectionPath}" not found in response`);
    }
    const nodes = (connection.edges ?? []).map((e) => e.node);
    yield nodes;

    if (!connection.pageInfo?.hasNextPage) return;
    cursor = connection.pageInfo.endCursor ?? null;
    if (!cursor) return;
  }
}

// ─── Storefront API client ────────────────────────────────────────────────────

// Storefront API token — created at OAuth time, stored in Secret Manager,
// injected by the deployer as STOREFRONT_TOKEN_SECRET_NAME.
const STOREFRONT_TOKEN_SECRET_NAME = process.env["STOREFRONT_TOKEN_SECRET_NAME"] ?? "";

// Resolved once per process lifetime — the token is long-lived.
let _storefrontTokenPromise: Promise<string> | null = null;

function resolveStorefrontToken(): Promise<string> {
  if (!_storefrontTokenPromise) {
    const p: Promise<string> = STOREFRONT_TOKEN_SECRET_NAME
      ? getSecret(STOREFRONT_TOKEN_SECRET_NAME)
      : Promise.reject(
          new Error(
            "Storefront API not available — no storefront token was provisioned during merchant install. " +
            "Re-install the app to provision one."
          )
        );
    // Suppress unhandled-rejection until first actual call.
    p.catch(() => undefined);
    _storefrontTokenPromise = p;
  }
  return _storefrontTokenPromise;
}

// ShopifyStorefrontClient is imported from @new-one-two/types — re-export for convenience.
export type { ShopifyStorefrontClient } from "@new-one-two/types";

export function buildShopifyStorefrontClient(shopDomain: string): ShopifyStorefrontClient {
  return {
    async graphql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
      const token = await resolveStorefrontToken();
      const res = await fetch(
        `https://${shopDomain}/api/2026-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Storefront-Access-Token": token,
          },
          body: JSON.stringify({ query, variables }),
        }
      );
      const json = (await res.json()) as { data?: unknown; errors?: unknown[] };
      if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
      return json.data;
    },
  };
}
