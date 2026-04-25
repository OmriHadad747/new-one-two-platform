/**
 * Integration tests for the webhook gateway receiver.
 *
 * Critical flows covered:
 *   - HMAC validation (valid / missing / tampered)
 *   - Idempotency: duplicate webhookId is rejected with status=duplicate
 *   - Quota enforcement: over-limit tenants return 200 with quota_exceeded
 *   - Happy path: webhook is queued and returns executionLogId + jobId
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import Fastify from "fastify";

vi.mock("@platform-back/db", () => ({
  resolveWebhookContext: vi.fn(),
  createWebhookInvocationLog: vi.fn(),
  checkUsageQuota: vi.fn(),
  trackAppExecution: vi.fn(),
}));
vi.mock("@platform-back/crypto", () => ({
  getSecret: vi.fn(),
  validateShopifyHmac: vi.fn(),
  hashPayload: vi.fn(() => "hash-abc"),
}));
vi.mock("../queue/webhook-queue.js", () => ({
  enqueueWebhook: vi.fn(),
}));
vi.mock("@platform-back/logger", () => ({
  createRequestLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  resolveWebhookContext,
  createWebhookInvocationLog,
  checkUsageQuota,
  trackAppExecution,
} from "@platform-back/db";
import { getSecret, validateShopifyHmac, hashPayload } from "@platform-back/crypto";
import { enqueueWebhook } from "../queue/webhook-queue.js";
import { rawBodyPlugin } from "../plugins/raw-body.js";
import { webhookRoutes } from "../routes/webhook.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const TENANT_SLUG = "acme";
const APP_SLUG = "my-app";
const TOPIC = "orders/create";
const WEBHOOK_ID = "shopify-webhook-id-1";
const SECRET = "webhook-signing-secret";

const MOCK_CTX = {
  tenant: { id: "t-1", billingPlan: "starter" },
  app: { id: "a-1", shopifySecretName: "secret-name" },
  subscription: { id: "ws-1" },
  deployedFunction: { id: "df-1", functionUrl: "https://handler.run.app" },
};

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(rawBodyPlugin);
  await app.register(webhookRoutes);
  await app.ready();
  return app;
}

function webhookHeaders(extra: Record<string, string> = {}) {
  return {
    "x-shopify-hmac-sha256": "valid-hmac",
    "x-shopify-topic": TOPIC,
    "x-shopify-webhook-id": WEBHOOK_ID,
    "x-shopify-shop-domain": "acme.myshopify.com",
    "x-shopify-api-version": "2024-01",
    "content-type": "application/json",
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(resolveWebhookContext).mockResolvedValue(MOCK_CTX);
  vi.mocked(getSecret).mockResolvedValue(SECRET);
  vi.mocked(validateShopifyHmac).mockReturnValue(true);
  vi.mocked(hashPayload).mockReturnValue("hash-abc");
  vi.mocked(createWebhookInvocationLog).mockResolvedValue({
    id: "log-1",
    isDuplicate: false,
  } as never);
  vi.mocked(checkUsageQuota).mockResolvedValue({ allowed: true, current: 10, limit: 10_000 });
  vi.mocked(trackAppExecution).mockResolvedValue(undefined);
  vi.mocked(enqueueWebhook).mockResolvedValue({ id: "job-1" });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("happy path", () => {
  it("queues the webhook and returns 200 with executionLogId + jobId", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: `/${TENANT_SLUG}/${APP_SLUG}`,
      headers: webhookHeaders(),
      payload: JSON.stringify({ id: 123, topic: TOPIC }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("queued");
    expect(body.executionLogId).toBe("log-1");
    expect(body.jobId).toBe("job-1");
    expect(enqueueWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ topic: TOPIC, functionUrl: MOCK_CTX.deployedFunction.functionUrl }),
    );
    await server.close();
  });

  it("passes topic + shop headers through to the handler payload", async () => {
    const server = await buildApp();
    await server.inject({
      method: "POST",
      url: `/${TENANT_SLUG}/${APP_SLUG}`,
      headers: webhookHeaders({ "x-shopify-shop-domain": "mystore.myshopify.com" }),
      payload: "{}",
    });
    expect(enqueueWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ "x-shopify-shop-domain": "mystore.myshopify.com" }),
      }),
    );
    await server.close();
  });
});

// ─── HMAC validation ─────────────────────────────────────────────────────────

describe("HMAC validation", () => {
  it("returns 401 when HMAC validation fails", async () => {
    vi.mocked(validateShopifyHmac).mockReturnValue(false);
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: `/${TENANT_SLUG}/${APP_SLUG}`,
      headers: webhookHeaders({ "x-shopify-hmac-sha256": "badsig" }),
      payload: "{}",
    });
    expect(res.statusCode).toBe(401);
    expect(enqueueWebhook).not.toHaveBeenCalled();
    await server.close();
  });

  it("passes raw body bytes to validateShopifyHmac, not the parsed object", async () => {
    const server = await buildApp();
    await server.inject({
      method: "POST",
      url: `/${TENANT_SLUG}/${APP_SLUG}`,
      headers: webhookHeaders(),
      payload: '{"id":1}',
    });
    const [rawBodyArg] = vi.mocked(validateShopifyHmac).mock.calls[0]!;
    expect(Buffer.isBuffer(rawBodyArg)).toBe(true);
    await server.close();
  });
});

// ─── Missing / unknown context ────────────────────────────────────────────────

describe("context resolution", () => {
  it("returns 404 when no active app/subscription matches (tenantSlug/appSlug)", async () => {
    vi.mocked(resolveWebhookContext).mockResolvedValue(null);
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: `/${TENANT_SLUG}/${APP_SLUG}`,
      headers: webhookHeaders(),
      payload: "{}",
    });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it("returns 400 when the request body is empty", async () => {
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: `/${TENANT_SLUG}/${APP_SLUG}`,
      headers: { ...webhookHeaders(), "content-length": "0" },
      payload: "",
    });
    expect(res.statusCode).toBe(400);
    await server.close();
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("idempotency", () => {
  it("returns 200 with status=duplicate for a repeated webhookId — does not re-enqueue", async () => {
    vi.mocked(createWebhookInvocationLog).mockResolvedValue({
      id: "log-dup",
      isDuplicate: true,
    } as never);
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: `/${TENANT_SLUG}/${APP_SLUG}`,
      headers: webhookHeaders(),
      payload: "{}",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("duplicate");
    expect(enqueueWebhook).not.toHaveBeenCalled();
    expect(trackAppExecution).not.toHaveBeenCalled();
    await server.close();
  });
});

// ─── Quota enforcement ────────────────────────────────────────────────────────

describe("quota enforcement", () => {
  it("returns 200 with status=quota_exceeded and does not enqueue when over limit", async () => {
    vi.mocked(checkUsageQuota).mockResolvedValue({ allowed: false, current: 1000, limit: 1000 });
    const server = await buildApp();
    const res = await server.inject({
      method: "POST",
      url: `/${TENANT_SLUG}/${APP_SLUG}`,
      headers: webhookHeaders(),
      payload: "{}",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("quota_exceeded");
    expect(enqueueWebhook).not.toHaveBeenCalled();
    expect(trackAppExecution).not.toHaveBeenCalled();
    await server.close();
  });

  it("enforces the correct limit for the tenant's billing plan", async () => {
    vi.mocked(resolveWebhookContext).mockResolvedValue({
      ...MOCK_CTX,
      tenant: { id: "t-1", billingPlan: "free" },
    });
    const server = await buildApp();
    await server.inject({
      method: "POST",
      url: `/${TENANT_SLUG}/${APP_SLUG}`,
      headers: webhookHeaders(),
      payload: "{}",
    });
    const [, , limitArg] = vi.mocked(checkUsageQuota).mock.calls[0]!;
    // free plan = 1000 executions/month (per PLANS.free.limits.maxAppExecutionsPerMonth)
    expect(limitArg).toBe(1000);
    await server.close();
  });
});
