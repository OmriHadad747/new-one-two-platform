/**
 * Route-layer integration test for the widget proxy.
 *
 * shop-domains.test.ts pins the policy function (does this origin belong
 * to this shop?). This file pins the wiring: does the handler actually
 * call that policy BEFORE resolving the function URL and BEFORE forwarding
 * to the harness? A regression where someone removes the
 * `isOriginAllowedForShop` call would slip past the unit tests but fail
 * here.
 *
 * Strategy:
 *   - Fresh Fastify with widgetJsRoutes mounted at /widgets (same as
 *     server.ts:85). No CORS plugin installed: we're testing the
 *     handler-layer check, not CORS reflection.
 *   - Stub `resolveAppFunctionUrl` to return null so the happy-Origin
 *     case lands on a distinct 503 "BackendNotDeployed" response. The
 *     evil.com and missing-origin cases stop at 403 BEFORE
 *     resolveAppFunctionUrl gets called — the 503 vs 403 split proves
 *     the Origin check is the first gate.
 *   - Inject a fake fetcher into shop-domains so no Shopify Admin API
 *     call is made.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Must set before dynamic imports so ORIGIN_CHECK_ENABLED = true at module load.
process.env["DEPLOY_MODE"] = "cloudrun";

// Stub db: resolveAppFunctionUrl returns null → happy-origin case produces
// 503 BackendNotDeployed. We don't care about the harness; we only care
// that the Origin check gated the request before this function was called.
vi.mock("@new-one-two/db", () => ({
  resolveAppFunctionUrl: vi.fn(async () => null),
  resolveWidgetJs: vi.fn(async () => null),
  trackAppExecution: vi.fn(async () => undefined),
  getTenantByShopDomain: async (shop: string) => ({
    id: "tenant-id",
    slug: "t",
    name: "T",
    status: "active",
    kmsKeyName: "k",
    shopDomain: shop,
    shopifyAccessTokenSecretName: "projects/x/secrets/token/versions/latest",
    storefrontAccessTokenSecretName: null,
    billingPlan: "free",
    billingInterval: "monthly",
    subscriptionStatus: "active",
    shopifySubscriptionId: null,
    trialEndsAt: null,
    billingCycleAnchor: new Date(),
    planUpdatedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
}));
vi.mock("@new-one-two/crypto", () => ({
  getSecret: async () => "shpat_test_token",
}));

type ShopDomainsModule = typeof import("../lib/shop-domains.js");

const SHOP = "acme.myshopify.com";
const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WIDGET_PATH = `/widgets/${SHOP}/${APP_ID}/widget/subscribe`;

let app: FastifyInstance;
let shopDomains: ShopDomainsModule;

beforeAll(async () => {
  const { default: Fastify } = await import("fastify");
  const { widgetJsRoutes } = await import("./widget-js.js");
  shopDomains = await import("../lib/shop-domains.js");

  // Seed the allowed-hosts set for our fixture shop so the policy has
  // something concrete to compare the incoming Origin against. Real Cloud
  // Run instances populate this via the Shopify Admin API; here we skip
  // the network call.
  shopDomains.__setShopifyFetcherForTests(async () => new Set([SHOP, "shop.acme.com"]));

  app = Fastify({ logger: false });
  await app.register(widgetJsRoutes, { prefix: "/widgets" });
  await app.ready();
});

afterEach(() => {
  shopDomains.__clearShopDomainCacheForTests();
});

describe("widget proxy — Origin ownership gate", () => {
  it("200-equivalent (503 BackendNotDeployed) when Origin matches the shop's primary domain", async () => {
    const res = await app.inject({
      method: "POST",
      url: WIDGET_PATH,
      headers: { origin: "https://shop.acme.com", "content-type": "application/json" },
      payload: JSON.stringify({ email: "alice@example.com" }),
    });
    // A matching Origin passes the gate. The handler then hits our stubbed
    // resolveAppFunctionUrl → null → 503 BackendNotDeployed. The status
    // code we care about is "NOT 403" — 503 is the signal that the Origin
    // check didn't reject us.
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.code).toBe("backend_not_deployed");
  });

  it("403 access_denied when Origin is evil.com", async () => {
    const res = await app.inject({
      method: "POST",
      url: WIDGET_PATH,
      headers: { origin: "https://evil.com", "content-type": "application/json" },
      payload: JSON.stringify({ email: "alice@example.com" }),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe("access_denied");
  });

  it("403 access_denied when Origin header is missing entirely", async () => {
    // Production browser-driven widget calls always send Origin; server-to-
    // server / curl traffic shouldn't be hitting /widgets/*. The handler
    // denies rather than defaulting to "allowed" — monotonic policy.
    const res = await app.inject({
      method: "POST",
      url: WIDGET_PATH,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "alice@example.com" }),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe("access_denied");
  });

  it("rejects before calling resolveAppFunctionUrl (proves Origin check runs first)", async () => {
    // Look up the mock from the imported module and assert it wasn't
    // touched on the evil-Origin path. If a future refactor reorders the
    // Origin check to run AFTER resolveAppFunctionUrl, this test fails —
    // which is what we want, because that reorder would leak DB access to
    // evil.com callers.
    const dbMod = await import("@new-one-two/db");
    const resolveSpy = vi.mocked(dbMod.resolveAppFunctionUrl);
    resolveSpy.mockClear();

    await app.inject({
      method: "POST",
      url: WIDGET_PATH,
      headers: { origin: "https://evil.com", "content-type": "application/json" },
      payload: "{}",
    });
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
