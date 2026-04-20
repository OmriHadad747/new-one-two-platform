import type { Message, Subscription } from "@google-cloud/pubsub";
import { z } from "zod";
import { logger as baseLogger } from "@platform-back/logger";
import { getPubSubClient, SUB_API_PROGRESS } from "./client.js";

const logger = baseLogger.child({ service: "progress-subscriber" });

// ─── Progress event schema ───────────────────────────────────────────────────

const ProgressEventSchema = z.object({
  jobId: z.string().uuid(),
  agent: z.string(),
  status: z.enum(["running", "completed", "failed", "retrying"]),
  message: z.string(),
  timestampMs: z.number().int(),
  attempt: z.number().int().optional(),
});

export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

// ─── In-process fan-out registry ────────────────────────────────────────────

type ProgressListener = (event: ProgressEvent) => void;
const progressListeners = new Map<string, Set<ProgressListener>>();

export function registerProgressListener(
  jobId: string,
  fn: ProgressListener,
): () => void {
  if (!progressListeners.has(jobId)) {
    progressListeners.set(jobId, new Set());
  }
  progressListeners.get(jobId)!.add(fn);
  return () => {
    const set = progressListeners.get(jobId);
    set?.delete(fn);
    if (set?.size === 0) progressListeners.delete(jobId);
  };
}

// ─── Subscription lifecycle ──────────────────────────────────────────────────

let progressSub: Subscription | null = null;

function attachProgressHandlers(sub: Subscription): void {
  sub.on("message", (msg: Message) => {
    try {
      const raw: unknown = JSON.parse(msg.data.toString("utf-8"));
      const event = ProgressEventSchema.parse(raw);
      msg.ack();
      const listeners = progressListeners.get(event.jobId);
      if (listeners) {
        for (const fn of listeners) fn(event);
      }
    } catch (err) {
      logger.warn({ err }, "Invalid progress message — nacking");
      msg.nack();
    }
  });

  sub.on("error", (err: Error & { code?: number }) => {
    logger.error({ err }, "Progress subscription error");
    if (err.code === 5) {
      setTimeout(() => {
        progressSub?.removeAllListeners();
        progressSub = getPubSubClient().subscription(SUB_API_PROGRESS);
        attachProgressHandlers(progressSub);
        logger.info("Re-attached progress subscription after NOT_FOUND");
      }, 3000);
    }
  });
}

export async function startProgressSubscription(): Promise<void> {
  progressSub = getPubSubClient().subscription(SUB_API_PROGRESS);
  attachProgressHandlers(progressSub);
  logger.info({ subscription: SUB_API_PROGRESS }, "generation.progress subscription active");
}

export async function stopProgressSubscription(): Promise<void> {
  if (!progressSub) return;
  try { await progressSub.close(); } catch {}
  progressSub = null;
  logger.info("generation.progress subscription closed");
}
