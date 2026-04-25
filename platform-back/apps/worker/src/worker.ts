import { Worker, type Job } from "bullmq";
import { GoogleAuth } from "google-auth-library";
import { updateWebhookInvocationLog } from "@platform-back/db";
import { createRequestLogger } from "@platform-back/logger";
import type { WebhookJobPayload } from "@platform-back/types";

const WEBHOOK_QUEUE_NAME = "webhook-executions";
const SKIP_AUTH = process.env["NODE_ENV"] === "development";
const auth = SKIP_AUTH ? null : new GoogleAuth();

const redisConnection = {
  host: process.env["REDIS_HOST"] ?? "localhost",
  port: parseInt(process.env["REDIS_PORT"] ?? "6379", 10),
  password: process.env["REDIS_PASSWORD"],
  tls: process.env["REDIS_TLS"] === "true" ? {} : undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

// ─── Handler invocation ────────────────────────────────────────────────────────
//
// New call shape (Phase 2+): handlers expose /webhook/:topic with an envelope
//   { webhook_id, topic, payload }
// The handler template's src/routes/webhook.ts:
//   1. Verifies the platform OIDC ID token (verifyPlatform middleware).
//   2. Runs the idempotency gate (INSERT INTO processed_webhooks ON CONFLICT).
//   3. Dispatches to the topic switch.
//
// Worker sends:
//   POST {functionUrl}/webhook/{topic}
//   Body: { webhook_id, topic, payload: <decoded raw body> }
//   Headers: Google ID token (OIDC) for Cloud Run auth
//            x-tenant-id / x-app-id / x-shop-domain / x-request-id (platform headers)

class HandlerError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly body: string,
  ) {
    super(`Handler returned HTTP ${httpStatus}: ${body}`);
    this.name = "HandlerError";
  }
}

async function invokeHandler(
  functionUrl: string,
  payload: WebhookJobPayload,
): Promise<{ statusCode: number }> {
  const url = `${functionUrl}/webhook/${encodeURIComponent(payload.topic)}`;
  const body = JSON.stringify({
    webhook_id: payload.shopifyWebhookId,
    topic: payload.topic,
    payload: JSON.parse(Buffer.from(payload.rawBodyBase64, "base64").toString("utf-8")),
  });

  const extraHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-tenant-id": payload.tenantId,
    "x-app-id": payload.appId,
    "x-shop-domain": payload.headers["x-shopify-shop-domain"] ?? "",
    "x-request-id": payload.executionLogId,
  };

  let res: Response;
  if (SKIP_AUTH || !auth) {
    res = await fetch(url, { method: "POST", headers: extraHeaders, body });
  } else {
    const client = await auth.getIdTokenClient(functionUrl);
    const authHeaders = await client.getRequestHeaders(functionUrl);
    const headers = { ...authHeaders, ...extraHeaders };
    res = await fetch(url, { method: "POST", headers, body });
  }

  const responseText = await res.text();
  if (res.status >= 400) throw new HandlerError(res.status, responseText);
  return { statusCode: res.status };
}

// ─── Job processor ─────────────────────────────────────────────────────────────

async function processWebhookJob(job: Job<WebhookJobPayload>): Promise<void> {
  const payload = job.data;
  const log = createRequestLogger({ requestId: payload.executionLogId });

  log.info({ jobId: job.id, functionUrl: payload.functionUrl }, "Processing webhook job");
  const startedAt = new Date();

  await updateWebhookInvocationLog(payload.executionLogId, {
    status: "running",
    startedAt,
  });

  const t0 = performance.now();
  try {
    const { statusCode } = await invokeHandler(payload.functionUrl, payload);
    const durationMs = Math.round(performance.now() - t0);
    log.info({ jobId: job.id, durationMs, statusCode }, "Webhook job executed");

    await updateWebhookInvocationLog(payload.executionLogId, {
      status: "success",
      durationMs,
      responseStatusCode: statusCode,
      shopifyApiCalls: 0,
      completedAt: new Date(),
    });
  } catch (err: unknown) {
    const completedAt = new Date();
    const durationMs = Math.round(completedAt.getTime() - startedAt.getTime());

    if (err instanceof HandlerError) {
      log.error(
        { jobId: job.id, httpStatus: err.httpStatus, body: err.body },
        "Handler returned error",
      );
      await updateWebhookInvocationLog(payload.executionLogId, {
        status: "failed",
        durationMs,
        responseStatusCode: err.httpStatus,
        shopifyApiCalls: 0,
        errorMessage: err.body.slice(0, 500),
        completedAt,
      });
    } else {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error({ jobId: job.id, errorMessage, durationMs }, "Unexpected error invoking handler");
      await updateWebhookInvocationLog(payload.executionLogId, {
        status: "failed",
        durationMs,
        errorMessage,
        completedAt,
      });
    }
    throw err;
  }
}

// ─── Worker boot ────────────────────────────────────────────────────────────────

const CONCURRENCY = parseInt(process.env["WORKER_CONCURRENCY"] ?? "10", 10);

export const worker = new Worker<WebhookJobPayload>(WEBHOOK_QUEUE_NAME, processWebhookJob, {
  connection: redisConnection,
  concurrency: CONCURRENCY,
  lockDuration: 60_000,
  lockRenewTime: 15_000,
});

worker.on("error", (err: Error) => {
  console.error("Worker error:", err);
});

export async function closeWorker(): Promise<void> {
  await worker.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.info(`Worker started — concurrency=${CONCURRENCY}`);

  const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  server.listen(PORT, () => console.info(`Health check server on ${PORT}`));

  const shutdown = async () => {
    server.close();
    await closeWorker();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
