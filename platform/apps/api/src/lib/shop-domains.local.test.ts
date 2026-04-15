/**
 * Dev-mode short-circuit coverage for shop-domains.
 *
 * Separate file because ORIGIN_CHECK_ENABLED is captured at module load
 * (process.env["DEPLOY_MODE"] is read once). We set DEPLOY_MODE="local"
 * BEFORE the dynamic import so the module sees the dev-mode flag.
 *
 * The "production" path is covered in shop-domains.test.ts — that file
 * sets DEPLOY_MODE="cloudrun" at the top, so the two files never share
 * a module instance within a vitest run.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env["DEPLOY_MODE"] = "local";

// Same DB / crypto stubs as shop-domains.test.ts — keeps the module from
// opening a real Postgres connection at import time. Not that any of the
// tests below actually fetch (ORIGIN_CHECK_ENABLED=false short-circuits
// the resolver), but the dynamic import still triggers the static
// dependency graph.
vi.mock("@new-one-two/db", () => ({
  getTenantByShopDomain: async () => null,
}));
vi.mock("@new-one-two/crypto", () => ({
  getSecret: async () => "",
}));

type ShopDomainsModule = typeof import("./shop-domains.js");
let mod: ShopDomainsModule;

beforeAll(async () => {
  mod = await import("./shop-domains.js");
});

describe("shop-domains — DEPLOY_MODE=local short-circuit", () => {
  it("ORIGIN_CHECK_ENABLED is false in dev", () => {
    expect(mod.ORIGIN_CHECK_ENABLED).toBe(false);
  });

  it("allows any origin when the gate is disabled — tunnels + preview domains Just Work", async () => {
    // Deliberately hostile-looking origin. In prod this would 403; in dev
    // the short-circuit bypasses the Admin API call entirely.
    expect(
      await mod.isOriginAllowedForShop("acme.myshopify.com", "https://evil.com")
    ).toBe(true);
  });

  it("allows a missing Origin header in dev too (curl / server-to-server)", async () => {
    expect(
      await mod.isOriginAllowedForShop("acme.myshopify.com", undefined)
    ).toBe(true);
  });

  it("does not touch the Shopify fetcher in dev", async () => {
    // If the fetcher ran, it'd throw through our db mock (null tenant) and
    // the result would be `false`, not `true`. The short-circuit must skip
    // the whole resolver path.
    const called = { n: 0 };
    mod.__setShopifyFetcherForTests(async () => {
      called.n++;
      return new Set();
    });
    const ok = await mod.isOriginAllowedForShop(
      "acme.myshopify.com",
      "https://anything.com"
    );
    expect(ok).toBe(true);
    expect(called.n).toBe(0);
  });
});
