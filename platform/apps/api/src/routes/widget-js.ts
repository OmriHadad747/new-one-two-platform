import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveWidgetJs, resolveAppFunctionUrl } from "@new-one-two/db";
import { createRequestLogger } from "@new-one-two/logger";

// ─── Route Registration ────────────────────────────────────────────────────────

export async function widgetJsRoutes(app: FastifyInstance) {
  // CORS preflight for widget JS fetch
  app.options("/:shop/:appId.js", async (_request, reply) => {
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET, OPTIONS")
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

  // CORS preflight for widget proxy calls
  app.options("/:shop/:appId/widget/*", async (_request, reply) => {
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "POST, OPTIONS")
      .header("Access-Control-Allow-Headers", "*")
      .code(204)
      .send();
  });

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
    return reply.code(404).send("// Widget not found");
  }

  log.debug({ shop, appId }, "Widget JS resolved");

  // CORS: widget JS is fetched by the runtime from a Shopify storefront domain.
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

  const functionUrl = await resolveAppFunctionUrl(shop, appId);

  if (!functionUrl) {
    log.debug({ shop, appId }, "Widget proxy: no deployed function");
    return reply
      .header("Access-Control-Allow-Origin", "*")
      .code(503)
      .send({ error: "backend_not_deployed" });
  }

  const targetUrl = `${functionUrl}/widget/${path}`;
  log.debug({ shop, appId, path, targetUrl }, "Widget proxy forwarding");

  const res = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shop-Domain": shop,
      "X-App-Id": appId,
    },
    body: JSON.stringify(request.body ?? {}),
  });

  const data = await res.json();

  return reply
    .header("Access-Control-Allow-Origin", "*")
    .code(res.status)
    .send(data);
}
