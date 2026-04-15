import Fastify from "fastify";
import { z } from "zod";
import { logger } from "@new-one-two/logger";
import { loadModule } from "@new-one-two/harness";
import { handleWebhookInvoke } from "./webhook-handler.js";
import { handleWidgetInvoke } from "./widget-handler.js";
import { handleAdminInvoke } from "./admin-handler.js";
import { ErrorCode, errorResponse, formatZodIssues } from "./error-response.js";

const PORT = parseInt(process.env["PORT"] ?? "8080", 10);

// ─── Request schemas ──────────────────────────────────────────────────────────
//
// The harness is reachable by other services inside the VPC (worker, API
// proxies). Validating inbound shape at this boundary prevents a malformed
// caller from reaching the LLM-generated handler code with arbitrary junk,
// and gives the caller a deterministic 400 instead of a stray exception.
//
// InvokeRequest mirrors HarnessInvokeRequest from @new-one-two/types; the
// interface there remains the wire contract owner for callers — this Zod
// schema is the validator for this specific endpoint.

const InvokeRequestSchema = z.object({
  executionLogId: z.string().uuid(),
  tenantId: z.string().uuid(),
  appId: z.string().uuid(),
  topic: z.string().min(1),
  shopifyWebhookId: z.string().min(1),
  rawBodyBase64: z.string(),
  headers: z.record(z.string()),
  receivedAt: z.string(),
});

// Admin + widget proxies forward whatever JSON object the upstream proxy
// sent. We gate on "is a JSON object" at the boundary; the merchant-written
// handler owns deeper shape validation against its own contract.
const ProxyBodySchema = z.record(z.unknown()).default({});

const app = Fastify({
  logger: false, // use our own pino instance
  trustProxy: true,
});

app.get("/health", async () => ({ status: "ok" }));

app.post<{ Params: { "*": string } }>(
  "/admin/*",
  async (request, reply) => {
    const adminPath = "/" + request.params["*"];
    const tenantId = request.headers["x-tenant-id"] as string | undefined;

    if (!tenantId) {
      return reply
        .status(400)
        .send(
          errorResponse(ErrorCode.InvalidRequest, "Missing x-tenant-id header")
        );
    }

    const parsed = ProxyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(
          errorResponse(
            ErrorCode.InvalidRequest,
            "Request body failed validation",
            { issues: formatZodIssues(parsed.error) }
          )
        );
    }

    const { status, data } = await handleAdminInvoke(
      tenantId,
      adminPath,
      parsed.data
    );
    return reply.status(status).send(data);
  }
);

app.post<{ Params: { "*": string } }>(
  "/widget/*",
  async (request, reply) => {
    const widgetPath = "/" + request.params["*"];
    const tenantId = request.headers["x-tenant-id"] as string | undefined;

    if (!tenantId) {
      return reply
        .status(400)
        .send(
          errorResponse(ErrorCode.InvalidRequest, "Missing x-tenant-id header")
        );
    }

    const parsed = ProxyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(
          errorResponse(
            ErrorCode.InvalidRequest,
            "Request body failed validation",
            { issues: formatZodIssues(parsed.error) }
          )
        );
    }

    const { status, data } = await handleWidgetInvoke(
      tenantId,
      widgetPath,
      parsed.data
    );
    return reply.status(status).send(data);
  }
);

app.post("/invoke", async (request, reply) => {
  const parsed = InvokeRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply
      .status(400)
      .send(
        errorResponse(
          ErrorCode.InvalidRequest,
          "Request body failed validation",
          { issues: formatZodIssues(parsed.error) }
        )
      );
  }
  const body = parsed.data;

  logger.info(
    { executionLogId: body.executionLogId, topic: body.topic },
    "invoke started"
  );

  const result = await handleWebhookInvoke(body);

  logger.info(
    { executionLogId: body.executionLogId, status: result.status, durationMs: result.durationMs },
    "invoke completed"
  );

  // Always return 200 — harness-level errors are encoded in the response body.
  // Non-200 is reserved for infrastructure failures (harness itself crashed).
  return reply.status(200).send(result);
});

// Validate the handler module loads successfully at startup before accepting traffic
try {
  loadModule();
  logger.info("Handler module loaded successfully");
} catch (err) {
  logger.error({ err }, "Failed to load handler module — exiting");
  process.exit(1);
}

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    logger.error({ err }, "Server failed to start");
    process.exit(1);
  }
  logger.info({ port: PORT }, "Harness server listening");
});

// Graceful shutdown
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
