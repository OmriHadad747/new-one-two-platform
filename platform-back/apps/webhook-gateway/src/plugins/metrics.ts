import type { FastifyInstance } from "fastify";
import { logger } from "@platform-back/logger";

/**
 * Per-request structured log used for Cloud Logging → log-based metric
 * aggregation. Emits one line per response with method, route pattern
 * (not the URL — keeps cardinality low), status class, and duration.
 */
export async function metricsPlugin(app: FastifyInstance): Promise<void> {
  app.addHook("onResponse", (req, reply, done) => {
    const statusCode = reply.statusCode;
    logger.info({
      type: "http_request",
      method: req.method,
      route: req.routeOptions?.url ?? req.url,
      statusCode,
      statusClass: `${Math.floor(statusCode / 100)}xx`,
      durationMs: Math.round(reply.elapsedTime),
    });
    done();
  });
}
