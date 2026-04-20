import Fastify from "fastify";
import { webhookRoutes } from "./routes/webhook.js";
import { healthRoutes } from "./routes/health.js";
import { rawBodyPlugin } from "./plugins/raw-body.js";
import { logger } from "@platform-back/logger";
import { closeQueue } from "./queue/webhook-queue.js";

const PORT = parseInt(process.env["PORT"] ?? "3001", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";

export async function buildServer() {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 1_048_576,
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(rawBodyPlugin);

  app.setErrorHandler((err, req, reply) => {
    logger.error({ err, url: req.url }, "Unhandled error");
    void reply.code(500).send({ error: "internal_error" });
  });

  await app.register(healthRoutes, { prefix: "/health" });
  await app.register(webhookRoutes, { prefix: "/webhook" });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  await app.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT, host: HOST }, "Webhook gateway listening");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await app.close();
    await closeQueue();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
