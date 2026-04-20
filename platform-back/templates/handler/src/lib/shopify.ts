import {
  shopifyApi,
  LATEST_API_VERSION,
  Session,
  type ShopifyRestResources,
} from "@shopify/shopify-api";
import "@shopify/shopify-api/adapters/node";
import type { PlatformContext } from "../middleware/verify-platform.js";
import { callPlatformService } from "./platform-call.js";

// Per-request Shopify client helper.
//
// Generator call sites look like:
//   const shopify = await shopifyClientFor(req.platform!);
//   const data = await shopify.rest.get("/orders.json?limit=50");
//
// On cron paths (no req) the generator calls shopifyClientFor() with no
// argument; the helper fetches the access token via
// callPlatformService({path: "/services/shopify/access-token"}) on cache
// miss and keeps it in a module-level variable for the lifetime of the
// container. A 401 response from Shopify invalidates the cache and
// triggers one automatic refetch + retry.

const api = shopifyApi({
  // The SDK requires apiKey/apiSecretKey at init even though we use
  // custom-app (access token) sessions — it only actually consumes them
  // for OAuth flows, which platform-back owns.
  apiKey: process.env["SHOPIFY_API_KEY"] ?? "unused-for-custom-app",
  apiSecretKey: process.env["SHOPIFY_API_SECRET"] ?? "unused-for-custom-app",
  scopes: [],
  hostName: "handler.internal",
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
});

// ─── Access-token cache (cron path only) ─────────────────────────────────────

let cachedAccessToken: string | null = null;

async function getAccessToken(hint?: string): Promise<string> {
  // HTTP path — platform-back stamped the token on the request header.
  if (hint) return hint;
  // Cron path — use the cache, refill from platform-back on miss.
  if (cachedAccessToken) return cachedAccessToken;
  const { status, body } = await callPlatformService<{ accessToken: string }>({
    path: "/services/shopify/access-token",
    body: {},
  });
  if (status !== 200 || !body?.accessToken) {
    throw new Error(
      `shopifyClientFor: failed to fetch access token from platform-back (status=${status})`,
    );
  }
  cachedAccessToken = body.accessToken;
  return cachedAccessToken;
}

function invalidateTokenCache(): void {
  cachedAccessToken = null;
}

function makeSession(shopDomain: string, accessToken: string): Session {
  return new Session({
    id: `${shopDomain}-handler`,
    shop: shopDomain,
    state: "",
    isOnline: false,
    accessToken,
  });
}

// ─── Public helper interface ─────────────────────────────────────────────────

