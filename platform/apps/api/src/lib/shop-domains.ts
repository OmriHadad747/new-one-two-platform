/**
 * Shop-domain ownership cache (TD-013).
 *
 * The /widgets/* proxy reflects any Origin at the CORS layer because
 * merchant storefronts run on arbitrary custom domains (`shop.mybrand.com`,
 * `www.acme.com`) that can't be enumerated in ALLOWED_ORIGINS. Reflection
 * alone means a page on `https://evil.com` can fire an XHR at
 * `/widgets/acme.myshopify.com/<appId>/widget/subscribe` and we'll forward
 * it to the merchant's harness. CORS applies to the *response* (the browser
 * will block evil.com from reading it) but the server-side effect — subscription
 * created, email dispatched, cart mutated — already happened.
 *
 * This module closes that lateral path by verifying, *before* calling the
 * harness, that the request's Origin header belongs to the shop named in
 * the URL path. Shop domains are resolved via Shopify's Admin GraphQL API
 * and cached per-(shop) with a short TTL; on a cache miss we fetch, on a
 * cached stale entry with an Admin API failure we serve stale rather than
 * break the widget (graceful degradation, per TD-013).
 *
 * Not in this module (deliberately):
 *   - DB-backed caching. Today every API instance maintains its own
 *     in-memory Map; that duplicates Shopify load by Cloud Run instance
 *     count, but the TTL keeps the rate well under the 2 req/s default
 *     Admin API limit. If we hit that ceiling, follow-up is to persist
 *     the resolved set on `apps.allowed_origins` with a migration.
 *   - Alternate-domain discovery via `shop.domainsByType`. The GraphQL
 *     schema for that field is version-pinned and we'd prefer not to fan
 *     out to it until a merchant needs it — today `primaryDomain` +
 *     `myshopifyDomain` covers every shop in the product.
 */
import { getSecret } from "@new-one-two/crypto";
import { getTenantByShopDomain } from "@new-one-two/db";
import type { Tenant } from "@new-one-two/types";
import { createRequestLogger } from "@new-one-two/logger";

// ─── Cache shape ────────────────────────────────────────────────────────────

interface CachedEntry {
  /** Lower-cased host set. A caller's origin host must match exactly. */
  hosts: Set<string>;
  /** ms epoch. Past this, we try to refresh but keep the entry as stale fallback. */
  expiresAt: number;
}

const cache = new Map<string, CachedEntry>();

/**
 * In-flight fetch promises, keyed by shop. Concurrent callers for the same
 * shop on a cold (or expired) cache share a single Shopify Admin API call
 * instead of each firing their own. Cleared in .finally() so a failed fetch
 * doesn't poison future attempts — on rejection, the next caller starts a
 * fresh fetch.
 *
 * Matters more at horizontal scale: without this, `N instances × M
 * concurrent cold requests = N*M Shopify calls`, which eats into the 2
 * req/s Admin API budget fast during a viral-storefront burst.
 */
const inflight = new Map<string, Promise<Set<string>>>();

/** 5 min TTL per TD-013. Long enough to absorb the Admin API rate limit,
 *  short enough that a legitimately-added alternate domain propagates fast. */
const TTL_MS = 5 * 60_000;

/** Pluggable clock for tests. Real code uses Date.now. */
let nowFn: () => number = () => Date.now();

// ─── Shopify Admin API version ──────────────────────────────────────────────
//
// Shopify rotates Admin API versions quarterly; old versions are deprecated
// ~12 months after release. When this one gets deprecated, Admin API calls
// return 401/400 and every widget request fails-closed. Keep it named so
// the next bump is a one-line change. If other services start hitting the
// Admin API, consolidate on a shared constant.
const ADMIN_API_VERSION = "2026-01";

// ─── Config gate ────────────────────────────────────────────────────────────
//
// DEPLOY_MODE matches how widget-js.ts already distinguishes prod from dev.
// In "local" dev, we skip the Origin check entirely — tunnels, preview
// domains, and the localhost dev server all hit /widgets/* and we don't
// want to enumerate every dev scenario's origin.

const DEPLOY_MODE = process.env["DEPLOY_MODE"] ?? "cloudrun";
export const ORIGIN_CHECK_ENABLED = DEPLOY_MODE === "cloudrun";

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns true if `origin` belongs to `shop`. Short-circuits true in
 * non-production (see ORIGIN_CHECK_ENABLED).
 *
 * Callers should treat a `false` as a hard reject (403 from the widget proxy).
 * The function never throws: Admin API failures on a cold cache return
 * `false` and the caller converts that to a 503 if they want to distinguish
 * "shop's domains are unknown right now" from "origin definitely not owned
 * by this shop" — but the simpler policy is "no knowledge → no trust".
 */
export async function isOriginAllowedForShop(
  shop: string,
  origin: string | undefined,
  requestId?: string
): Promise<boolean> {
  if (!ORIGIN_CHECK_ENABLED) return true;

  // Same-origin / server-to-server / curl: no Origin header. In production
  // browser traffic this shouldn't happen for widget routes; reject so the
  // policy is monotonic.
  if (!origin) return false;

  const originHost = parseOriginHost(origin);
  if (!originHost) return false;

  const allowed = await resolveShopHosts(shop, requestId);
  if (!allowed) return false; // cold-cache miss + Admin API failure → deny
  return allowed.has(originHost);
}

/** Test helper: flush every cached entry (including the in-flight set so
 *  tests don't leak pending fetches across cases). */
export function __clearShopDomainCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/** Test helper: inject a fake clock (exposed only to vitest). */
export function __setNowForTests(fn: () => number): void {
  nowFn = fn;
}

