import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

vi.mock("@platform-back/db", () => ({
  getTenantBasics: vi.fn(),
}));
vi.mock("../lib/sa-to-app.js", () => ({
  resolveAppFromSaEmail: vi.fn(),
  invalidateSaCache: vi.fn(),
  clearSaCache: vi.fn(),
}));
vi.mock("../lib/verify-id-token.js", () => ({
  verifyCallerIdToken: vi.fn(),
}));
vi.mock("@platform-back/email", () => ({
  sendEmail: vi.fn(),
  QuotaExceededError: class QuotaExceededError extends Error {
    limit: number;
    current: number;
    resetsAt: null;
    constructor(limit: number, current: number) {
      super(`Quota exceeded`);
      this.name = "QuotaExceededError";
      this.limit = limit;
      this.current = current;
      this.resetsAt = null;
    }
  },
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

import { getTenantBasics } from "@platform-back/db";
import { resolveAppFromSaEmail } from "../lib/sa-to-app.js";
import { verifyCallerIdToken } from "../lib/verify-id-token.js";
import { sendEmail, QuotaExceededError } from "@platform-back/email";
import { emailServiceRoutes } from "../routes/services/email.js";

const mockGetTenant = vi.mocked(getTenantBasics);
const mockResolveApp = vi.mocked(resolveAppFromSaEmail);
const mockVerify = vi.mocked(verifyCallerIdToken);
const mockSend = vi.mocked(sendEmail);

const SA_EMAIL = "h-acme-1@test.iam.gserviceaccount.com";
const TENANT_BASICS = {
  id: "tenant-1",
  shopDomain: "acme.myshopify.com",
  storeName: "Acme Store",
  plan: "starter" as const,
};
const IDENTITY = { tenantId: "tenant-1", appId: "app-1" };

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(emailServiceRoutes, { prefix: "/services/email" });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ ok: true, caller: { email: SA_EMAIL } } as never);
  mockResolveApp.mockResolvedValue(IDENTITY);
  mockGetTenant.mockResolvedValue(TENANT_BASICS);
  mockSend.mockResolvedValue({ ok: true, delivered: true, deliveryId: "del-1" });
});

describe("POST /services/email/send — happy path", () => {
  it("returns 200 with delivered=true on successful send", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/email/send",
      headers: { authorization: "Bearer fake-oidc-token" },
      payload: { to: "customer@example.com", data: { name: "Alice" } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        appId: "app-1",
        recipient: "customer@example.com",
        storeName: "Acme Store",
        plan: "starter",
      }),
    );
    await app.close();
  });

  it("propagates isTest flag through to sendEmail", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/services/email/send",
      headers: { authorization: "Bearer fake-oidc-token" },
      payload: { to: "me@example.com", data: {}, isTest: true },
    });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ isTest: true }));
    await app.close();
  });

  it("returns 200 with delivered=false on suppression", async () => {
    mockSend.mockResolvedValue({ ok: true, delivered: false, reason: "suppressed" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/email/send",
      headers: { authorization: "Bearer fake-oidc-token" },
      payload: { to: "customer@example.com", data: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe("suppressed");
    await app.close();
  });
});

describe("POST /services/email/send — auth failures", () => {
  it("returns 401 when Authorization header is missing", async () => {
    mockVerify.mockResolvedValue({ ok: false, reason: "missing_token" } as never);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/email/send",
      payload: { to: "x@example.com", data: {} },
    });
    expect(res.statusCode).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 403 when SA email is not bound to an active app", async () => {
    mockResolveApp.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/email/send",
      headers: { authorization: "Bearer fake-oidc-token" },
      payload: { to: "x@example.com", data: {} },
    });
    expect(res.statusCode).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /services/email/send — quota exceeded", () => {
  it("returns 429 when sendEmail throws QuotaExceededError", async () => {
    mockSend.mockRejectedValue(new QuotaExceededError(500, 500));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/email/send",
      headers: { authorization: "Bearer fake-oidc-token" },
      payload: { to: "x@example.com", data: {} },
    });
    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body).toMatchObject({ limit: 500, current: 500 });
    await app.close();
  });
});

describe("POST /services/email/send — request validation", () => {
  it("returns 400 for invalid email address", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/email/send",
      headers: { authorization: "Bearer fake-oidc-token" },
      payload: { to: "not-an-email", data: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 400 when 'to' field is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/email/send",
      headers: { authorization: "Bearer fake-oidc-token" },
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /services/email/send-batch — happy path", () => {
  it("returns 207 with per-item results in { items } array", async () => {
    mockSend
      .mockResolvedValueOnce({ ok: true, delivered: true, deliveryId: "del-1" })
      .mockResolvedValueOnce({ ok: true, delivered: false, reason: "suppressed" });

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/email/send-batch",
      headers: { authorization: "Bearer fake-oidc-token" },
      payload: {
        items: [
          { to: "a@example.com", data: {} },
          { to: "b@example.com", data: {} },
        ],
      },
    });

    expect(res.statusCode).toBe(207);
    const body = res.json<{ items: Array<{ index: number; status: number }> }>();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.status).toBe(200);
    expect(body.items[1]?.status).toBe(200);
    await app.close();
  });

  it("marks remaining items as quota_exceeded (207) once quota is hit mid-batch", async () => {
    // Batch always returns 207; quota-hit items appear with status:429 in the array.
    mockSend
      .mockResolvedValueOnce({ ok: true, delivered: true, deliveryId: "del-1" })
      .mockRejectedValueOnce(new QuotaExceededError(10, 10));

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/services/email/send-batch",
      headers: { authorization: "Bearer fake-oidc-token" },
      payload: {
        items: [
          { to: "a@example.com", data: {} },
          { to: "b@example.com", data: {} },
          { to: "c@example.com", data: {} },
        ],
      },
    });

    expect(res.statusCode).toBe(207);
    const body = res.json<{ items: Array<{ index: number; status: number }> }>();
    expect(body.items).toHaveLength(3);
    expect(body.items[0]?.status).toBe(200);
    expect(body.items[1]?.status).toBe(429);
    expect(body.items[2]?.status).toBe(429); // carried forward from quota hit
    // sendEmail called twice: first succeeds, second throws
    expect(mockSend).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
