import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { createHmac } from "node:crypto";

vi.mock("@platform-back/db", () => ({
  resolveAppHandler: vi.fn(),
}));
vi.mock("../lib/forward.js", () => ({
  forwardToHandler: vi.fn(),
  ForwardError: class ForwardError extends Error {
    kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.kind = kind;
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
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { resolveAppHandler } from "@platform-back/db";
import { forwardToHandler } from "../lib/forward.js";
import { widgetRoutes } from "../routes/widget.js";

const mockResolve = vi.mocked(resolveAppHandler);
const mockForward = vi.mocked(forwardToHandler);

const CLIENT_SECRET = process.env["SHOPIFY_CLIENT_SECRET"]!;
const APP_ID = "app-uuid-test";

function signQuery(
  params: Record<string, string>,
  secret: string = CLIENT_SECRET,
): Record<string, string> {
  const keys = Object.keys(params).sort();
  const canonical = keys.map((k) => `${k}=${params[k]}`).join("");
  const sig = createHmac("sha256", secret).update(canonical).digest("hex");
  return { ...params, signature: sig };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

const BASE_QUERY = {
  shop: "acme.myshopify.com",
  timestamp: String(nowSec()),
};

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(widgetRoutes, { prefix: "/widget" });
  await app.ready();
  return app;
}

const MOCK_RESOLVED = {
  functionUrl: "https://handler.example.com",
  tenantId: "tenant-uuid",
};
const MOCK_FORWARD_RESULT = {
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  body: Buffer.from('{"data":"hello"}'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockResolvedValue(MOCK_RESOLVED);
  mockForward.mockResolvedValue(MOCK_FORWARD_RESULT);
});

describe("GET /widget/:appId/* — happy path (guest)", () => {
  it("forwards request without X-Customer-Id for unauthenticated visitor", async () => {
    const query = signQuery(BASE_QUERY);
    const qs = new URLSearchParams(query).toString();
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/widget/${APP_ID}/products?${qs}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith("acme.myshopify.com", APP_ID);
    expect(mockForward).toHaveBeenCalledWith(
      expect.objectContaining({
        extraHeaders: expect.not.objectContaining({ "X-Customer-Id": expect.anything() }),
      }),
    );
    await app.close();
  });
});

describe("GET /widget/:appId/* — logged-in customer", () => {
  it("forwards X-Customer-Id when logged_in_customer_id is signed", async () => {
    const query = signQuery({
      ...BASE_QUERY,
      logged_in_customer_id: "cust-999",
    });
    const qs = new URLSearchParams(query).toString();
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/widget/${APP_ID}/cart?${qs}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mockForward).toHaveBeenCalledWith(
      expect.objectContaining({
        extraHeaders: expect.objectContaining({ "X-Customer-Id": "cust-999" }),
      }),
    );
    await app.close();
  });
});

describe("GET /widget/:appId/* — proxy-only params stripped", () => {
  it("does not forward signature, timestamp, path_prefix to handler URL", async () => {
    const query = signQuery({
      ...BASE_QUERY,
      path_prefix: "/apps/my-app",
      product_id: "42",
    });
    const qs = new URLSearchParams(query).toString();
    const app = await buildApp();

    await app.inject({
      method: "GET",
      url: `/widget/${APP_ID}/product?${qs}`,
    });

    const forwardArg = mockForward.mock.calls[0]?.[0];
    expect(forwardArg?.targetUrl).not.toContain("signature=");
    expect(forwardArg?.targetUrl).not.toContain("timestamp=");
    expect(forwardArg?.targetUrl).not.toContain("path_prefix=");
    // app data IS forwarded
    expect(forwardArg?.targetUrl).toContain("product_id=42");
    await app.close();
  });
});

describe("GET /widget/:appId/* — auth failures", () => {
  it("returns 401 when signature is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/widget/${APP_ID}/ping?shop=acme.myshopify.com&timestamp=${nowSec()}`,
    });
    expect(res.statusCode).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 401 when signature is invalid", async () => {
    const query = signQuery(BASE_QUERY, "wrong-secret");
    const qs = new URLSearchParams(query).toString();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/widget/${APP_ID}/ping?${qs}`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 when timestamp is too old", async () => {
    const stale = String(nowSec() - 6 * 60);
    const query = signQuery({ ...BASE_QUERY, timestamp: stale });
    const qs = new URLSearchParams(query).toString();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/widget/${APP_ID}/ping?${qs}`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /widget/:appId/* — backend not deployed", () => {
  it("returns 503 when no deployed handler", async () => {
    mockResolve.mockResolvedValue(null);
    const query = signQuery(BASE_QUERY);
    const qs = new URLSearchParams(query).toString();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/widget/${APP_ID}/ping?${qs}`,
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