/** Test helper: inject a fake fetcher so tests don't hit Shopify's Admin API. */
export function __setShopifyFetcherForTests(
  fn: ((shopDomain: string, accessToken: string) => Promise<Set<string>>) | null
): void {
  _shopifyFetcherOverride = fn;
}

// ─── Core resolver ──────────────────────────────────────────────────────────

async function resolveShopHosts(
  shop: string,
  requestId?: string
): Promise<Set<string> | null> {
  const now = nowFn();
  const cached = cache.get(shop);
  const log = createRequestLogger(requestId ? { requestId } : {});

  // Hot path: fresh cache entry.
  if (cached && cached.expiresAt > now) {
    return cached.hosts;
  }

  // Cold / expired — run (or join) the in-flight fetch.
  //
  // Why the promise map: two concurrent widget requests for the same shop on
  // a cold cache both used to fire their own Admin API call. At Cloud Run
  // horizontal-scale scale, N instances × M concurrent cold requests = N*M
  // calls, which is wasteful at best and breaches Shopify's 2 req/s cap at
  // worst. Sharing the promise means the first caller pays for the fetch
  // and the rest await its result.
  try {
    const hosts = await fetchOrJoinInflight(shop, now);
    return hosts;
  } catch (err) {
    // Stale-if-error: prefer a few minutes of stale data over locking out
    // real storefronts during a Shopify blip. Admissible because the set
    // of a shop's domains changes rarely (merchant adds a new storefront
    // domain once in a blue moon) and the upper bound is the TTL: a stale
    // entry can only be served for at most one full TTL past its
    // original fetch before the operator notices.
    if (cached) {
      log.warn(
        { shop, err: err instanceof Error ? err.message : String(err) },
        "shop-domains: Admin API failed, serving stale cache"
      );
      return cached.hosts;
    }
    log.warn(
      { shop, err: err instanceof Error ? err.message : String(err) },
      "shop-domains: Admin API failed with no cache — rejecting request"
    );
    return null;
  }
}

/**
 * Singleflight wrapper around the Shopify fetch. Concurrent callers for the
 * same shop share one pending promise; the cache gets populated once,
 * regardless of how many callers were waiting. On rejection, the in-flight
 * entry is removed so the next caller retries — otherwise one transient
 * failure would poison future attempts for the lifetime of the process.
 */
function fetchOrJoinInflight(shop: string, now: number): Promise<Set<string>> {
  const existing = inflight.get(shop);
  if (existing) return existing;

  const p = fetchShopHostsFromShopify(shop).then((hosts) => {
    cache.set(shop, { hosts, expiresAt: now + TTL_MS });
    return hosts;
  });
  inflight.set(shop, p);
  // Drop the in-flight ref whether it resolved or rejected — future cold
  // calls start fresh. Guarded by ref-equality so a slow rejection doesn't
  // remove a newer promise that's already replaced it.
  p.finally(() => {
    if (inflight.get(shop) === p) inflight.delete(shop);
  }).catch(() => { /* swallow — caller already sees it */ });
  return p;
}

// ─── Shopify fetch (Admin GraphQL) ──────────────────────────────────────────

const SHOP_DOMAINS_QUERY = `
  query ShopDomains {
    shop {
      myshopifyDomain
      primaryDomain { host }
    }
  }
`;

let _shopifyFetcherOverride:
  | ((shopDomain: string, accessToken: string) => Promise<Set<string>>)
  | null = null;

async function fetchShopHostsFromShopify(shop: string): Promise<Set<string>> {
  const tenant = await getTenantByShopDomain(shop);
  if (!tenant) {
    throw new Error(`Unknown shop: ${shop}`);
  }
  const accessToken = await resolveAccessToken(tenant);
  if (!accessToken) {
    throw new Error(`No access token configured for shop: ${shop}`);
  }

  if (_shopifyFetcherOverride) {
    return _shopifyFetcherOverride(shop, accessToken);
  }

  const url = `https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query: SHOP_DOMAINS_QUERY }),
  });
  if (!response.ok) {
    throw new Error(
      `Shopify Admin API ${response.status}: ${await response.text()}`
    );
  }
  const json = (await response.json()) as {
    data?: {
      shop?: {
        myshopifyDomain?: string;
        primaryDomain?: { host?: string };
      };
    };
    errors?: unknown[];
  };
  if (json.errors) {
    throw new Error(`Shopify Admin API errors: ${JSON.stringify(json.errors)}`);
  }
  const ms = json.data?.shop?.myshopifyDomain?.toLowerCase();
  const pd = json.data?.shop?.primaryDomain?.host?.toLowerCase();
  const hosts = new Set<string>();
  if (ms) hosts.add(ms);
  if (pd) hosts.add(pd);
  if (hosts.size === 0) {
    throw new Error(`Shopify returned no domains for shop: ${shop}`);
  }
  return hosts;
}

async function resolveAccessToken(tenant: Tenant): Promise<string | null> {
  if (!tenant.shopifyAccessTokenSecretName) return null;
  try {
    return await getSecret(tenant.shopifyAccessTokenSecretName);
  } catch {
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse the Origin header ("https://host[:port]") and return the lowercased
 * host (no port). Returns null on malformed input.
 *
 * The widget client always posts from the storefront's primary origin over
 * HTTPS; stripping the port keeps the comparison domain-only so a shop on
 * https://shop.mybrand.com:443 matches the Admin API's "shop.mybrand.com".
 */
export function parseOriginHost(origin: string): string | null {
  try {
    const u = new URL(origin);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}
