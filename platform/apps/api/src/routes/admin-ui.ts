import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveAdminUiJs, resolveAppFunctionUrl } from "@new-one-two/db";
import { createRequestLogger } from "@new-one-two/logger";

// ─── Route Registration ────────────────────────────────────────────────────────

export async function adminUiRoutes(app: FastifyInstance) {
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
    adminUiJsHandler
  );

  app.post<{
    Params: { shop: string; appId: string; "*": string };
  }>("/:shop/:appId/admin/*", adminProxyHandler);
}

// ─── Admin UI JS Handler ───────────────────────────────────────────────────────
// Serves the admin UI ES module to the Shopify admin extension iframe.

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
// Forwards bridge.call() requests from the admin UI to the deployed harness container.
// The container is internal-only — all admin traffic routes through here.

async function adminProxyHandler(
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
