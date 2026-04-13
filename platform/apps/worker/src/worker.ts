import { Worker, type Job } from "bullmq";
import { GoogleAuth } from "google-auth-library";
import { updateWebhookInvocationLog } from "@new-one-two/db";
import { createRequestLogger } from "@new-one-two/logger";
import type { WebhookJobPayload, HarnessInvokeResponse } from "@new-one-two/types";

const WEBHOOK_QUEUE_NAME = "webhook-executions";

// ─── Cloud Run Auth ────────────────────────────────────────────────────────────
// In production: uses Application Default Credentials (workload identity / SA key).
// In local dev:  set CLOUD_RUN_SKIP_AUTH=true to call Cloud Run functions without
//                an OIDC token (works when functions run locally without auth).

const auth = new GoogleAuth();
const SKIP_AUTH = process.env["CLOUD_RUN_SKIP_AUTH"] === "true";

interface CloudRunResponse {
  statusCode: number;
  body?: string;
}

function parseHarnessResponse(body: string): HarnessInvokeResponse | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (
      typeof parsed["status"] === "string" &&
      typeof parsed["durationMs"] === "number" &&
      typeof parsed["shopifyApiCalls"] === "number"
    ) {
      return parsed as unknown as HarnessInvokeResponse;
    }
  } catch {
    // not JSON or wrong shape
  }
  return null;
}

async function invokeCloudRunFunction(
  functionUrl: string,
  payload: unknown
): Promise<{
  statusCode: number;
  invocationId: string | undefined;
  harnessResponse: HarnessInvokeResponse | null;
}> {
  const body = JSON.stringify(payload);

  let responseHeaders: Headers;
  let responseStatus: number;
  let responseBody: string;

  if (SKIP_AUTH) {
    const res = await fetch(functionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    responseStatus = res.status;
    responseHeaders = res.headers;
    responseBody = await res.text();
  } else {
    // Fetch OIDC token scoped to the target Cloud Run service
    const client = await auth.getIdTokenClient(functionUrl);
    const res = await client.request<CloudRunResponse>({
      url: functionUrl,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      responseType: "text",
    });
    responseStatus = res.status;
    // google-auth-library wraps headers — normalise to standard Headers
    responseHeaders = new Headers(res.headers as Record<string, string>);
    responseBody = res.data as unknown as string;
  }

  // Cloud Run sets X-Cloud-Trace-Context on every response
  const invocationId =
    responseHeaders.get("x-cloud-trace-context")?.split("/")[0] ?? undefined;

  if (responseStatus >= 400) {
    throw new CloudRunFunctionError(responseStatus, responseBody, invocationId);
  }

  const harnessResponse = parseHarnessResponse(responseBody);

  let statusCode = responseStatus;
  try {
    const parsed = JSON.parse(responseBody) as CloudRunResponse;
    statusCode = parsed.statusCode ?? responseStatus;
  } catch {
    // Response isn't JSON — treat HTTP status as the status code
  }

  return { statusCode, invocationId, harnessResponse };
}

class CloudRunFunctionError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly body: string,
    public readonly invocationId: string | undefined
  ) {
    super(`Cloud Run function returned HTTP ${httpStatus}: ${body}`);
    this.name = "CloudRunFunctionError";
  }
}

// ─── Redis Connection ─────────────────────────────────────────────────────────

const redisConnection = {
  host: process.env["REDIS_HOST"] ?? "localhost",
  port: parseInt(process.env["REDIS_PORT"] ?? "6379", 10),
  password: process.env["REDIS_PASSWORD"],
  tls: process.env["REDIS_TLS"] === "true" ? {} : undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

// ─── Worker ───────────────────────────────────────────────────────────────────

const CONCURRENCY = parseInt(process.env["WORKER_CONCURRENCY"] ?? "10", 10);

export const worker = new Worker<WebhookJobPayload>(
  WEBHOOK_QUEUE_NAME,
  processWebhookJob,
  {
    connection: redisConnection,
    concurrency: CONCURRENCY,
    // Lock timeout must be longer than max Cloud Run timeout (3600s) + buffer
    lockDuration: 60_000,
    lockRenewTime: 15_000,
  }
);

// ─── Job Processor ────────────────────────────────────────────────────────────

async function processWebhookJob(job: Job<WebhookJobPayload>): Promise<void> {
  const payload = job.data;
  const log = createRequestLogger({
    tenantId: payload.tenantId,
    appId: payload.appId,
    requestId: payload.executionLogId,
    topic: payload.topic,
  });

  log.info({ jobId: job.id, functionUrl: payload.functionUrl }, "Processing webhook job");

  const startedAt = new Date();

  await updateWebhookInvocationLog(payload.executionLogId, {
    status: "running",
    startedAt,
  });

  let durationMs = 0;

  try {
    const functionPayload = {
      executionLogId: payload.executionLogId,
      tenantId: payload.tenantId,
      appId: payload.appId,
      topic: payload.topic,
      shopifyWebhookId: payload.shopifyWebhookId,
      rawBodyBase64: payload.rawBodyBase64,
      headers: payload.headers,
      receivedAt: payload.receivedAt,
    };

    const t0 = performance.now();
    const { statusCode, invocationId, harnessResponse } = await invokeCloudRunFunction(
      `${payload.functionUrl}/invoke`,
      functionPayload
    );
    durationMs = Math.round(performance.now() - t0);

    log.info({ jobId: job.id, durationMs, statusCode }, "Webhook job executed successfully");

    await updateWebhookInvocationLog(payload.executionLogId, {
      status: "success",
      durationMs,
      responseStatusCode: statusCode,
      shopifyApiCalls: harnessResponse?.shopifyApiCalls ?? 0,
      ...(invocationId !== undefined && { invocationId }),
      completedAt: new Date(),
    });
  } catch (err: unknown) {
    const completedAt = new Date();
    durationMs = Math.round(completedAt.getTime() - startedAt.getTime());

    if (err instanceof CloudRunFunctionError) {
      log.error(
        { jobId: job.id, httpStatus: err.httpStatus, body: err.body },
        "Cloud Run function returned error status"
      );

      const errHarnessResponse = parseHarnessResponse(err.body);
      await updateWebhookInvocationLog(payload.executionLogId, {
        status: "failed",
        durationMs,
        responseStatusCode: err.httpStatus,
        shopifyApiCalls: errHarnessResponse?.shopifyApiCalls ?? 0,
        ...(err.invocationId !== undefined && { invocationId: err.invocationId }),
        errorMessage: errHarnessResponse?.error ?? err.body,
        completedAt,
      });
    } else {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error({ jobId: job.id, errorMessage, durationMs }, "Unexpected error invoking Cloud Run function");

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

// ─── Worker Events ─────────────────────────────────────────────────────────────

worker.on("error", (err: Error) => {
  console.error("Worker error:", err);
});

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────

export async function closeWorker(): Promise<void> {
  await worker.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.info(`Worker started — concurrency=${CONCURRENCY}`);

  // Cloud Run requires a service to listen on a port. Start a minimal HTTP
  // server that returns 200 for health checks while the worker runs.
  const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  server.listen(PORT, () => {
    console.info(`Health check server listening on port ${PORT}`);
  });

  const shutdown = async () => {
    server.close();
    await closeWorker();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
