import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

export const metricsPlugin = fp(async (app: FastifyInstance) => {
  // Track request count and duration per route
  app.addHook("onResponse", (request, reply, done) => {
    const duration = reply.elapsedTime;
    const route = request.routeOptions?.url ?? request.url;
    const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;

    // Emit structured log — these are scraped by a log-based metrics aggregator
    // (e.g., Datadog log metrics or CloudWatch Embedded Metric Format)
    request.log.info({
      type: "http_request",
      method: request.method,
      route,
      statusCode: reply.statusCode,
      statusClass,
      durationMs: Math.round(duration),
    });

    done();
  });
});
