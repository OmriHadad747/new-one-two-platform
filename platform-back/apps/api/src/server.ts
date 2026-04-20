import Fastify from "fastify";
import rawBodyPlugin from "fastify-raw-body";
import { closeDb } from "@platform-back/db";
import { logger } from "@platform-back/logger";
import { ErrorCode, errorResponse } from "./lib/error-response.js";
import { installCors, parseAllowedOrigins } from "./plugins/cors.js";
import { registerAuthHook } from "./plugins/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { emailRoutes } from "./routes/email.js";
import { emailPublicRoutes } from "./routes/email-public.js";
import { emailServiceRoutes } from "./routes/services/email.js";
import { resendWebhookRoutes } from "./routes/webhook/resend.js";

const PORT = parseInt(process.env["PORT"] ?? "3010", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";
const NODE_ENV = process.env["NODE_ENV"] ?? "development";

// Cap inbound request bodies. Admin payloads are small JSON; an attacker
// hosing the edge with multi-megabyte bodies can starve event-loop time
// across all tenants on this Cloud Run instance.
const BODY_LIMIT_BYTES = 1 * 1024 * 1024; // 1 MiB

export async function buildServer() {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: BODY_LIMIT_BYTES,
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  // Raw body capture — needed by routes that proxy bytes verbatim
  // (admin edge → handler) and by routes that verify HMAC signatures
  // over the original payload (Resend webhook). `runFirst: true` ensures
  // the raw bytes are captured BEFORE Fastify's JSON parser turns them
  // into objects. Other routes still get normal `request.body` parsing.
  await app.register(rawBodyPlugin, {
    field: "rawBody",
    global: true,
    encoding: false, // keep as Buffer
    runFirst: true,
  });

  const allowedOrigins = parseAllowedOrigins(process.env["ALLOWED_ORIGINS"]);
  if (NODE_ENV === "production" && allowedOrigins.length === 0) {
    logger.warn(
      "ALLOWED_ORIGINS is empty in production — only built-in Shopify origins will be permitted",
    );
  }
  installCors(app, { extraAllowedOrigins: allowedOrigins });

  // Health check — Cloud Run probes this; keep it before any auth.
  app.get("/health", async () => ({ ok: true }));

  // Dashboard JWT auth hook (exempts /health, /admin, /services, /webhook,
  // /oauth, /email/u — those have their own per-trust-domain auth).
  registerAuthHook(app);

  await app.register(adminRoutes, { prefix: "/admin" });
  await app.register(emailServiceRoutes, { prefix: "/services/email" });
  await app.register(emailRoutes, { prefix: "/email" });
  await app.register(emailPublicRoutes, { prefix: "/email/u" });
  await app.register(resendWebhookRoutes, { prefix: "/webhook" });

  app.setNotFoundHandler((_req, reply) => {
    void reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "Route not found"));
  });

  app.setErrorHandler((err, req, reply) => {
    // Body-limit, content-type, and other Fastify validation errors arrive
    // here with a `statusCode` already set; pass it through verbatim so
    // misuse-of-API conditions don't get masked as 500s.
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      logger.error(
        { err, url: req.url, method: req.method },
        "Unhandled error",
      );
    } else {
      logger.warn(
        { err, url: req.url, method: req.method },
        "Request error",
      );
    }
    void reply
      .code(status)
      .send(
        errorResponse(
          status >= 500 ? ErrorCode.Internal : ErrorCode.InvalidRequest,
          err.message || "Request failed",
        ),
      );
  });

  return app;
}

async function shutdown(
  signal: string,
  app: Awaited<ReturnType<typeof buildServer>>,
): Promise<void> {
  logger.info({ signal }, "platform-back/api shutting down");
  try {
    await app.close();
  } catch (err) {
    logger.error({ err }, "Fastify close error");
  }
  await closeDb();
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  process.on("SIGTERM", () => void shutdown("SIGTERM", app));
  process.on("SIGINT", () => void shutdown("SIGINT", app));

  await app.listen({ port: PORT, host: HOST });
  logger.info(
    { port: PORT, host: HOST, env: NODE_ENV },
    "platform-back/api listening",
  );
}
