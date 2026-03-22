import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveWidgetConfig } from "@new-one-two/db";
import { createRequestLogger } from "@new-one-two/logger";

// ─── Route Registration ────────────────────────────────────────────────────────

export async function widgetConfigRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { shop: string; product_id?: string };
  }>(
    "/",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["shop"],
          properties: {
            shop: { type: "string", minLength: 1 },
            product_id: { type: "string" },
          },
        },
      },
    },
    widgetConfigHandler
  );
}

// ─── Handler ───────────────────────────────────────────────────────────────────

async function widgetConfigHandler(
  request: FastifyRequest<{
    Querystring: { shop: string; product_id?: string };
  }>,
  reply: FastifyReply
) {
  const { shop } = request.query;

  const log = createRequestLogger({ requestId: request.id });

  const widgetConfig = await resolveWidgetConfig(shop);

  if (!widgetConfig) {
    // No storefront UI configured for this shop — App Block renders nothing
    log.debug({ shop }, "No widget config found for shop");
    return reply.code(404).send({ error: "Not found" });
  }

  log.debug({ shop, widgetType: widgetConfig.widget_type }, "Widget config resolved");

  // Cache for 60s — App Block fetches this on every storefront page load
  return reply
    .header("Cache-Control", "public, max-age=60")
    .code(200)
    .send(widgetConfig);
}
