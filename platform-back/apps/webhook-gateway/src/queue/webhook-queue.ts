import { Queue, QueueEvents } from "bullmq";
import type { WebhookJobPayload } from "@platform-back/types";
import { logger } from "@platform-back/logger";

const redisConnection = {
  host: process.env["REDIS_HOST"] ?? "localhost",
  port: parseInt(process.env["REDIS_PORT"] ?? "6379", 10),
  password: process.env["REDIS_PASSWORD"],
  tls: process.env["REDIS_TLS"] === "true" ? {} : undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

export const WEBHOOK_QUEUE_NAME = "webhook-executions";

export const webhookQueue = new Queue<WebhookJobPayload>(WEBHOOK_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 7 * 86_400 },
  },
});

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

export async function enqueueWebhook(payload: WebhookJobPayload): Promise<{ id: string }> {
  const job = await webhookQueue.add(payload.topic, payload, {
    jobId: payload.executionLogId,
    priority: 1,
  });
  return { id: job.id! };
}

export async function closeQueue(): Promise<void> {
  await webhookQueue.close();
  await queueEvents.close();
}
