import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import { webhookRoutes } from "./routes/webhook.js";
import { healthRoutes } from "./routes/health.js";
import { rawBodyPlugin } from "./plugins/raw-body.js";
import { metricsPlugin } from "./plugins/metrics.js";
import { logger } from "@platform-back/logger";
import { closeQueue } from "./queue/webhook-queue.js";

const redisClient = new Redis({
  host: process.env["REDIS_HOST"] ?? "localhost",
  port: parseInt(process.env["REDIS_PORT"] ?? "6379", 10),
  password: process.env["REDIS_PASSWORD"],
  tls: process.env["REDIS_TLS"] === "true" ? {} : undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

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
  await app.register(metricsPlugin);

  // Redis-backed rate limiting — distributed across instances.
  // 200 req/min per IP protects against webhook floods without blocking
  // legitimate bursts from Shopify's delivery infrastructure.
  await app.register(rateLimit, {
    max: 200,
    timeWindow: 60_000,
    redis: redisClient,
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: () => ({ error: "rate_limit_exceeded" }),
  });

  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      logger.error({ err, url: req.url, method: req.method }, "Unhandled error");
    } else {
      logger.warn({ err, url: req.url, method: req.method }, "Request error");
    }
    void reply
      .code(status)
      .send(status >= 500 ? { error: "internal_error" } : { error: err.message });
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
    await redisClient.quit();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
