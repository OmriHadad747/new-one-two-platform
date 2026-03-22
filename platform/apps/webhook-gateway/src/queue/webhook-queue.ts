import { Queue, QueueEvents } from "bullmq";
import type { WebhookJobPayload } from "@new-one-two/types";
import { logger } from "@new-one-two/logger";

// ─── Redis Connection ─────────────────────────────────────────────────────────

const redisConnection = {
  host: process.env["REDIS_HOST"] ?? "localhost",
  port: parseInt(process.env["REDIS_PORT"] ?? "6379", 10),
  password: process.env["REDIS_PASSWORD"],
  tls: process.env["REDIS_TLS"] === "true" ? {} : undefined,
  // ioredis options
  maxRetriesPerRequest: null, // required by BullMQ
  enableReadyCheck: false,
};

// ─── Queue Definition ─────────────────────────────────────────────────────────

export const WEBHOOK_QUEUE_NAME = "webhook-executions";

export const webhookQueue = new Queue<WebhookJobPayload>(WEBHOOK_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    // Shopify retries webhooks for 48h; we retry aggressively in the first 5min
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 2_000, // 2s → 4s → 8s → 16s → 32s
    },
    removeOnComplete: {
      age: 86_400,    // keep 24h of completed jobs for debugging
      count: 10_000,
    },
    removeOnFail: {
      age: 7 * 86_400, // keep failed jobs for 7 days
    },
  },
});

// ─── Queue Events (for logging) ────────────────────────────────────────────────

const queueEvents = new QueueEvents(WEBHOOK_QUEUE_NAME, {
  connection: redisConnection,
});

queueEvents.on("completed", ({ jobId }) => {
  logger.debug({ jobId }, "Webhook job completed");
});

queueEvents.on("failed", ({ jobId, failedReason }) => {
  logger.error({ jobId, failedReason }, "Webhook job failed");
});

queueEvents.on("stalled", ({ jobId }) => {
  logger.warn({ jobId }, "Webhook job stalled — will be retried");
});

// ─── Enqueue Helper ───────────────────────────────────────────────────────────

export async function enqueueWebhook(
  payload: WebhookJobPayload
): Promise<{ id: string }> {
  // Use executionLogId as the job ID for dedup and tracing
  const job = await webhookQueue.add(payload.topic, payload, {
    jobId: payload.executionLogId,
    // Priority: can be extended to differentiate paid plans
    priority: 1,
  });

  return { id: job.id! };
}

// ─── Graceful Close ───────────────────────────────────────────────────────────

export async function closeQueue(): Promise<void> {
  await webhookQueue.close();
  await queueEvents.close();
}
