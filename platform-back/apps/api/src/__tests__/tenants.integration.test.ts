/**
 * Integration tests for the /tenants/* router.
 *
 * Focus: app lifecycle status transitions (PATCH) and permanent delete (DELETE)
 * wiring to the deployer lifecycle functions. DB + deployer are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

vi.mock("@platform-back/db", () => ({
  createTenant: vi.fn(),
  getTenantById: vi.fn(),
  getTenantByShopDomain: vi.fn(),
  getTenantStats: vi.fn(),
  getAppById: vi.fn(),
  listAppsForTenant: vi.fn(),
  createApp: vi.fn(),
  updateAppName: vi.fn(),
  updateAppStatus: vi.fn(),
  hardDeleteApp: vi.fn(),
  getActiveAppCount: vi.fn(),
  getActiveWebhookSubscriptionsForApp: vi.fn(),
  getWidgetInvocationLogs: vi.fn(),
  getAdminInvocationLogs: vi.fn(),
  getRecentWebhookInvocationLogs: vi.fn(),
}));
vi.mock("@platform-back/deployer", () => ({
  teardownApp: vi.fn().mockResolvedValue(undefined),
  reactivateApp: vi.fn().mockResolvedValue({ functionUrl: "https://h.run.app" }),
  permanentDeleteApp: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@platform-back/crypto", () => ({
  getSecret: vi.fn(),
}));
vi.mock("../lib/plan-enforcement.js", () => ({
  canActivateApp: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("../lib/theme-injector.js", () => ({
  getThemeTemplates: vi.fn(),
  duplicateTheme: vi.fn(),
  injectAppBlock: vi.fn(),
  getActiveTheme: vi.fn(),
  themeEditorUrl: vi.fn(),
  themePreviewUrl: vi.fn(),
}));
vi.mock("../plugins/auth.js", () => ({
  registerAuthHook: vi.fn(),
  requireTenant: vi.fn((req: unknown, reply: unknown, id: string) => id),
  requireAuthedTenantId: vi.fn(),
  signJwt: vi.fn(),
  verifyJwt: vi.fn(),
}));
vi.mock("@platform-back/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createRequestLogger: vi.fn(() => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  })),
}));

import {
  getAppById, listAppsForTenant, createApp, updateAppName, updateAppStatus, hardDeleteApp,
  getTenantById, getTenantByShopDomain, createTenant,
} from "@platform-back/db";
import { teardownApp, reactivateApp, permanentDeleteApp } from "@platform-back/deployer";
import { canActivateApp } from "../lib/plan-enforcement.js";
import { tenantsRoutes } from "../routes/tenants.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const APP_ID    = "22222222-2222-2222-2222-222222222222";

const MOCK_APP = {
  id: APP_ID, tenantId: TENANT_ID, slug: "my-app", name: "My App",
  status: "active", shopDomain: "acme.myshopify.com", handlerSaEmail: null,
};
const MOCK_TENANT = {
  id: TENANT_ID, slug: "acme", name: "Acme", shopDomain: "acme.myshopify.com",
  billingPlan: "starter", subscriptionStatus: "active", billingInterval: "monthly",
  shopifySubscriptionId: null, trialEndsAt: null, billingCycleAnchor: new Date().toISOString(),
  planUpdatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  status: "active", shopifyAccessTokenSecretName: null, storefrontAccessTokenSecretName: null,
};

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(tenantsRoutes, { prefix: "/tenants" });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.mocked(getAppById).mockResolvedValue(MOCK_APP as never);
  vi.mocked(getTenantById).mockResolvedValue(MOCK_TENANT as never);
  vi.mocked(getTenantByShopDomain).mockResolvedValue(null);
  vi.mocked(createTenant).mockResolvedValue({ id: TENANT_ID });
  vi.mocked(listAppsForTenant).mockResolvedValue([MOCK_APP] as never);
  vi.mocked(createApp).mockResolvedValue(MOCK_APP as never);
  vi.mocked(updateAppName).mockResolvedValue(undefined);
  vi.mocked(updateAppStatus).mockResolvedValue(undefined);
  vi.mocked(hardDeleteApp).mockResolvedValue(undefined);
  vi.mocked(teardownApp).mockResolvedValue(undefined);
  vi.mocked(reactivateApp).mockResolvedValue({ functionUrl: "https://h.run.app" });
  vi.mocked(permanentDeleteApp).mockResolvedValue(undefined);
});

// ─── GET /tenants/:tenantId/apps ──────────────────────────────────────────────

describe("GET /tenants/:tenantId/apps", () => {
  it("returns the app list for the tenant", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "GET",
      url: `/tenants/${TENANT_ID}/apps`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([MOCK_APP]);
    await server.close();
  });
});

// ─── GET /tenants/:tenantId/apps/:appId ──────────────────────────────────────

describe("GET /tenants/:tenantId/apps/:appId", () => {
  it("returns 200 + app when found", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "GET",
      url: `/tenants/${TENANT_ID}/apps/${APP_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(APP_ID);
    await server.close();
  });

  it("returns 404 when app not found", async () => {
    vi.mocked(getAppById).mockResolvedValue(null);
    const server = await buildApp();
    const res = await server.inject({
      method: "GET",
      url: `/tenants/${TENANT_ID}/apps/${APP_ID}`,
    });
    expect(res.statusCode).toBe(404);
    await server.close();
  });
});

// ─── PATCH /tenants/:tenantId/apps/:appId — status transitions ────────────────

describe("PATCH /tenants/:tenantId/apps/:appId status transitions", () => {
  it("status=inactive → calls updateAppStatus + fires teardownApp", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "PATCH",
      url: `/tenants/${TENANT_ID}/apps/${APP_ID}`,
      payload: { status: "inactive" },
    });
    expect(res.statusCode).toBe(200);
    expect(updateAppStatus).toHaveBeenCalledWith(APP_ID, "inactive");
    // teardownApp is fire-and-forget; give microtasks a tick to flush
    await Promise.resolve();
    expect(teardownApp).toHaveBeenCalledWith({ tenantId: TENANT_ID, appId: APP_ID });
    expect(reactivateApp).not.toHaveBeenCalled();
    await server.close();
  });

  it("status=deleted → calls updateAppStatus + fires teardownApp", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "PATCH",
      url: `/tenants/${TENANT_ID}/apps/${APP_ID}`,
      payload: { status: "deleted" },
    });
    expect(res.statusCode).toBe(200);
    expect(updateAppStatus).toHaveBeenCalledWith(APP_ID, "deleted");
    await Promise.resolve();
    expect(teardownApp).toHaveBeenCalledWith({ tenantId: TENANT_ID, appId: APP_ID });
    await server.close();
  });

  it("status=active → plan check passes → calls updateAppStatus + fires reactivateApp", async () => {
    vi.mocked(getAppById).mockResolvedValue({ ...MOCK_APP, status: "inactive" } as never);
    const server = await buildApp();
    const res = await server.inject({
      method: "PATCH",
      url: `/tenants/${TENANT_ID}/apps/${APP_ID}`,
      payload: { status: "active" },
    });
    expect(res.statusCode).toBe(200);
    expect(updateAppStatus).toHaveBeenCalledWith(APP_ID, "active");
    await Promise.resolve();
    expect(reactivateApp).toHaveBeenCalledWith({ tenantId: TENANT_ID, appId: APP_ID });
    await server.close();
  });

  it("status=active blocked when plan cap reached → 403, no updateAppStatus", async () => {
    vi.mocked(canActivateApp).mockResolvedValue({
      allowed: false,
      reason: "App limit reached",
      upgradeHint: "Upgrade to growth",
    });
    const server = await buildApp();
    const res = await server.inject({
      method: "PATCH",
      url: `/tenants/${TENANT_ID}/apps/${APP_ID}`,
      payload: { status: "active" },
    });
    expect(res.statusCode).toBe(403);
    expect(updateAppStatus).not.toHaveBeenCalled();
    expect(reactivateApp).not.toHaveBeenCalled();
    await server.close();
  });

  it("returns 404 when app not found", async () => {
    vi.mocked(getAppById).mockResolvedValue(null);
    const server = await buildApp();
    const res = await server.inject({
      method: "PATCH",
      url: `/tenants/${TENANT_ID}/apps/${APP_ID}`,
      payload: { status: "inactive" },
    });
    expect(res.statusCode).toBe(404);
    expect(updateAppStatus).not.toHaveBeenCalled();
    await server.close();
  });
});

// ─── DELETE /tenants/:tenantId/apps/:appId ────────────────────────────────────

describe("DELETE /tenants/:tenantId/apps/:appId", () => {
  it("calls permanentDeleteApp and returns { deleted: true }", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "DELETE",
      url: `/tenants/${TENANT_ID}/apps/${APP_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect(permanentDeleteApp).toHaveBeenCalledWith({ tenantId: TENANT_ID, appId: APP_ID });
    await server.close();
  });

  it("awaits permanentDeleteApp synchronously (not fire-and-forget)", async () => {
    // Verify the route awaits the call — if it were fire-and-forget, the
    // resolve callback would not run before we assert.
    let resolved = false;
    vi.mocked(permanentDeleteApp).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      resolved = true;
    });
    const server = await buildApp();
    await server.inject({ method: "DELETE", url: `/tenants/${TENANT_ID}/apps/${APP_ID}` });
    expect(resolved).toBe(true);
    await server.close();
  });

  it("returns 404 when app not found", async () => {
    vi.mocked(getAppById).mockResolvedValue(null);
    const server = await buildApp();
    const res = await server.inject({
      method: "DELETE",
      url: `/tenants/${TENANT_ID}/apps/${APP_ID}`,
    });
    expect(res.statusCode).toBe(404);
    expect(permanentDeleteApp).not.toHaveBeenCalled();
    await server.close();
  });

  it("returns 500 when permanentDeleteApp throws", async () => {
    vi.mocked(permanentDeleteApp).mockRejectedValue(new Error("deployer blew up"));
    const server = await buildApp();
    const res = await server.inject({
      method: "DELETE",
      url: `/tenants/${TENANT_ID}/apps/${APP_ID}`,
    });
    expect(res.statusCode).toBe(500);
    // The catch block exits via return, so the post-try hardDeleteApp safety-net
    // is NOT reached in the error path — permanentDeleteApp owns the full cleanup.
    expect(hardDeleteApp).not.toHaveBeenCalled();
    await server.close();
  });
});
