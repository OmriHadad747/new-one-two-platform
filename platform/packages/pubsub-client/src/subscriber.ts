/**
 * In-process fan-out subscriber for generation.progress and generation.completed.
 *
 * Architecture:
 *   One persistent Pub/Sub subscription per topic is opened at apps/api startup.
 *   SSE route handlers register listener callbacks keyed by jobId.
 *   When a Pub/Sub message arrives, it is dispatched to all matching listeners.
 *
 * Fan-out design:
 *   - Multiple browser tabs (SSE connections) for the same jobId each register
 *     independently and all receive the same events.
 *   - The completed listener set is automatically cleaned up after delivery —
 *     the job is done and no future messages will arrive for that jobId.
 *   - Progress listeners are cleaned up when the SSE client disconnects (the
 *     route handler calls the returned unsubscribe function on request close).
 */
import type { Message, Subscription } from "@google-cloud/pubsub";
import {
  getPubSubClient,
  SUB_API_PROGRESS,
  SUB_API_COMPLETED,
} from "./client.js";
import {
  ProgressEventSchema,
  FeatureBundleMessageSchema,
  type ProgressEvent,
  type FeatureBundleMessage,
} from "./schemas.js";
import { logger as baseLogger } from "@new-one-two/logger";

const logger = baseLogger.child({ service: "pubsub-client" });

// ─── Listener registries ──────────────────────────────────────────────────────

type ProgressListener = (event: ProgressEvent) => void;
type CompletedListener = (bundle: FeatureBundleMessage) => void;

const progressListeners = new Map<string, Set<ProgressListener>>();
const completedListeners = new Map<string, Set<CompletedListener>>();

// ─── Public registration API ──────────────────────────────────────────────────

/**
 * Register a callback for progress events for a specific job.
 * Returns an unsubscribe function — call it when the SSE client disconnects.
 */
export function registerProgressListener(
  jobId: string,
  fn: ProgressListener
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

/**
 * Register a callback for the completed bundle for a specific job.
 * The listener set is automatically cleaned up after delivery.
 * Returns an unsubscribe function for early cleanup (e.g. client disconnect
 * before the bundle arrives).
 */
export function registerCompletedListener(
  jobId: string,
  fn: CompletedListener
): () => void {
  if (!completedListeners.has(jobId)) {
    completedListeners.set(jobId, new Set());
  }
  completedListeners.get(jobId)!.add(fn);
  return () => {
    const set = completedListeners.get(jobId);
    set?.delete(fn);
    if (set?.size === 0) completedListeners.delete(jobId);
  };
}

// ─── Subscription lifecycle ───────────────────────────────────────────────────

let progressSub: Subscription | null = null;
let completedSub: Subscription | null = null;

/**
 * Open persistent Pub/Sub subscriptions. Call once at apps/api startup,
 * before the Fastify server starts accepting requests.
 *
 * The subscriptions (api-progress-sub, api-completed-sub) must already exist
 * in GCP or the emulator before this is called — pubsub-init creates them
 * in docker-compose.
 */
function attachProgressHandlers(sub: Subscription): void {
  sub.on("message", (msg: Message) => {
    try {
      const raw: unknown = JSON.parse(msg.data.toString());
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
    // code 5 = NOT_FOUND — pubsub-init race at startup. Retry after 3 s.
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

function attachCompletedHandlers(sub: Subscription): void {
  sub.on("message", (msg: Message) => {
    try {
      const raw: unknown = JSON.parse(msg.data.toString());
      const bundle = FeatureBundleMessageSchema.parse(raw);
      msg.ack();
      const listeners = completedListeners.get(bundle.jobId);
      if (listeners) {
        for (const fn of listeners) fn(bundle);
        completedListeners.delete(bundle.jobId);
      }
    } catch (err) {
      logger.warn({ err }, "Invalid completed message — nacking");
      msg.nack();
    }
  });

  sub.on("error", (err: Error & { code?: number }) => {
    logger.error({ err }, "Completed subscription error");
    if (err.code === 5) {
      setTimeout(() => {
        completedSub?.removeAllListeners();
        completedSub = getPubSubClient().subscription(SUB_API_COMPLETED);
        attachCompletedHandlers(completedSub);
        logger.info("Re-attached completed subscription after NOT_FOUND");
      }, 3000);
    }
  });
}

export async function startSubscriptions(): Promise<void> {
  progressSub = getPubSubClient().subscription(SUB_API_PROGRESS);
  completedSub = getPubSubClient().subscription(SUB_API_COMPLETED);

  attachProgressHandlers(progressSub);
  attachCompletedHandlers(completedSub);

  logger.info(
    { progressSub: SUB_API_PROGRESS, completedSub: SUB_API_COMPLETED },
    "Pub/Sub subscriptions active"
  );
}

/**
 * Gracefully close subscriptions. Call on SIGTERM/SIGINT before process exit.
 */
export async function stopSubscriptions(): Promise<void> {
  await progressSub?.close();
  await completedSub?.close();
  progressSub = null;
  completedSub = null;
  logger.info("Pub/Sub subscriptions closed");
}
