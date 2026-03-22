// ─── Error Handler Plugin ─────────────────────────────────────────────────────

import type { FastifyInstance, FastifyError } from "fastify";
import fp from "fastify-plugin";
import { logger } from "@new-one-two/logger";

export const errorHandler = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Validation errors from schema
    if (error.validation) {
      return reply.code(400).send({
        error: "Bad Request",
        message: error.message,
        validation: error.validation,
      });
    }

    // Don't leak internal errors to clients
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      logger.error(
        { err: error, requestId: request.id, path: request.url },
        "Internal server error"
      );
      return reply.code(500).send({ error: "Internal Server Error" });
    }

    return reply.code(statusCode).send({ error: error.message });
  });

  // Catch-all for unhandled rejections in route handlers
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: "Not Found" });
  });
});
