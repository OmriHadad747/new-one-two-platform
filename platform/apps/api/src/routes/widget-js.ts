import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { resolveWidgetJs, resolveAppFunctionUrl } from "@new-one-two/db";
import { createRequestLogger } from "@new-one-two/logger";
import { trackAppExecution } from "@new-one-two/db";
import { parseBody } from "../lib/validate-body.js";
import { ErrorCode, errorResponse } from "../lib/error-response.js";
import { isOriginAllowedForShop } from "../lib/shop-domains.js";

// Same loose-object shape as the admin proxy (admin-ui.ts): the merchant
// handler's body contract is its own, but the top-level must be an object
// or the harness router breaks.
const WidgetProxyBodySchema = z.record(z.unknown()).default({});

// ─── GCS Config ───────────────────────────────────────────────────────────────
// In production (DEPLOY_MODE=cloudrun), widget JS is uploaded to GCS by the
// deployer. This route issues a 302 redirect so GCS serves the file directly.
// In local dev, falls back to reading from Postgres (existing behaviour).

const DEPLOY_MODE = process.env["DEPLOY_MODE"] ?? "cloudrun";
const GCS_BUNDLES_BUCKET =
  process.env["GCS_BUNDLES_BUCKET"] ?? "new-one-two-bundles";

function gcsWidgetUrl(appId: string): string {
  return `https://storage.googleapis.com/${GCS_BUNDLES_BUCKET}/widgets/${appId}/widget.js`;
}

// ─── Route Registration ────────────────────────────────────────────────────────

export async function widgetJsRoutes(app: FastifyInstance) {
  // CORS preflights are handled by the centralized middleware in
  // plugins/cors.ts. Because the widget path prefix is `/widgets/`, the
  // middleware reflects any origin (credentials off) — storefronts on
  // merchant custom domains are supported without an explicit allowlist
  // entry. Per-route manual `Access-Control-Allow-Origin: *` headers are
  // therefore redundant and have been removed from this file.

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
    widgetJsHandler,
  );

  app.post<{
    Params: { shop: string; appId: string; "*": string };
  }>("/:shop/:appId/widget/*", widgetProxyHandler);
}

// ─── Widget JS Handler ─────────────────────────────────────────────────────────

async function widgetJsHandler(
  request: FastifyRequest<{
    Params: { shop: string; appId: string };
  }>,
  reply: FastifyReply,
) {
  const { shop, appId } = request.params;
  const log = createRequestLogger({ requestId: request.id });

  // Production: redirect to GCS — browser fetches the file directly from
  // Google's edge, no Postgres read per page load.
  if (DEPLOY_MODE !== "local") {
    // Verify the widget exists in DB before redirecting (fast indexed lookup).
    const result = await resolveWidgetJs(shop, appId);
    if (!result) {
      log.debug({ shop, appId }, "No widget JS found");
      return reply.code(404).send("// Widget not found");
    }

    return reply
      .header("Cache-Control", "public, max-age=300")
      .redirect(302, gcsWidgetUrl(appId));
  }

  // Local dev: serve from Postgres (no GCS in dev)
  const result = await resolveWidgetJs(shop, appId);

  if (!result) {
    log.debug({ shop, appId }, "No widget JS found");
    return reply.code(404).send("// Widget not found");
  }

  log.debug({ shop, appId }, "Widget JS resolved");

  return reply
    .header("Content-Type", "application/javascript; charset=utf-8")
    .header("Cache-Control", "public, max-age=5")
    .code(200)
    .send(result.widgetJs);
}

// ─── Widget Proxy Handler ──────────────────────────────────────────────────────
// Forwards storefront widget calls to the deployed container.
// The container is internal-only (Docker network / Cloud Run INGRESS_TRAFFIC_INTERNAL_ONLY)
// and cannot be reached by the browser directly — all widget traffic routes through here.

async function widgetProxyHandler(
  request: FastifyRequest<{
    Params: { shop: string; appId: string; "*": string };
  }>,
  reply: FastifyReply,
) {
  const { shop, appId } = request.params;
  const path = request.params["*"];
  const log = createRequestLogger({ requestId: request.id });

  // Origin ownership check .
  //
  // CORS reflects any origin for /widgets/* because storefronts run on
  // arbitrary custom domains. That reflection is safe only because the
  // widget's `credentials: "omit"` keeps cookies off the request, and now
  // because this check confirms the caller is actually on the shop's own
  // storefront before we forward to the merchant's harness. evil.com gets
  // a 403 here even though CORS happily reflected its origin.
  //
  // In local dev (DEPLOY_MODE=local), isOriginAllowedForShop short-circuits
  // true so tunnels / preview domains / localhost aren't blocked.
  const origin = request.headers.origin;
  const originOk = await isOriginAllowedForShop(shop, origin, request.id);
  if (!originOk) {
    log.warn({ shop, appId, origin }, "Widget proxy: origin not owned by shop");
    return reply
      .code(403)
      .send(
        errorResponse(
          ErrorCode.AccessDenied,
          "Origin not allowed for this shop",
        ),
      );
  }

  const resolved = await resolveAppFunctionUrl(shop, appId);

  if (!resolved) {
    log.debug({ shop, appId }, "Widget proxy: no deployed function");
    return reply
      .code(503)
      .send(
        errorResponse(
          ErrorCode.BackendNotDeployed,
          "App backend is not deployed",
        ),
      );
  }

  const { functionUrl, tenantId } = resolved;
  const targetUrl = `${functionUrl}/widget/${path}`;
  log.debug({ shop, appId, path, targetUrl }, "Widget proxy forwarding");

  // Validate body shape at the proxy so the harness never sees a malformed
  // payload. See admin-ui.ts for the same pattern and rationale.
  const body = parseBody(WidgetProxyBodySchema, request, reply);
  if (body === null) return;

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shop-Domain": shop,
        "X-App-Id": appId,
        "X-Tenant-Id": tenantId,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      log.error(
        { shop, appId, path, status: res.status, data },
        "Widget proxy: harness returned error",
      );
    } else {
      void trackAppExecution(tenantId);
    }

    return reply
      .header(
        "Content-Type",
        res.headers.get("content-type") || "application/json",
      )
      .code(res.status)
      .send(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { message, shop, appId, path, targetUrl },
      "Widget proxy: fetch failed",
    );

    return reply
      .code(502)
      .send(errorResponse(ErrorCode.BadGateway, "Harness upstream failure"));
  }
}
