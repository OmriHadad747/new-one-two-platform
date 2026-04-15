/**
 * Unit tests for the shop-domain ownership cache (TD-013).
 *
 * We exercise the matcher + cache without hitting Shopify's Admin API: the
 * module exposes a test-only fetcher override and a pluggable clock so
 * every branch (cold miss / cache hit / expiry / stale-on-failure) is
 * deterministic.
 *
 * DEPLOY_MODE handling (the non-production short-circuit) is asserted
 * indirectly via ORIGIN_CHECK_ENABLED — changing process.env here after
 * the module is imported has no effect because it's read at module load.
 * The test file sets it before the first dynamic import.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Force "production-like" behavior so ORIGIN_CHECK_ENABLED=true inside the
// module. Must run BEFORE the dynamic import below.
process.env["DEPLOY_MODE"] = "cloudrun";

// Stub the DB module with a lightweight fake. @new-one-two/db opens a
// real Postgres connection on import which we don't want in a unit test.
vi.mock("@new-one-two/db", () => ({
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

// Stub the secret manager too — we don't care about the access token value,
// only that the module treats it as "present" and hands it to the fetcher.
vi.mock("@new-one-two/crypto", () => ({
  getSecret: async () => "shpat_test_token",
}));

type ShopDomainsModule = typeof import("./shop-domains.js");
let mod: ShopDomainsModule;

beforeAll(async () => {
  mod = await import("./shop-domains.js");
});

afterEach(() => {
  mod.__clearShopDomainCacheForTests();
  mod.__setShopifyFetcherForTests(null);
  mod.__setNowForTests(() => Date.now());
});

describe("parseOriginHost", () => {
  it("strips scheme + returns lowercase hostname", async () => {
    expect(mod.parseOriginHost("https://Shop.MyBrand.com")).toBe("shop.mybrand.com");
  });
  it("strips port", async () => {
    expect(mod.parseOriginHost("http://localhost:3000")).toBe("localhost");
  });
  it("returns null on malformed input", async () => {
    expect(mod.parseOriginHost("not-a-url")).toBeNull();
    expect(mod.parseOriginHost("")).toBeNull();
  });
});

describe("isOriginAllowedForShop — production path", () => {
  const SHOP = "acme.myshopify.com";

  it("allows an origin on the shop's primary domain (cache miss → Shopify fetch)", async () => {
    const fetchCalls: string[] = [];
    mod.__setShopifyFetcherForTests(async (shop) => {
      fetchCalls.push(shop);
      return new Set(["acme.myshopify.com", "shop.acme.com"]);
    });

    const ok = await mod.isOriginAllowedForShop(SHOP, "https://shop.acme.com");
    expect(ok).toBe(true);
    expect(fetchCalls).toEqual([SHOP]);
  });

  it("allows the myshopifyDomain itself", async () => {
    mod.__setShopifyFetcherForTests(async () => new Set(["acme.myshopify.com", "shop.acme.com"]));
    const ok = await mod.isOriginAllowedForShop(SHOP, "https://acme.myshopify.com");
    expect(ok).toBe(true);
  });

  it("rejects evil.com even though CORS reflected it", async () => {
    mod.__setShopifyFetcherForTests(async () => new Set(["acme.myshopify.com", "shop.acme.com"]));
    const ok = await mod.isOriginAllowedForShop(SHOP, "https://evil.com");
    expect(ok).toBe(false);
  });

  it("rejects a subdomain trick (evil.shop.acme.com vs shop.acme.com)", async () => {
    // Exact host match only — a subdomain of an allowed host should NOT
    // inherit trust. This is the suffix-trick guard that the CORS
    // wildcard matcher already enforces for non-widget routes.
    mod.__setShopifyFetcherForTests(async () => new Set(["shop.acme.com"]));
    const ok = await mod.isOriginAllowedForShop(SHOP, "https://evil.shop.acme.com");
    expect(ok).toBe(false);
  });

  it("rejects when the Origin header is missing", async () => {
    mod.__setShopifyFetcherForTests(async () => new Set(["shop.acme.com"]));
    const ok = await mod.isOriginAllowedForShop(SHOP, undefined);
    // No Origin in a browser-driven widget call is anomalous — curl /
    // server-to-server traffic should not be hitting /widgets/*.
    expect(ok).toBe(false);
  });

  it("reuses the cache on a second call (no second Shopify fetch)", async () => {
    let fetchCount = 0;
    mod.__setShopifyFetcherForTests(async () => {
      fetchCount++;
      return new Set(["shop.acme.com"]);
    });

    await mod.isOriginAllowedForShop(SHOP, "https://shop.acme.com");
    await mod.isOriginAllowedForShop(SHOP, "https://shop.acme.com");
    expect(fetchCount).toBe(1);
  });

  it("refreshes after TTL expiry", async () => {
    let fetchCount = 0;
    mod.__setShopifyFetcherForTests(async () => {
      fetchCount++;
      return new Set(["shop.acme.com"]);
    });
    let clock = 1_000_000;
    mod.__setNowForTests(() => clock);

    await mod.isOriginAllowedForShop(SHOP, "https://shop.acme.com");
    expect(fetchCount).toBe(1);

    // Advance past the 5-min TTL.
    clock += 5 * 60_000 + 1;
    await mod.isOriginAllowedForShop(SHOP, "https://shop.acme.com");
    expect(fetchCount).toBe(2);
  });

  it("serves stale cache when Admin API fails after the first successful fetch", async () => {
    let clock = 1_000_000;
    mod.__setNowForTests(() => clock);

    let calls = 0;
    mod.__setShopifyFetcherForTests(async () => {
      calls++;
      if (calls === 1) return new Set(["shop.acme.com"]);
      throw new Error("Shopify Admin API unavailable");
    });

    // Seed.
    expect(await mod.isOriginAllowedForShop(SHOP, "https://shop.acme.com")).toBe(true);

    // Expire + fail-on-refresh → stale cache still accepted.
    clock += 6 * 60_000;
    expect(await mod.isOriginAllowedForShop(SHOP, "https://shop.acme.com")).toBe(true);
  });

  it("rejects on Admin API failure with an empty cold cache", async () => {
    mod.__setShopifyFetcherForTests(async () => {
      throw new Error("Shopify Admin API unavailable");
    });
    const ok = await mod.isOriginAllowedForShop(SHOP, "https://shop.acme.com");
    // No cached knowledge → no trust. A 503-level failure from the caller's
    // perspective; the handler converts `false` to 403 which is the safer
    // default for security-sensitive gates (no information leak vs the
    // "API is down" case).
    expect(ok).toBe(false);
  });
});
