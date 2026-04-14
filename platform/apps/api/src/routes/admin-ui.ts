import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveAdminUiJs, resolveAppFunctionUrl, getAdminUiAppsByShop } from "@new-one-two/db";
import { createRequestLogger } from "@new-one-two/logger";
import { trackAppExecution } from "@new-one-two/db";

const SHOPIFY_CLIENT_ID = process.env["SHOPIFY_CLIENT_ID"] ?? "";
const SHOPIFY_CLIENT_SECRET = process.env["SHOPIFY_CLIENT_SECRET"] ?? "";

// ─── Route Registration ────────────────────────────────────────────────────────

export async function adminUiRoutes(app: FastifyInstance) {
  // ── CORS preflight ────────────────────────────────────────────────────────

  app.options("/:shop/:appId.js", async (_request, reply) => {
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET, OPTIONS")
      .header("Access-Control-Allow-Headers", "*")
      .code(204)
      .send();
  });

  app.options("/:shop/:appId/admin/*", async (_request, reply) => {
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "POST, OPTIONS")
      .header("Access-Control-Allow-Headers", "Content-Type, Authorization")
      .code(204)
      .send();
  });

  // ── GET /admin-ui/apps/:shop ──────────────────────────────────────────────
  // Returns metadata for all apps with an admin UI module for this shop.
  // Called by the embedded shell on load to build the sidebar.

  app.get<{ Params: { shop: string } }>(
    "/apps/:shop",
    {
      schema: {
        params: {
          type: "object",
          required: ["shop"],
          properties: {
            shop: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { shop } = request.params;
      const log = createRequestLogger({ requestId: request.id });

      const apps = await getAdminUiAppsByShop(shop);
      log.debug({ shop, count: apps.length }, "Admin UI apps listed");

      // Return only the metadata the sidebar needs — never expose JS code here
      return reply
        .header("Access-Control-Allow-Origin", "*")
        .send(apps.map((a) => ({ id: a.id, name: a.name, slug: a.slug })));
    }
  );

  // ── GET /admin-ui/:shop/:appId.js ─────────────────────────────────────────

  app.get<{
    Params: { shop: string; appId: string };
  }>(
    "/:shop/:appId.js",
    {
      schema: {
        params: {
          type: "object",
          required: ["shop", "appId"],
          properties: {
            shop: { type: "string", minLength: 1 },
            appId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    adminUiJsHandler
  );

  // ── POST /admin-ui/:shop/:appId/admin/* ───────────────────────────────────
  // Session token verification is enforced here before proxying to the harness.

  app.post<{
    Params: { shop: string; appId: string; "*": string };
  }>("/:shop/:appId/admin/*", adminProxyHandler);
}

// ─── Admin UI JS Handler ───────────────────────────────────────────────────────

async function adminUiJsHandler(
  request: FastifyRequest<{
    Params: { shop: string; appId: string };
  }>,
  reply: FastifyReply
) {
  const { shop, appId } = request.params;
  const log = createRequestLogger({ requestId: request.id });

  const result = await resolveAdminUiJs(shop, appId);

  if (!result) {
    log.debug({ shop, appId }, "No admin UI JS found");
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .code(404)
      .send("// Admin UI not found");
  }

  log.debug({ shop, appId }, "Admin UI JS resolved");

  return reply
    .header("Content-Type", "application/javascript; charset=utf-8")
    .header("Access-Control-Allow-Origin", "*")
    .header("Cache-Control", "public, max-age=5")
    .code(200)
    .send(result.adminUiJs);
}

// ─── Admin Proxy Handler ───────────────────────────────────────────────────────
// Verifies the Shopify session token (JWT) then proxies to the deployed harness.

async function adminProxyHandler(
  request: FastifyRequest<{
    Params: { shop: string; appId: string; "*": string };
  }>,
  reply: FastifyReply
) {
  const { shop, appId } = request.params;
  const path = request.params["*"];
  const log = createRequestLogger({ requestId: request.id });

  // ── Session token verification ────────────────────────────────────────────
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    log.warn({ shop, appId }, "Admin proxy: missing Authorization header");
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .code(401)
      .send({ error: "missing_token" });
  }

  const token = authHeader.slice(7);
  const verified = await verifyShopifySessionToken(token, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET);

  if (!verified) {
    log.warn({ shop, appId }, "Admin proxy: invalid or expired session token");
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .code(401)
      .send({ error: "invalid_token" });
  }

  // The token's `dest` must match the shop this request claims to be for
  if (verified.shop !== shop) {
    log.warn({ shop, appId, tokenShop: verified.shop }, "Admin proxy: token shop mismatch");
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .code(403)
      .send({ error: "shop_mismatch" });
  }

  // ── Resolve deployed function ─────────────────────────────────────────────
  const resolved = await resolveAppFunctionUrl(shop, appId);

  if (!resolved) {
    log.debug({ shop, appId }, "Admin proxy: no deployed function");
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .code(503)
      .send({ error: "backend_not_deployed" });
  }

  const { functionUrl, tenantId } = resolved;
  const targetUrl = `${functionUrl}/admin/${path}`;
  log.debug({ shop, appId, path, targetUrl }, "Admin proxy forwarding");

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shop-Domain": shop,
        "X-App-Id": appId,
        "X-Tenant-Id": tenantId,
      },
      body: JSON.stringify(request.body ?? {}),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      log.error({ shop, appId, path, status: res.status, data }, "Admin proxy: harness returned error");
    } else {
      void trackAppExecution(tenantId);
    }

    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Content-Type", res.headers.get("content-type") || "application/json")
      .code(res.status)
      .send(data);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ message, shop, appId, path, targetUrl }, "Admin proxy: fetch failed");

    return reply
      .header("Access-Control-Allow-Origin", "*")
      .code(502)
      .send({ error: "bad_gateway" });
  }
}

// ─── Session Token Verification ───────────────────────────────────────────────
// Shopify session tokens are HS256 JWTs signed with the app's client secret.
// Spec: https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens/verify-session-tokens

async function verifyShopifySessionToken(
  token: string,
  clientId: string,
  clientSecret: string
): Promise<{ shop: string; sub: string } | null> {
  if (!clientId || !clientSecret) return null;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

    // Verify HMAC-SHA256 signature
    const signingInput = `${headerB64}.${payloadB64}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(clientSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signature = base64UrlToBytes(sigB64);
    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(signingInput)
    );
    if (!isValid) return null;

    // Decode and validate claims
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf-8")
    ) as {
      iss?: string;
      dest?: string;
      aud?: string;
      sub?: string;
      exp?: number;
      nbf?: number;
    };

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp !== undefined && payload.exp < now) return null;
    if (payload.nbf !== undefined && payload.nbf > now) return null;
    if (payload.aud !== clientId) return null;
    if (!payload.dest) return null;

    // dest is "https://mystore.myshopify.com" — strip the scheme
    const shop = payload.dest.replace(/^https?:\/\//, "");

    return { shop, sub: payload.sub ?? "" };
  } catch {
    return null;
  }
}

function base64UrlToBytes(b64url: string): Uint8Array {
  // Convert base64url → base64 → binary
  const base64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
