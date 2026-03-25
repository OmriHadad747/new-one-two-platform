import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveWidgetJs } from "@new-one-two/db";
import { createRequestLogger } from "@new-one-two/logger";

// ─── Route Registration ────────────────────────────────────────────────────────

export async function widgetJsRoutes(app: FastifyInstance) {
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
}

// ─── Handler ───────────────────────────────────────────────────────────────────

async function widgetJsHandler(
  request: FastifyRequest<{
    Params: { shop: string; appId: string };
  }>,
  reply: FastifyReply
) {
  const { shop, appId } = request.params;
  const log = createRequestLogger({ requestId: request.id });

  const widgetJs = await resolveWidgetJs(shop, appId);

  if (!widgetJs) {
    log.debug({ shop, appId }, "No widget JS found");
    return reply.code(404).send("// Widget not found");
  }

  log.debug({ shop, appId }, "Widget JS resolved");

  // CORS: widget JS is fetched by the runtime from a Shopify storefront domain.
  // We allow all origins — the widget itself is sandboxed by the host API contract.
  return reply
    .header("Content-Type", "application/javascript; charset=utf-8")
    .header("Access-Control-Allow-Origin", "*")
    .header("Cache-Control", "public, max-age=5")
    .code(200)
    .send(widgetJs);
}
