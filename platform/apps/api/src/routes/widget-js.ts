import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveWidgetJs, resolveAppFunctionUrl } from "@new-one-two/db";
import { createRequestLogger } from "@new-one-two/logger";

// ─── Route Registration ────────────────────────────────────────────────────────

export async function widgetJsRoutes(app: FastifyInstance) {
  app.options("/:shop/:appId.js", async (_request, reply) => {
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET, OPTIONS")
      .header("Access-Control-Allow-Headers", "*")
      .code(204)
      .send();
  });

  app.options("/:shop/:appId/widget/*", async (_request, reply) => {
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "POST, OPTIONS")
      .header("Access-Control-Allow-Headers", "*")
      .code(204)
      .send();
  });

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
    widgetJsHandler
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
  reply: FastifyReply
) {
  const { shop, appId } = request.params;
  const log = createRequestLogger({ requestId: request.id });

  const result = await resolveWidgetJs(shop, appId);

  if (!result) {
    log.debug({ shop, appId }, "No widget JS found");
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .code(404)
      .send("// Widget not found");
  }

  log.debug({ shop, appId }, "Widget JS resolved");

  return reply
    .header("Content-Type", "application/javascript; charset=utf-8")
    .header("Access-Control-Allow-Origin", "*")
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
  reply: FastifyReply
) {
  const { shop, appId } = request.params;
  const path = request.params["*"];
  const log = createRequestLogger({ requestId: request.id });

  const resolved = await resolveAppFunctionUrl(shop, appId);

  if (!resolved) {
    log.debug({ shop, appId }, "Widget proxy: no deployed function");
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .code(503)
      .send({ error: "backend_not_deployed" });
  }

  const { functionUrl, tenantId } = resolved;
  const targetUrl = `${functionUrl}/widget/${path}`;
  log.debug({ shop, appId, path, targetUrl }, "Widget proxy forwarding");

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shop-Domain": shop,
        "X-App-Id": appId,
        "X-Tenant-Id": tenantId,
      },
      // Ensure body is sent as string; default to empty object string if null
      body: JSON.stringify(request.body ?? {}),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      log.error({ shop, appId, path, status: res.status, data }, "Widget proxy: harness returned error");
    }

    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Content-Type", res.headers.get("content-type") || "application/json")
      .code(res.status)
      .send(data);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ message, shop, appId, path, targetUrl }, "Widget proxy: fetch failed");

    return reply
      .header("Access-Control-Allow-Origin", "*")
      .code(502)
      .send({ error: "bad_gateway" });
  }
}
