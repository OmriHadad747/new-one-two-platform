import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import Fastify from "fastify";

vi.mock("@platform-back/db", () => ({
  createTenant: vi.fn(),
  getTenantByShopDomain: vi.fn(),
  updateTenantAccessToken: vi.fn(),
}));
vi.mock("@platform-back/crypto", () => ({
  storeSecret: vi.fn(),
  getSecret: vi.fn(),
}));
vi.mock("../plugins/auth.js", () => ({
  signJwt: vi.fn().mockReturnValue("platform-jwt-token"),
  verifyJwt: vi.fn(),
  requireTenant: vi.fn(),
  requireAuthedTenantId: vi.fn(),
}));
vi.mock("@platform-back/logger", () => {
  const base = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const logger = { ...base, child: vi.fn().mockReturnValue(base) };
  return {
    logger,
    createRequestLogger: vi.fn().mockReturnValue(logger),
  };
});

import { createTenant, getTenantByShopDomain, updateTenantAccessToken } from "@platform-back/db";
import { storeSecret } from "@platform-back/crypto";
import { signJwt } from "../plugins/auth.js";
import { oauthRoutes } from "../routes/oauth.js";

const mockCreateTenant = vi.mocked(createTenant);
const mockGetByDomain = vi.mocked(getTenantByShopDomain);
const mockUpdateToken = vi.mocked(updateTenantAccessToken);
const mockStoreSecret = vi.mocked(storeSecret);
const mockSignJwt = vi.mocked(signJwt);

const CLIENT_ID = process.env["SHOPIFY_CLIENT_ID"]!;
const CLIENT_SECRET = process.env["SHOPIFY_CLIENT_SECRET"]!;
const SHOP = "acme.myshopify.com";

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(oauthRoutes, { prefix: "/oauth" });
  await app.ready();
  return app;
}

// Build a valid HMAC-signed callback query (Shopify's signature format)
function buildCallbackQuery(code: string, state: string): string {
  const params = { code, shop: SHOP, state };
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k as keyof typeof params]}`)
    .join("&");
  const hmac = createHmac("sha256", CLIENT_SECRET).update(message).digest("hex");
  return new URLSearchParams({ ...params, hmac }).toString();
}

// Build a valid state token (HMAC-signed nonce+shop, as produced by installHandler)
function buildState(shop: string): string {
  const payload = Buffer.from(JSON.stringify({ nonce: "test-nonce", shop })).toString("base64url");
  const sig = createHmac("sha256", CLIENT_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

// Mock global fetch for Shopify API calls
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();

  // Default: Shopify token exchange succeeds
  fetchMock.mockImplementation(async (url: string) => {
    const u = url.toString();
    if (u.includes("/admin/oauth/access_token")) {
      return {
        ok: true,
        json: async () => ({ access_token: "shpat_test123" }),
        text: async () => JSON.stringify({ access_token: "shpat_test123" }),
      };
    }
    if (u.includes("/admin/api/") && u.includes("/metafields.json")) {
      return { ok: true, json: async () => ({ metafield: { id: 1 } }) };
    }
    if (u.includes("/admin/api/") && u.includes("/storefront_access_tokens.json")) {
      return {
        ok: true,
        json: async () => ({
          storefront_access_token: { access_token: "sfront_test123", id: 99 },
        }),
      };
    }
    return { ok: false, status: 404, text: async () => "Not found" };
  });

  // Default DB mocks
  mockGetByDomain.mockResolvedValue(null); // new install
  mockCreateTenant.mockResolvedValue({ id: "new-tenant-id" });
  mockStoreSecret.mockResolvedValue(
    "projects/test/secrets/acme-shopify-token/versions/latest",
  );
  mockSignJwt.mockReturnValue("platform-jwt-token");
});

describe("GET /oauth/install", () => {
  it("redirects to Shopify OAuth authorization page", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/oauth/install?shop=${SHOP}`,
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers["location"] as string;
    expect(location).toContain(`https://${SHOP}/admin/oauth/authorize`);
    expect(location).toContain(`client_id=${CLIENT_ID}`);
    expect(location).toContain("scope=");
    expect(location).toContain("state=");
    await app.close();
  });

  it("returns 400 for missing shop parameter", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/oauth/install" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 400 for shop not ending in .myshopify.com", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/oauth/install?shop=evil.example.com",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /oauth/callback — happy path (first install)", () => {
  it("creates tenant, stores token, and redirects to dashboard", async () => {
    const state = buildState(SHOP);
    const qs = buildCallbackQuery("auth-code-123", state);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/oauth/callback?${qs}`,
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers["location"] as string;
    expect(location).toContain("new-tenant-id");
    expect(location).toContain("token=platform-jwt-token");

    expect(mockCreateTenant).toHaveBeenCalledWith(
      expect.objectContaining({ shopDomain: SHOP }),
    );
    await app.close();
  });

  it("updates existing tenant on re-install", async () => {
    mockGetByDomain.mockResolvedValue({ id: "existing-tenant-id" });
    const state = buildState(SHOP);
    const qs = buildCallbackQuery("auth-code-456", state);
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/oauth/callback?${qs}`,
    });

    expect(res.statusCode).toBe(302);
    expect(mockCreateTenant).not.toHaveBeenCalled();
    expect(mockUpdateToken).toHaveBeenCalledWith(
      "existing-tenant-id",
      expect.any(String),
      expect.anything(),
    );
    await app.close();
  });
});

describe("GET /oauth/callback — security checks", () => {
  it("returns 400 when required params are missing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/oauth/callback?shop=${SHOP}`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 401 when HMAC is invalid", async () => {
    const state = buildState(SHOP);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/oauth/callback?code=abc&shop=${SHOP}&state=${state}&hmac=badhmacsignature`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 400 when state shop binding doesn't match query shop", async () => {
    const state = buildState("other-shop.myshopify.com");
    const params = { code: "abc", shop: SHOP, state };
    const message = Object.keys(params).sort().map((k) => `${k}=${params[k as keyof typeof params]}`).join("&");
    const hmac = createHmac("sha256", CLIENT_SECRET).update(message).digest("hex");
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/oauth/callback?${new URLSearchParams({ ...params, hmac })}`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 502 when Shopify token exchange fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.toString().includes("/admin/oauth/access_token")) {
        return { ok: false, status: 400, text: async () => "bad_request" };
      }
      return { ok: true };
    });

    const state = buildState(SHOP);
    const qs = buildCallbackQuery("bad-code", state);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/oauth/callback?${qs}`,
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});
