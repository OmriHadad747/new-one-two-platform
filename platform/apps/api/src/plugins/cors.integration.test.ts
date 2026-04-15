// Integration test for the installCors hook.
//
// cors.test.ts covers the pure helpers (matchOrigin, parseAllowedOrigins,
// assertProductionCorsConfig) — but the actual policy contract lives in the
// onRequest hook: reflect vs. allowlist, credentials on/off, preflight-
// interception before auth, and header accumulation on the reply.
//
// Reviewer on PR #14 asked for these five scenarios explicitly:
//   1. preflight from an allowlisted origin returns 204 + full CORS headers
//   2. preflight from an unlisted origin returns 204 without ACA headers
//   3. preflight under /widgets/ reflects any origin, without credentials
//   4. auth hook registered AFTER cors is skipped on preflight (OPTIONS)
//   5. hook ordering: cors runs before any hook that could short-circuit
//
// We spin up a fresh Fastify for each case — no @new-one-two/db / pubsub
// dependencies touched — and assert the response headers via app.inject().

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { installCors } from "./cors.js";

const ALLOWED = [
  "https://admin.shopify.com",
  "https://*.myshopify.com",
  "https://dashboard.example.com",
];

const disposables: FastifyInstance[] = [];

afterEach(async () => {
  while (disposables.length > 0) {
    const app = disposables.pop()!;
    await app.close();
  }
});

function buildApp(options?: {
  afterCorsHook?: (app: FastifyInstance) => void;
}): FastifyInstance {
  const app = Fastify({ logger: false });
  installCors(app, { allowedOrigins: ALLOWED });
  options?.afterCorsHook?.(app);

  // Minimal routes representing the shape the real server exposes. The
  // handlers return a sentinel so we can tell when a request reaches them
  // (vs. being short-circuited by the preflight branch of the CORS hook).
  app.post("/generation", async () => ({ handler: "generation" }));
  app.post("/widgets/acme.myshopify.com/app/widget/subscribe", async () => ({
    handler: "widget",
  }));
  disposables.push(app);
  return app;
}

describe("installCors — preflight from allowlisted origin", () => {
  it("returns 204 with origin reflected, methods, credentials, and Vary", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/generation",
      headers: {
        origin: "https://admin.shopify.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "Content-Type, Authorization",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://admin.shopify.com"
    );
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["access-control-allow-methods"]).toMatch(/POST/);
    expect(res.headers["access-control-allow-headers"]).toBe(
      "Content-Type, Authorization"
    );
    expect(res.headers["access-control-max-age"]).toBeDefined();
    expect(res.headers.vary).toBe("Origin");
  });

  it("accepts a wildcard-allowlisted subdomain", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/generation",
      headers: {
        origin: "https://somestore.myshopify.com",
        "access-control-request-method": "POST",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://somestore.myshopify.com"
    );
  });
});

describe("installCors — preflight from unlisted origin", () => {
  it("returns 204 with no CORS headers (browser rejects)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/generation",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "POST",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
  });

  it("rejects the suffix-trick on wildcard entries", async () => {
    // `https://*.myshopify.com` must NOT match `evilmyshopify.com`.
    const app = buildApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/generation",
      headers: {
        origin: "https://evilmyshopify.com",
        "access-control-request-method": "POST",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("installCors — /widgets/ reflects any origin", () => {
  it("reflects a custom-domain storefront origin without credentials", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/widgets/acme.myshopify.com/app/widget/subscribe",
      headers: {
        origin: "https://shop.mybrand.com",
        "access-control-request-method": "POST",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://shop.mybrand.com"
    );
    // No credentials on the widget bypass — see cors.ts for the rationale.
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers.vary).toBe("Origin");
  });

  it("non-preflight GET/POST from a custom storefront sees ACA-Origin in the response", async () => {
    // Regression: the onRequest hook must set the reflect header before
    // the route handler runs, not only on OPTIONS.
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/widgets/acme.myshopify.com/app/widget/subscribe",
      headers: {
        origin: "https://shop.mybrand.com",
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://shop.mybrand.com"
    );
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("installCors — preflight bypasses downstream hooks", () => {
  it("OPTIONS preflight is answered without touching an after-cors auth hook that would 401", async () => {
    // Simulates the real server's order: cors → auth hook → route handlers.
    // If the auth hook fires on the OPTIONS preflight, the browser's actual
    // request never makes it past the preflight.
    let authInvokedOn: string[] = [];
    const app = buildApp({
      afterCorsHook(scope) {
        scope.addHook("onRequest", (req, reply, done) => {
          authInvokedOn.push(req.method);
          // Auth fires — always 401. If this runs on OPTIONS, the preflight
          // fails and real requests never happen.
          void reply.code(401).send({ error: "auth required" });
        });
      },
    });

    const res = await app.inject({
      method: "OPTIONS",
      url: "/generation",
      headers: {
        origin: "https://admin.shopify.com",
        "access-control-request-method": "POST",
      },
    });

    // The preflight must have completed with the CORS response — not the
    // 401 from the dummy auth hook. The auth hook should NOT have been
    // invoked for the OPTIONS preflight (our hook returns early via send()
    // which stops the chain).
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://admin.shopify.com"
    );
    expect(authInvokedOn).not.toContain("OPTIONS");
  });
});

describe("installCors — non-browser requests pass through", () => {
  it("request without an Origin header is left alone", async () => {
    // Server-to-server, curl, and same-origin calls omit Origin — nothing
    // to negotiate, and the hook must not touch the response headers.
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/generation",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});
