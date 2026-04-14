// ─── Rate Limiting ─────────────────────────────────────────────────────────────
// Per-tenant rate limiting via Redis to prevent abuse on the webhook endpoint.
// Shopify sends at most ~100 webhooks/min per shop; we allow 200 for safety.

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
const redis = new Redis({
  host: process.env["REDIS_HOST"] ?? "localhost",
  port: parseInt(process.env["REDIS_PORT"] ?? "6379", 10),
  password: process.env["REDIS_PASSWORD"],
  tls: process.env["REDIS_TLS"] === "true" ? {} : undefined,
  enableReadyCheck: false,
  maxRetriesPerRequest: 3,
});

export const rateLimitPlugin = fp(async (app: FastifyInstance) => {
  await app.register(rateLimit, {
    redis,
    max: 200,
    timeWindow: "1 minute",
    // Key by tenantSlug + appSlug so each app gets its own bucket.
    // The webhook route is registered as /:tenantSlug/:appSlug — earlier
    // versions read tenantId/appId which never existed, causing every
    // request to silently fall back to the shared request.ip bucket.
    keyGenerator: (request) => {
      const { tenantSlug, appSlug } = (request.params as Record<string, string | undefined>) ?? {};
      return tenantSlug && appSlug
        ? `rl:${tenantSlug}:${appSlug}`
        : request.ip;
    },
    errorResponseBuilder: () => ({
      error: "Too Many Requests",
      message: "Webhook rate limit exceeded. Shopify will retry.",
    }),
    // Return 429; Shopify treats this as a transient error and retries
    addHeadersOnExceeding: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
    },
  });
});