export interface ShopifyHelper {
  rest: {
    get(path: string): Promise<unknown>;
    post(path: string, body: Record<string, unknown>): Promise<unknown>;
    delete(path: string): Promise<unknown>;
    paginate(
      path: string,
      query?: Record<string, string | number | boolean>,
    ): AsyncGenerator<unknown[], void, unknown>;
  };
  graphql(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<unknown>;
  graphqlPaginate(
    query: string,
    variables: Record<string, unknown>,
    connectionPath: string,
  ): AsyncGenerator<unknown[], void, unknown>;
  storefront(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface ShopifyClientContext {
  shopDomain: string;
  accessToken?: string;
}

export async function shopifyClientFor(
  platform?: ShopifyClientContext | PlatformContext,
): Promise<ShopifyHelper> {
  const shopDomain = platform?.shopDomain ?? process.env["SHOP_DOMAIN"];
  if (!shopDomain) {
    throw new Error("shopifyClientFor: shopDomain not available");
  }
  const tokenHint = platform?.accessToken;

  // One-shot 401 retry: if the token we used is rejected, invalidate the
  // cache, refetch from platform-back, and run the operation once more.
  async function with401Retry<T>(op: (session: Session) => Promise<T>): Promise<T> {
    let token = await getAccessToken(tokenHint);
    try {
      return await op(makeSession(shopDomain!, token));
    } catch (err: unknown) {
      if (!is401(err)) throw err;
      invalidateTokenCache();
      // Even if the caller passed a hint, it's now known stale — fall through
      // to the service-backed refetch.
      token = await getAccessToken();
      return await op(makeSession(shopDomain!, token));
    }
  }

  // Hoisted so graphqlPaginate can call it without wrestling with
  // method-this binding inside an async generator.
  async function graphqlImpl(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<unknown> {
    return with401Retry(async (session) => {
      const client = new api.clients.Graphql({ session });
      const resp = await client.request<Record<string, unknown>>(query, {
        ...(variables ? { variables } : {}),
      });
      return resp.data;
    });
  }

  return {
    rest: {
      async get(path: string): Promise<unknown> {
        const { pathOnly, query } = splitPath(path);
        return with401Retry(async (session) => {
          const rest = new api.clients.Rest({ session });
          const resp = await rest.get({
            path: pathOnly,
            ...(query ? { query } : {}),
          });
          return resp.body;
        });
      },
      async post(path: string, body: Record<string, unknown>): Promise<unknown> {
        const { pathOnly } = splitPath(path);
        return with401Retry(async (session) => {
          const rest = new api.clients.Rest({ session });
          // The SDK defaults `type` to JSON when `data` is an object —
          // don't pass `type` explicitly to avoid the exactOptional-
          // PropertyTypes mismatch on optional enum fields.
          const resp = await rest.post({ path: pathOnly, data: body });
          return resp.body;
        });
      },
      async delete(path: string): Promise<unknown> {
        const { pathOnly } = splitPath(path);
        return with401Retry(async (session) => {
          const rest = new api.clients.Rest({ session });
          const resp = await rest.delete({ path: pathOnly });
          return resp.body;
        });
      },
      async *paginate(
        path: string,
        query: Record<string, string | number | boolean> = {},
      ): AsyncGenerator<unknown[], void, unknown> {
        const { pathOnly } = splitPath(path);
        const resourceKey = deriveResourceKey(pathOnly);
        const session = makeSession(shopDomain!, await getAccessToken(tokenHint));
        const rest = new api.clients.Rest({ session });

        let resp = await rest.get({
          path: pathOnly,
          query: { limit: 250, ...query },
        });
        while (true) {
          const page = extractArray(resp.body, resourceKey);
          yield page;
          const next = extractNextCursor(resp);
          if (!next) break;
          resp = await rest.get({ path: pathOnly, query: next });
        }
      },
    },

    graphql: graphqlImpl,

    async *graphqlPaginate(
      query: string,
      variables: Record<string, unknown>,
      connectionPath: string,
    ): AsyncGenerator<unknown[], void, unknown> {
      let cursor: string | null = null;
      for (;;) {
        const data = (await graphqlImpl(query, {
          ...variables,
          cursor,
        })) as Record<string, unknown> | null;
        const conn = getByPath(data, connectionPath);
        if (!conn || typeof conn !== "object") {
          throw new Error(
            `shopifyClientFor.graphqlPaginate: connection not found at path "${connectionPath}"`,
          );
        }
        const edges = (conn as Record<string, unknown>)["edges"];
        const pageInfo = (conn as Record<string, unknown>)["pageInfo"] as
          | { hasNextPage?: boolean; endCursor?: string | null }
          | undefined;
        const nodes = Array.isArray(edges)
          ? edges.map((e) => (e as Record<string, unknown>)["node"])
          : [];
        yield nodes;
        if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
        cursor = pageInfo.endCursor;
      }
    },

    async storefront(
      query: string,
      variables?: Record<string, unknown>,
    ): Promise<unknown> {
      // Storefront uses a SEPARATE access token (public, scoped to unauthed
      // shopper context). platform-back mints it at OAuth time alongside the
      // admin access token and exposes it via a dedicated /services/
      // endpoint. Not cached here — storefront usage is rare enough that the
      // extra hop on first call is noise; if that changes, add a sibling
      // cache the same way as the admin token above.
      const { status, body } = await callPlatformService<{
        storefrontAccessToken: string;
      }>({
        path: "/services/shopify/storefront-access-token",
        body: {},
      });
      if (status !== 200 || !body?.storefrontAccessToken) {
        throw new Error(
          `shopifyClientFor.storefront: failed to fetch storefront access token (status=${status})`,
        );
      }
      const url = `https://${shopDomain}/api/${LATEST_API_VERSION}/graphql.json`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": body.storefrontAccessToken,
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
      });
      if (!resp.ok) {
        throw new Error(
          `shopifyClientFor.storefront: fetch failed (status=${resp.status})`,
        );
      }
      const json = (await resp.json()) as {
        data?: unknown;
        errors?: unknown[];
      };
      if (json.errors && json.errors.length > 0) {
        throw new Error(
          `shopifyClientFor.storefront: graphql errors: ${JSON.stringify(json.errors)}`,
        );
      }
      return json.data;
    },
  };
}

// ─── Internals ───────────────────────────────────────────────────────────────

function is401(err: unknown): boolean {
  if (err && typeof err === "object") {
    const anyErr = err as { response?: { code?: number; statusCode?: number }; code?: number };
    if (anyErr.response?.code === 401) return true;
    if (anyErr.response?.statusCode === 401) return true;
    if (anyErr.code === 401) return true;
  }
  return String(err).includes("401");
}

function splitPath(path: string): {
  pathOnly: string;
  query?: Record<string, string>;
} {
  // Accept "/orders.json?status=any", "orders.json?status=any", or
  // "/admin/api/<version>/orders.json?status=any" — the SDK's REST client
  // adds the /admin/api/<version>/ prefix itself, so we strip it here.
  const stripped = path
    .replace(/^\/?admin\/api\/[^/]+\//, "")
    .replace(/^\//, "");
  const qIdx = stripped.indexOf("?");
  if (qIdx === -1) return { pathOnly: stripped };
  const pathOnly = stripped.slice(0, qIdx);
  const params: Record<string, string> = {};
  new URLSearchParams(stripped.slice(qIdx + 1)).forEach((v, k) => {
    params[k] = v;
  });
  return { pathOnly, query: params };
}

function deriveResourceKey(pathOnly: string): string {
  // "orders.json" → "orders"; "orders/123/fulfillments.json" → "fulfillments".
  const leaf = pathOnly.split("/").pop() ?? "";
  return leaf.replace(/\.json$/, "");
}

function extractArray(body: unknown, key: string): unknown[] {
  if (body && typeof body === "object") {
    const v = (body as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function extractNextCursor(
  resp: { pageInfo?: { nextPage?: { query?: unknown } | null } },
): Record<string, string> | null {
  const q = resp.pageInfo?.nextPage?.query;
  if (!q || typeof q !== "object") return null;
  // Normalize to a plain Record<string, string> — SearchParams allows
  // numbers/booleans in values, but as the cursor payload the SDK round-
  // trips back into another rest.get, passing through as-is works even
  // when the declared type is wider than what we keep on our side.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
    out[k] = String(v);
  }
  return out;
}

function getByPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) =>
        o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined,
      obj,
    );
}

// Re-export types so callers can reference without importing from SDK directly.
export type { ShopifyRestResources };
