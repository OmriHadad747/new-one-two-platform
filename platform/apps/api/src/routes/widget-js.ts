import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveWidgetJs } from "@new-one-two/db";
import { createRequestLogger } from "@new-one-two/logger";

// ─── Route Registration ────────────────────────────────────────────────────────

export async function widgetJsRoutes(app: FastifyInstance) {
  // CORS preflight — browsers send OPTIONS before the actual GET when custom headers
  // are present (e.g. ngrok-skip-browser-warning in dev, or any future custom header).
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

  const result = await resolveWidgetJs(shop, appId);

  if (!result) {
    log.debug({ shop, appId }, "No widget JS found");
    return reply.code(404).send("// Widget not found");
  }

  log.debug({ shop, appId, hasBackend: !!result.functionUrl }, "Widget JS resolved");

  // Prepend the backend URL so the widget runtime can call the app's deployed
  // function directly without routing through the platform on every widget interaction.
  // The runtime reads __BACKEND_URL__ from the module exports after dynamic import.
  const backendUrlExport = `export const __BACKEND_URL__ = ${JSON.stringify(result.functionUrl)};\n`;
  const fullJs = backendUrlExport + result.widgetJs;

  // CORS: widget JS is fetched by the runtime from a Shopify storefront domain.
  // We allow all origins — the widget itself is sandboxed by the host API contract.
  return reply
    .header("Content-Type", "application/javascript; charset=utf-8")
    .header("Access-Control-Allow-Origin", "*")
    .header("Cache-Control", "public, max-age=5")
    .code(200)
    .send(fullJs);
}
