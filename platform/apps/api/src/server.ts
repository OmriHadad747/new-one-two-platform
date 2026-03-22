import Fastify from "fastify";
import { logger } from "@new-one-two/logger";
import {
  startSubscriptions,
  stopSubscriptions,
} from "@new-one-two/pubsub-client";
import { generationRoute } from "./routes/generation.js";
import { healthRoute } from "./routes/health.js";
import { tenantsRoute } from "./routes/tenants.js";

const PORT = parseInt(process.env["PORT"] ?? "3002", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";

export async function buildServer() {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  // Open Pub/Sub subscriptions before accepting HTTP requests.
  // The SSE fan-out and bundle persistence both depend on these being active.
  await startSubscriptions();

  await app.register(healthRoute, { prefix: "/health" });
  await app.register(generationRoute, { prefix: "/generation" });
  await app.register(tenantsRoute, { prefix: "/tenants" });

  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, "Unhandled error");
    void reply.status(500).send({ error: "Internal server error" });
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "API service shutting down");
    await stopSubscriptions();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  await app.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT, host: HOST }, "API service listening");
}
