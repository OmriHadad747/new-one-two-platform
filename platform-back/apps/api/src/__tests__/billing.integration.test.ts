/**
 * Integration tests for the /billing/* router.
 *
 * Focus: plan state machine, HMAC webhook verification, disabled vs live mode.
 * DB + Shopify billing client are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import rawBodyPlugin from "fastify-raw-body";

vi.mock("@platform-back/db", () => ({
  getTenantById: vi.fn(),
  getOrCreateUsageRecord: vi.fn(),
  getActiveAppCount: vi.fn(),
  updateTenantBilling: vi.fn(),
  logBillingEvent: vi.fn(),
  getBillingEvents: vi.fn(),
  getRevisionAnalytics: vi.fn(),
  getUsageHistory: vi.fn(),
  sql: vi.fn(),
}));
vi.mock("../lib/shopify-billing.js", () => ({
  createSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
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
}));

import {
  getTenantById, getOrCreateUsageRecord, getActiveAppCount,
  updateTenantBilling, logBillingEvent, getBillingEvents,
  getRevisionAnalytics, getUsageHistory, sql,
} from "@platform-back/db";
import { createSubscription, cancelSubscription } from "../lib/shopify-billing.js";
import { billingRoutes } from "../routes/billing.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const CLIENT_SECRET = process.env["SHOPIFY_CLIENT_SECRET"]!;

const MOCK_TENANT = {
  id: TENANT_ID, slug: "acme", name: "Acme",
  billingPlan: "starter" as const, billingInterval: "monthly" as const,
  subscriptionStatus: "active", shopifySubscriptionId: null, trialEndsAt: null,
  billingCycleAnchor: new Date().toISOString(), planUpdatedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  status: "active" as const, shopDomain: "acme.myshopify.com",
  shopifyAccessTokenSecretName: "secret-name", storefrontAccessTokenSecretName: null,
};

const MOCK_USAGE = {
  id: "u-1", tenantId: TENANT_ID, periodStart: new Date(),
  generations: 2, revisions: 5, appExecutions: 100,
  emailsSent: 10, smsSent: 0, filesUploaded: 0,
  createdAt: new Date(), updatedAt: new Date(),
};

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(rawBodyPlugin, { field: "rawBody", global: true, encoding: false, runFirst: true });
  await app.register(billingRoutes, { prefix: "/billing" });
  await app.ready();
  return app;
}

function buildWebhookHmac(body: string): string {
  return createHmac("sha256", CLIENT_SECRET).update(body, "utf8").digest("base64");
}

beforeEach(() => {
  vi.mocked(getTenantById).mockResolvedValue(MOCK_TENANT as never);
  vi.mocked(getOrCreateUsageRecord).mockResolvedValue(MOCK_USAGE as never);
  vi.mocked(getActiveAppCount).mockResolvedValue(2);
  vi.mocked(updateTenantBilling).mockResolvedValue(undefined);
  vi.mocked(logBillingEvent).mockResolvedValue(undefined);
  vi.mocked(getBillingEvents).mockResolvedValue([]);
  vi.mocked(getRevisionAnalytics).mockResolvedValue({ total: 0, bugReports: 0, featureModifications: 0, newCapabilities: 0 });
  vi.mocked(getUsageHistory).mockResolvedValue([]);
  vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  vi.mocked(createSubscription).mockResolvedValue({ confirmationUrl: "https://shopify.com/confirm", subscriptionId: "gid://1" });
  vi.mocked(cancelSubscription).mockResolvedValue(undefined);
  // Billing mode disabled by default for tests
  process.env["SHOPIFY_BILLING_MODE"] = "disabled";
});

// ─── GET /billing/plans ───────────────────────────────────────────────────────

describe("GET /billing/plans", () => {
  it("returns plan list with current plan from tenant", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "GET",
      url: `/billing/plans?tenantId=${TENANT_ID}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentPlan).toBe("starter");
    expect(body.plans).toBeInstanceOf(Array);
    expect(body.plans.every((p: { id: string }) => p.id !== "internal")).toBe(true);
    await server.close();
  });

  it("defaults to free plan when no tenantId provided", async () => {
    const server = await buildApp();
    const res = await server.inject({ method: "GET", url: "/billing/plans" });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentPlan).toBe("free");
    await server.close();
  });
});

// ─── GET /billing/usage/:tenantId ─────────────────────────────────────────────

describe("GET /billing/usage/:tenantId", () => {
  it("returns current usage + plan limits for the tenant", async () => {
    const server = await buildApp();
    const res = await server.inject({ method: "GET", url: `/billing/usage/${TENANT_ID}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plan).toBe("starter");
    expect(body.usage).toBeDefined();
    expect(body.limits).toBeDefined();
    await server.close();
  });

  it("returns 404 when tenant not found", async () => {
    vi.mocked(getTenantById).mockResolvedValue(null);
    const server = await buildApp();
    const res = await server.inject({ method: "GET", url: `/billing/usage/${TENANT_ID}` });
    expect(res.statusCode).toBe(404);
    await server.close();
  });
});

// ─── POST /billing/subscribe ──────────────────────────────────────────────────

describe("POST /billing/subscribe", () => {
  it("disabled mode — paid plan applied directly, no Shopify call", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: "/billing/subscribe",
      payload: { tenantId: TENANT_ID, plan: "growth", interval: "monthly" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().confirmationUrl).toBeNull();
    expect(createSubscription).not.toHaveBeenCalled();
    expect(updateTenantBilling).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ billingPlan: "growth" }),
    );
    expect(logBillingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "dev_plan_override" }),
    );
    await server.close();
  });

  it("free plan downgrades directly without Shopify call regardless of mode", async () => {
    process.env["SHOPIFY_BILLING_MODE"] = "live"; // even in live mode, free is direct
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: "/billing/subscribe",
      payload: { tenantId: TENANT_ID, plan: "free" },
    });
    expect(res.statusCode).toBe(200);
    expect(createSubscription).not.toHaveBeenCalled();
    expect(updateTenantBilling).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ billingPlan: "free", subscriptionStatus: "none" }),
    );
    await server.close();
  });

  it("live mode — returns Shopify confirmationUrl, marks subscription pending", async () => {
    process.env["SHOPIFY_BILLING_MODE"] = "live";
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: "/billing/subscribe",
      payload: { tenantId: TENANT_ID, plan: "growth", interval: "annual" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().confirmationUrl).toBe("https://shopify.com/confirm");
    expect(createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ id: TENANT_ID }),
      "growth",
      "annual",
    );
    expect(updateTenantBilling).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ subscriptionStatus: "pending" }),
    );
    await server.close();
  });

  it("rejects annual billing for free plan", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: "/billing/subscribe",
      payload: { tenantId: TENANT_ID, plan: "free", interval: "annual" },
    });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it("returns 400 on invalid body", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: "/billing/subscribe",
      payload: { plan: "growth" }, // missing tenantId
    });
    expect(res.statusCode).toBe(400);
    await server.close();
  });
});

// ─── POST /billing/cancel/:tenantId ───────────────────────────────────────────

describe("POST /billing/cancel/:tenantId", () => {
  it("cancels Shopify subscription and downgrades to free", async () => {
    vi.mocked(getTenantById).mockResolvedValue({
      ...MOCK_TENANT,
      shopifySubscriptionId: "gid://shopify/AppSubscription/1",
    } as never);
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: `/billing/cancel/${TENANT_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plan: "free" });
    expect(cancelSubscription).toHaveBeenCalled();
    expect(updateTenantBilling).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ billingPlan: "free", subscriptionStatus: "cancelled" }),
    );
    await server.close();
  });

  it("skips cancelSubscription when no active subscription", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: `/billing/cancel/${TENANT_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(cancelSubscription).not.toHaveBeenCalled();
    await server.close();
  });
});

// ─── POST /billing/webhook ────────────────────────────────────────────────────

describe("POST /billing/webhook — HMAC verification", () => {
  it("rejects requests with missing HMAC header → 401", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: "/billing/webhook",
      payload: { app_subscription: { admin_graphql_api_id: "gid://1", status: "ACTIVE" } },
    });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it("rejects requests with invalid HMAC → 401", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "x-shopify-hmac-sha256": "invalidsignature" },
      payload: { app_subscription: { admin_graphql_api_id: "gid://1", status: "ACTIVE" } },
    });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it("accepts requests with valid HMAC → 200", async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: TENANT_ID, billingPlan: "starter" },
    ]);
    const body = JSON.stringify({ app_subscription: { admin_graphql_api_id: "gid://1", status: "ACTIVE" } });
    const hmac = buildWebhookHmac(body);
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "x-shopify-hmac-sha256": hmac, "content-type": "application/json" },
      body,
    });
    expect(res.statusCode).toBe(200);
    await server.close();
  });
});

describe("POST /billing/webhook — subscription state machine", () => {
  async function sendWebhook(status: string, shopifySubscriptionId = "gid://1") {
    const bodyObj = {
      app_subscription: {
        admin_graphql_api_id: shopifySubscriptionId,
        status,
      },
    };
    const body = JSON.stringify(bodyObj);
    const hmac = buildWebhookHmac(body);
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: TENANT_ID, billingPlan: "growth" },
    ]);
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "x-shopify-hmac-sha256": hmac, "content-type": "application/json" },
      body,
    });
    await server.close();
    return res;
  }

  it("FROZEN → downgrades to free + sets subscriptionStatus=frozen", async () => {
    const res = await sendWebhook("FROZEN");
    expect(res.statusCode).toBe(200);
    expect(updateTenantBilling).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ billingPlan: "free", subscriptionStatus: "frozen" }),
    );
  });

  it("CANCELLED → downgrades to free + sets subscriptionStatus=cancelled", async () => {
    const res = await sendWebhook("CANCELLED");
    expect(res.statusCode).toBe(200);
    expect(updateTenantBilling).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ billingPlan: "free", subscriptionStatus: "cancelled" }),
    );
  });

  it("ACTIVE → only updates subscriptionStatus, no plan downgrade", async () => {
    const res = await sendWebhook("ACTIVE");
    expect(res.statusCode).toBe(200);
    expect(updateTenantBilling).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ subscriptionStatus: "active" }),
    );
    // billingPlan must NOT be set to free
    const call = vi.mocked(updateTenantBilling).mock.calls[0]!;
    expect((call[1] as { billingPlan?: string }).billingPlan).toBeUndefined();
  });

  it("unknown tenant → returns 200 (no error, just ignored)", async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const body = JSON.stringify({ app_subscription: { admin_graphql_api_id: "gid://unknown", status: "ACTIVE" } });
    const hmac = buildWebhookHmac(body);
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "x-shopify-hmac-sha256": hmac, "content-type": "application/json" },
      body,
    });
    expect(res.statusCode).toBe(200);
    expect(updateTenantBilling).not.toHaveBeenCalled();
    await server.close();
  });
});

// ─── GET /billing/dashboard/:tenantId ─────────────────────────────────────────

describe("GET /billing/dashboard/:tenantId", () => {
  it("returns all dashboard sections", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "GET",
      url: `/billing/dashboard/${TENANT_ID}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subscription).toBeDefined();
    expect(body.currentUsage).toBeDefined();
    expect(body.usageHistory).toBeInstanceOf(Array);
    expect(body.billingEvents).toBeInstanceOf(Array);
    expect(body.revisionAnalytics).toBeDefined();
    expect(body.appCount).toBeDefined();
    await server.close();
  });

  it("fetches all data in parallel (all 5 mocks called)", async () => {
    const server = await buildApp();
    await server.inject({ method: "GET", url: `/billing/dashboard/${TENANT_ID}` });
    expect(getOrCreateUsageRecord).toHaveBeenCalled();
    expect(getUsageHistory).toHaveBeenCalled();
    expect(getBillingEvents).toHaveBeenCalled();
    expect(getRevisionAnalytics).toHaveBeenCalled();
    expect(getActiveAppCount).toHaveBeenCalled();
    await server.close();
  });
});
