// ─── Rate Limiting ─────────────────────────────────────────────────────────────
// Per-tenant rate limiting via Redis to prevent abuse on the webhook endpoint.
// Shopify sends at most ~100 webhooks/min per shop; we allow 200 for safety.

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import { logger } from "@new-one-two/logger";
import type { WebhookRouteParams } from "@new-one-two/types";

const redis = new Redis({
  host: process.env["REDIS_HOST"] ?? "localhost",
  port: parseInt(process.env["REDIS_PORT"] ?? "6379", 10),
  password: process.env["REDIS_PASSWORD"],
  tls: process.env["REDIS_TLS"] === "true" ? {} : undefined,
  enableReadyCheck: false,
  maxRetriesPerRequest: 3,
});

// Prefix on the public webhook route (see server.ts `/webhook` prefix +
// webhookRoutes's `/:tenantSlug/:appSlug`). Keyed rate-limiting is expected
// on any request under this prefix; if the keyGenerator ever falls back to
// request.ip for such a request, the slug params went missing — log loud
// enough that a regression surfaces in operator dashboards instead of
// silently sharing one bucket across all tenants.
const WEBHOOK_ROUTE_PREFIX = "/webhook/";

export const rateLimitPlugin = fp(async (app: FastifyInstance) => {
  await app.register(rateLimit, {
    redis,
    max: 200,
    timeWindow: "1 minute",
    // Key by tenantSlug + appSlug so each app gets its own bucket. The
    // webhook route is registered as `/webhook/:tenantSlug/:appSlug` — an
    // earlier version of this function read tenantId/appId (names that never
    // existed on the route), so every request silently fell back to the
    // shared request.ip bucket and one noisy shop could rate-limit every
    // tenant.
    //
    // Params are now typed via WebhookRouteParams from @new-one-two/types so
    // a future rename of the route params produces a compile-time signal
    // here; the runtime warning below backstops the type check for any
    // other route that lands under /webhook/ without the expected shape.
    keyGenerator: (request) => {
      const params = (request.params ?? {}) as Partial<WebhookRouteParams>;
      const { tenantSlug, appSlug } = params;
      if (tenantSlug && appSlug) {
        return `rl:${tenantSlug}:${appSlug}`;
      }
      if (request.url.startsWith(WEBHOOK_ROUTE_PREFIX)) {
        logger.warn(
          { url: request.url, ip: request.ip, method: request.method },
          "Rate-limit falling back to request.ip on a webhook route — " +
            "tenantSlug/appSlug params missing. Did the route declaration rename them?"
        );
      }
      return request.ip;
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

