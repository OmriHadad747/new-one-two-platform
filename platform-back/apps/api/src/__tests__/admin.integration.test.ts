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
import { forwardToHandler, ForwardError } from "../lib/forward.js";
import { adminRoutes } from "../routes/admin.js";

const mockResolve = vi.mocked(resolveAppHandler);
const mockForward = vi.mocked(forwardToHandler);

const CLIENT_ID = process.env["SHOPIFY_CLIENT_ID"]!;
const CLIENT_SECRET = process.env["SHOPIFY_CLIENT_SECRET"]!;
const APP_ID = "app-uuid-test";

function makeSessionToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://acme.myshopify.com/admin",
    dest: "https://acme.myshopify.com",
    aud: CLIENT_ID,
    sub: "user-42",
    exp: now + 3600,
    nbf: now - 10,
    iat: now - 10,
    ...overrides,
  };
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", CLIENT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(adminRoutes, { prefix: "/admin" });
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
  body: Buffer.from('{"result":"ok"}'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockResolvedValue(MOCK_RESOLVED);
  mockForward.mockResolvedValue(MOCK_FORWARD_RESULT);
});

describe("POST /admin/:appId/* — happy path", () => {
  it("forwards request and returns handler response", async () => {
    const app = await buildApp();
    const token = makeSessionToken();
    const res = await app.inject({
      method: "POST",
      url: `/admin/${APP_ID}/some/path`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "test" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith("acme.myshopify.com", APP_ID);
    expect(mockForward).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: `https://handler.example.com/admin/some/path`,
        method: "POST",
        ctx: expect.objectContaining({
          tenantId: "tenant-uuid",
          shopDomain: "acme.myshopify.com",
          appId: APP_ID,
        }),
      }),
    );
    await app.close();
  });

  it("strips hop-by-hop headers from handler response", async () => {
    mockForward.mockResolvedValue({
      ...MOCK_FORWARD_RESULT,
      headers: new Headers({
        "content-type": "application/json",
        // 'connection' is also managed by Fastify/Node itself, so check
        // set-cookie which Fastify never adds on its own
        "set-cookie": "session=abc",
        "x-custom-header": "should-pass-through",
      }),
    });
    const app = await buildApp();
    const token = makeSessionToken();
    const res = await app.inject({
      method: "POST",
      url: `/admin/${APP_ID}/ping`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["x-custom-header"]).toBe("should-pass-through");
    await app.close();
  });
});

describe("POST /admin/:appId/* — auth failures", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/admin/${APP_ID}/ping`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 for an invalid session token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/admin/${APP_ID}/ping`,
      headers: { authorization: "Bearer invalid.token.here" },
    });
    expect(res.statusCode).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /admin/:appId/* — backend not deployed", () => {
  it("returns 503 when handler is not deployed", async () => {
    mockResolve.mockResolvedValue(null);
    const app = await buildApp();
    const token = makeSessionToken();
    const res = await app.inject({
      method: "POST",
      url: `/admin/${APP_ID}/ping`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("POST /admin/:appId/* — forward errors", () => {
  it("returns 504 on handler timeout", async () => {
    mockForward.mockRejectedValue(new ForwardError("timeout", "timed out"));
    const app = await buildApp();
    const token = makeSessionToken();
    const res = await app.inject({
      method: "POST",
      url: `/admin/${APP_ID}/ping`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(504);
    await app.close();
  });

  it("returns 502 on handler auth error", async () => {
    mockForward.mockRejectedValue(new ForwardError("auth", "no token"));
    const app = await buildApp();
    const token = makeSessionToken();
    const res = await app.inject({
      method: "POST",
      url: `/admin/${APP_ID}/ping`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it("returns 502 on generic fetch failure", async () => {
    mockForward.mockRejectedValue(new ForwardError("fetch", "ECONNREFUSED"));
    const app = await buildApp();
    const token = makeSessionToken();
    const res = await app.inject({
      method: "POST",
      url: `/admin/${APP_ID}/ping`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});

describe("OPTIONS /admin/:appId/* — CORS preflight", () => {
  it("returns 200 for OPTIONS preflight without auth check", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: `/admin/${APP_ID}/ping`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockResolve).not.toHaveBeenCalled();
    await app.close();
  });
});
