import Fastify from "fastify";
import { logger } from "@new-one-two/logger";
import type { HarnessInvokeRequest } from "@new-one-two/types";
import { handleWebhookInvoke } from "./webhook-handler.js";
import { handleWidgetInvoke } from "./widget-handler.js";
import { handleAdminInvoke } from "./admin-handler.js";
import { loadModule } from "./module-loader.js";

const PORT = parseInt(process.env["PORT"] ?? "8080", 10);

const app = Fastify({
  logger: false, // use our own pino instance
  trustProxy: true,
});

app.get("/health", async () => ({ status: "ok" }));

app.post<{ Params: { "*": string }; Body: Record<string, unknown> }>(
  "/admin/*",
  async (request, reply) => {
    const adminPath = "/" + request.params["*"];
    const tenantId = request.headers["x-tenant-id"] as string | undefined;

    if (!tenantId) {
      return reply.status(400).send({ error: "missing_tenant_id" });
    }

    const { status, data } = await handleAdminInvoke(
      tenantId,
      adminPath,
      (request.body ?? {}) as Record<string, unknown>
    );
    return reply.status(status).send(data);
  }
);

app.post<{ Params: { "*": string }; Body: Record<string, unknown> }>(
  "/widget/*",
  async (request, reply) => {
    const widgetPath = "/" + request.params["*"];
    const tenantId = request.headers["x-tenant-id"] as string | undefined;

    if (!tenantId) {
      return reply.status(400).send({ error: "missing_tenant_id" });
    }

    const { status, data } = await handleWidgetInvoke(
      tenantId,
      widgetPath,
      (request.body ?? {}) as Record<string, unknown>
    );
    return reply.status(status).send(data);
  }
);

app.post<{ Body: HarnessInvokeRequest }>("/invoke", async (request, reply) => {
  const body = request.body;

  if (!body || typeof body !== "object") {
    return reply.status(400).send({ error: "missing body" });
  }

  logger.info(
    { executionLogId: body.executionLogId, topic: body.topic },
    "invoke started"
  );

  const result = await handleWebhookInvoke(body);

  logger.info(
    { executionLogId: body.executionLogId, status: result.status, durationMs: result.durationMs },
    "invoke completed"
  );

  // Always return 200 — harness-level errors are encoded in the response body.
  // Non-200 is reserved for infrastructure failures (harness itself crashed).
  return reply.status(200).send(result);
});

// Validate the handler module loads successfully at startup before accepting traffic
try {
  loadModule();
  logger.info("Handler module loaded successfully");
} catch (err) {
  logger.error({ err }, "Failed to load handler module — exiting");
  process.exit(1);
}

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    logger.error({ err }, "Server failed to start");
    process.exit(1);
  }
  logger.info({ port: PORT }, "Harness server listening");
});

// Graceful shutdown
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
