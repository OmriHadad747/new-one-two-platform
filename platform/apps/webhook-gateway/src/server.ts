import Fastify from "fastify";
import { webhookRoutes } from "./routes/webhook.js";
import { healthRoutes } from "./routes/health.js";
import { errorHandler } from "./plugins/error-handler.js";
import { rawBodyPlugin } from "./plugins/raw-body.js";
import { metricsPlugin } from "./plugins/metrics.js";
import { rateLimitPlugin } from "./plugins/rate-limit.js";
import { logger } from "@new-one-two/logger";
import { closeQueue } from "./queue/webhook-queue.js";

const PORT = parseInt(process.env["PORT"] ?? "3001", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";

export async function buildServer() {
  const app = Fastify({
    logger: false,          // we use our own pino logger
    trustProxy: true,       // behind ALB/CloudFront
    bodyLimit: 1_048_576,   // 1MB max body
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "requestId",
    genReqId: () => crypto.randomUUID(),
  });

  // ── Plugins ────────────────────────────────────────────────────────────────
  await app.register(rawBodyPlugin); // must be first — captures raw body before parsing
  await app.register(errorHandler);
  await app.register(metricsPlugin);
  await app.register(rateLimitPlugin);

  // ── Routes ─────────────────────────────────────────────────────────────────
  await app.register(healthRoutes, { prefix: "/health" });
  await app.register(webhookRoutes, { prefix: "/webhook" });

  // ── Graceful Shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down gracefully...");
    await app.close();
    await closeQueue();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return app;
}

// Start server unless imported as a module (for testing)
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  await app.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT, host: HOST }, "Webhook gateway listening");
}
