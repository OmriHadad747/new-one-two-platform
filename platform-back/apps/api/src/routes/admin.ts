import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { listAdminAppsForShop, resolveAppHandler } from "@platform-back/db";
import { createRequestLogger } from "@platform-back/logger";
import { ErrorCode, errorResponse } from "../lib/error-response.js";
import { ForwardError, forwardToHandler } from "../lib/forward.js";
import { verifyShopifySessionToken } from "../lib/shopify-session-token.js";
import { getAdminBundle } from "../lib/bundle-storage.js";

const SHOPIFY_CLIENT_ID = process.env["SHOPIFY_CLIENT_ID"] ?? "";
const SHOPIFY_CLIENT_SECRET = process.env["SHOPIFY_CLIENT_SECRET"] ?? "";
if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
  // Fail at boot, not on first request: a misconfigured edge that silently
  // 401s every admin click is worse than a noisy startup crash.
  throw new Error("FATAL: SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set");
}

// Hop-by-hop headers (RFC 7230 §6.1) plus a few headers we never want to
// leak from the upstream back to the browser. `Set-Cookie` is dropped
// because admin handlers should not be issuing cookies — auth flows
// through the App Bridge session token, not browser cookies.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
]);

interface AdminRouteParams {
  appId: string;
  "*": string;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Listing endpoint for the embedded Shopify Admin shell's left-nav.
  // Concrete path — must be registered before the `:appId/*` wildcard
  // so Fastify routes `/admin/apps` here and not into the proxy.
  // Unauthenticated by design: the response is just app metadata
  // (id / name / slug) scoped to the caller-supplied shop, matching
  // the pre-refactor /admin-ui/apps/:shop contract.
  app.get<{ Querystring: { shop?: string } }>("/apps", adminAppsListHandler);

  // Serve the generated admin panel ES module. Must be registered before the
  // wildcard proxy route so Fastify picks the more-specific path first.
  app.get<{ Params: { appId: string } }>("/:appId/panel.js", adminBundleHandler);

  app.route<{ Params: AdminRouteParams }>({
    method: ["POST", "OPTIONS"],
    url: "/:appId/*",
    handler: adminProxyHandler,
  });
}

async function adminAppsListHandler(
  request: FastifyRequest<{ Querystring: { shop?: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const shop = request.query.shop?.trim();
  if (!shop) {
    return reply
      .code(400)
      .send(errorResponse(ErrorCode.InvalidRequest, "Missing ?shop query param"));
  }

  const log = createRequestLogger({ requestId: request.id });
  let apps;
  try {
    apps = await listAdminAppsForShop(shop);
  } catch (err) {
    log.error({ err, shop }, "admin apps list: db query failed");
    return reply.code(500).send(errorResponse(ErrorCode.Internal, "Failed to list admin apps"));
  }

  log.debug({ shop, count: apps.length }, "admin apps list");
  return reply.send(apps);
}

async function adminBundleHandler(
  request: FastifyRequest<{ Params: { appId: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { appId } = request.params;
  const log = createRequestLogger({ requestId: request.id });

  let bundle: string | null;
  try {
    bundle = await getAdminBundle(appId);
  } catch (err) {
    log.error({ err, appId }, "admin bundle: storage read failed");
    return reply
      .code(500)
      .send(errorResponse(ErrorCode.Internal, "Failed to retrieve admin bundle"));
  }

  if (!bundle) {
    log.info({ appId }, "admin bundle: not found");
    return reply.code(404).send(errorResponse(ErrorCode.NotFound, "Admin bundle not found"));
  }

  return reply
    .code(200)
    .header("Content-Type", "application/javascript; charset=utf-8")
    .header("Cache-Control", "public, max-age=300")
    .send(bundle);
}

async function adminProxyHandler(
  request: FastifyRequest<{ Params: AdminRouteParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (request.method === "OPTIONS") {
    // CORS preflight is handled by the global hook in plugins/cors.ts; the
    // route just needs to exist so Fastify doesn't 404 the OPTIONS.
    return;
  }

  const { appId } = request.params;
  const subPath = request.params["*"] ?? "";
  const log = createRequestLogger({ requestId: request.id });

  // ── 1. Verify the Shopify App Bridge session token ────────────────────────
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    log.warn({ appId, subPath }, "admin edge: missing Authorization header");
    return reply
      .code(401)
      .send(errorResponse(ErrorCode.TokenMissing, "Missing Authorization header"));
  }

  const claims = verifyShopifySessionToken(
    authHeader.slice(7),
    SHOPIFY_CLIENT_ID,
    SHOPIFY_CLIENT_SECRET,
  );
  if (!claims) {
    log.warn({ appId, subPath }, "admin edge: invalid session token");
    return reply
      .code(401)
      .send(errorResponse(ErrorCode.TokenInvalid, "Invalid or expired session token"));
  }

  // ── 2. Resolve the active handler for (shop, app) ────────────────────────
  let resolved;
  try {
    resolved = await resolveAppHandler(claims.shop, appId);
  } catch (err) {
    log.error({ err, shop: claims.shop, appId }, "admin edge: handler lookup failed");
    return reply.code(500).send(errorResponse(ErrorCode.Internal, "Failed to resolve handler"));
  }

  if (!resolved) {
    log.info({ shop: claims.shop, appId }, "admin edge: no active deployed handler");
    return reply
      .code(503)
      .send(errorResponse(ErrorCode.BackendNotDeployed, "App backend is not deployed"));
  }

  // ── 3. Build target URL and forward ──────────────────────────────────────
  // we forward the full /admin/<path> to the handler so the
  // handler can route inbound trust domains by URL prefix.
  const targetUrl = `${resolved.functionUrl}/admin/${subPath}`;
  // fastify-raw-body captures the original bytes before JSON parsing.
  // Forwarding those verbatim preserves key order, whitespace, and any
  // exact-wire-format expectations the handler may have.
  const rawBody = (request as { rawBody?: Buffer }).rawBody;
  const contentType = request.headers["content-type"];

  log.debug(
    { targetUrl, shop: claims.shop, appId, tenantId: resolved.tenantId },
    "admin edge: forwarding",
  );

  let result;
  try {
    result = await forwardToHandler({
      targetUrl,
      method: "POST",
      body: rawBody,
      contentType: typeof contentType === "string" ? contentType : undefined,
      ctx: {
        tenantId: resolved.tenantId,
        shopDomain: claims.shop,
        appId,
        requestId: request.id,
      },
      log,
    });
  } catch (err) {
    if (err instanceof ForwardError) {
      if (err.kind === "timeout") {
        log.error({ targetUrl }, "admin edge: handler timeout");
        return reply
          .code(504)
          .send(errorResponse(ErrorCode.UpstreamTimeout, "Handler did not respond in time"));
      }
      if (err.kind === "auth") {
        log.error({ targetUrl }, "admin edge: ID-token mint failed");
        return reply
          .code(502)
          .send(errorResponse(ErrorCode.BadGateway, "Could not authenticate to handler"));
      }
    }
    log.error({ err, targetUrl }, "admin edge: upstream fetch failed");
    return reply.code(502).send(errorResponse(ErrorCode.BadGateway, "Handler upstream failure"));
  }

  // ── 4. Pipe response back ────────────────────────────────────────────────
  for (const [name, value] of result.headers.entries()) {
    if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    void reply.header(name, value);
  }
  return reply.code(result.status).send(result.body);
}
