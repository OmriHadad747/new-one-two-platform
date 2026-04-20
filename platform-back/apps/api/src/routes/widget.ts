import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveAppHandler } from "@platform-back/db";
import { createRequestLogger } from "@platform-back/logger";
import { ErrorCode, errorResponse } from "../lib/error-response.js";
import { ForwardError, forwardToHandler } from "../lib/forward.js";
import { verifyShopifyAppProxy } from "../lib/shopify-app-proxy.js";

const SHOPIFY_CLIENT_SECRET = process.env["SHOPIFY_CLIENT_SECRET"] ?? "";
if (!SHOPIFY_CLIENT_SECRET) {
  // Mirrors admin.ts — a misconfigured edge that silently 401s every
  // storefront widget hit is worse than a noisy startup crash.
  throw new Error("FATAL: SHOPIFY_CLIENT_SECRET must be set");
}

// Same list as admin.ts. Set-Cookie is dropped deliberately: storefront
// widgets authenticate via Shopify App Proxy signatures on every hit,
// not via sticky cookies.
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

// App Proxy params the handler should never receive — they're signing
// metadata, not app data. `shop` is kept: handlers routinely key off it
// and it's now signature-verified, so passing it through is safe.
const PROXY_ONLY_PARAMS = new Set(["signature", "timestamp", "path_prefix"]);

interface WidgetRouteParams {
  appId: string;
  "*": string;
}

export async function widgetRoutes(app: FastifyInstance): Promise<void> {
  app.route<{ Params: WidgetRouteParams }>({
    method: ["GET", "POST", "OPTIONS"],
    url: "/:appId/*",
    handler: widgetProxyHandler,
  });
}

async function widgetProxyHandler(
  request: FastifyRequest<{ Params: WidgetRouteParams }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (request.method === "OPTIONS") {
    // CORS preflight is handled by the global hook in plugins/cors.ts.
    return;
  }

  const { appId } = request.params;
  const subPath = request.params["*"] ?? "";
  const log = createRequestLogger({ requestId: request.id });

  // ── 1. Verify Shopify App Proxy signature ────────────────────────────────
  const query = request.query as Record<string, string | string[] | undefined>;
  const claims = verifyShopifyAppProxy(query, SHOPIFY_CLIENT_SECRET);
  if (!claims) {
    log.warn({ appId, subPath }, "widget edge: invalid App Proxy signature");
    return reply
      .code(401)
      .send(
        errorResponse(
          ErrorCode.TokenInvalid,
          "Invalid or expired App Proxy signature",
        ),
      );
  }

  // ── 2. Resolve handler for (shop, app) — enforces ownership ──────────────
  let resolved;
  try {
    resolved = await resolveAppHandler(claims.shop, appId);
  } catch (err) {
    log.error(
      { err, shop: claims.shop, appId },
      "widget edge: handler lookup failed",
    );
    return reply
      .code(500)
      .send(errorResponse(ErrorCode.Internal, "Failed to resolve handler"));
  }
  if (!resolved) {
    log.info(
      { shop: claims.shop, appId },
      "widget edge: no active deployed handler",
    );
    return reply
      .code(503)
      .send(
        errorResponse(
          ErrorCode.BackendNotDeployed,
          "App backend is not deployed",
        ),
      );
  }

  // ── 3. Build forwarded URL and body ──────────────────────────────────────
  // Drop App Proxy signing metadata from the forwarded query string — the
  // handler shouldn't see anything that looks like trusted auth data
  // after it's already been consumed by the edge.
  const forwardedQuery = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (PROXY_ONLY_PARAMS.has(k)) continue;
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) forwardedQuery.append(k, item);
    } else {
      forwardedQuery.append(k, v);
    }
  }
  const qs = forwardedQuery.toString();
  const targetUrl = `${resolved.functionUrl}/widget/${subPath}${qs ? `?${qs}` : ""}`;

  // Forward bytes verbatim on non-GET. On GET, no body.
  let rawBody: Buffer | undefined;
  if (request.method !== "GET") {
    rawBody =
      request.body instanceof Buffer
        ? request.body
        : request.body === undefined || request.body === null
          ? undefined
          : Buffer.from(JSON.stringify(request.body));
  }
  const contentType = request.headers["content-type"];

  // Customer identity flows as X-Customer-Id when the visitor is logged in.
  // Absent header = guest traffic — handler decides whether that's allowed.
  const extraHeaders: Record<string, string> = {};
  if (claims.loggedInCustomerId) {
    extraHeaders["X-Customer-Id"] = claims.loggedInCustomerId;
  }

  log.debug(
    {
      targetUrl,
      shop: claims.shop,
      appId,
      tenantId: resolved.tenantId,
      hasCustomer: Boolean(claims.loggedInCustomerId),
    },
    "widget edge: forwarding",
  );

  // ── 4. Forward and pipe back ─────────────────────────────────────────────
  let result;
  try {
    result = await forwardToHandler({
      targetUrl,
      method: request.method,
      body: rawBody,
      contentType: typeof contentType === "string" ? contentType : undefined,
      ctx: {
        tenantId: resolved.tenantId,
        shopDomain: claims.shop,
        appId,
        requestId: request.id,
      },
      extraHeaders,
      log,
    });
  } catch (err) {
    if (err instanceof ForwardError) {
      if (err.kind === "timeout") {
        log.error({ targetUrl }, "widget edge: handler timeout");
        return reply
          .code(504)
          .send(
            errorResponse(
              ErrorCode.UpstreamTimeout,
              "Handler did not respond in time",
            ),
          );
      }
      if (err.kind === "auth") {
        log.error({ targetUrl }, "widget edge: ID-token mint failed");
        return reply
          .code(502)
          .send(
            errorResponse(
              ErrorCode.BadGateway,
              "Could not authenticate to handler",
            ),
          );
      }
    }
    log.error({ err, targetUrl }, "widget edge: upstream fetch failed");
    return reply
      .code(502)
      .send(errorResponse(ErrorCode.BadGateway, "Handler upstream failure"));
  }

  for (const [name, value] of result.headers.entries()) {
    if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    void reply.header(name, value);
  }
  return reply.code(result.status).send(result.body);
}
