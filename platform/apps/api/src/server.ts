import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import { logger } from "@new-one-two/logger";
import {
  startSubscriptions,
  stopSubscriptions,
} from "@new-one-two/pubsub-client";
import { generationRoute } from "./routes/generation.js";
import { healthRoute } from "./routes/health.js";
import { tenantsRoute } from "./routes/tenants.js";
import { widgetJsRoutes } from "./routes/widget-js.js";
import { adminUiRoutes } from "./routes/admin-ui.js";
import { oauthRoute } from "./routes/oauth.js";
import { billingRoute } from "./routes/billing.js";
import { authHook } from "./plugins/auth.js";

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

  // CORS: in production, restrict to ALLOWED_ORIGINS; in dev, allow all origins
  // so ngrok, localhost, and Shopify test stores keep working.
  const allowedOrigins = process.env["ALLOWED_ORIGINS"]
    ? process.env["ALLOWED_ORIGINS"].split(",").map((o) => o.trim())
    : undefined;

  await app.register(cors, {
    origin: process.env["NODE_ENV"] === "production" && allowedOrigins
      ? allowedOrigins
      : true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
  });

  // Rate limiting: 100 req/min per tenant (authenticated) or per IP (anonymous).
  // Uses Redis for distributed counting across Cloud Run instances.
  const redisHost = process.env["REDIS_HOST"];
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    ...(redisHost && {
      redis: new Redis({
        host: redisHost,
        port: parseInt(process.env["REDIS_PORT"] ?? "6379", 10),
        password: process.env["REDIS_PASSWORD"],
        tls: process.env["REDIS_TLS"] === "true" ? {} : undefined,
        enableReadyCheck: false,
        maxRetriesPerRequest: 3,
      }),
    }),
    keyGenerator: (request) => {
      return request.tenantAuth?.tenantId ?? request.ip;
    },
    allowList: (request) => {
      // Don't rate-limit health checks or widget serving
      const path = request.url.split("?")[0]!;
      return path.startsWith("/health") || path.startsWith("/widgets") || path.startsWith("/admin-ui");
    },
  });

  // Auth hook: validates Bearer tokens (or ?token= query param for SSE) on
  // protected routes. Added directly via addHook to avoid Fastify encapsulation —
  // ensures the hook applies to ALL routes, not just those inside a sub-plugin.
  // Exempt: /health, /oauth, /widgets, /admin-ui, billing callback/webhook
  app.addHook("onRequest", authHook);

  await app.register(healthRoute, { prefix: "/health" });
  await app.register(generationRoute, { prefix: "/generation" });
  await app.register(tenantsRoute, { prefix: "/tenants" });
  await app.register(widgetJsRoutes, { prefix: "/widgets" });
  await app.register(adminUiRoutes, { prefix: "/admin-ui" });
  await app.register(oauthRoute, { prefix: "/oauth" });
  await app.register(billingRoute, { prefix: "/billing" });

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
