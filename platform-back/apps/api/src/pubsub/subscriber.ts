import type { Message, Subscription } from "@google-cloud/pubsub";
import { logger as baseLogger } from "@platform-back/logger";
import { upsertGeneration } from "@platform-back/db";
import { saveBundles } from "../lib/bundle-storage.js";
import { getPubSubClient, SUB_PLATFORM_BACK_COMPLETED } from "./client.js";
import { FeatureBundleMessageSchema } from "./schemas.js";

// Pub/Sub subscriber for generation.completed.
//
// Persists every successful or failed completion into the `generations`
// table. The dashboard deploy button reads back by jobId (Step 13); the
// deployer stitches handlerModule.files + dbMigration into a POST
// /apps/:appId/deploy payload at click time.
//
// Ack policy
//   - Schema validates OK  + DB write succeeds → ack.
//   - Schema fails          → log + nack. Message returns to queue;
//                             repeated schema failures drain to the DLQ
//                             (configure DLQ in terraform when the
//                             prod pubsub stack lands).
//   - DB write fails        → log + nack. Subscriber re-delivers after
//                             backoff; upsertGeneration is idempotent on
//                             job_id so re-delivery is safe.
//
// Replay semantics
//   Pub/Sub is at-least-once. upsertGeneration uses
//   ON CONFLICT (job_id) DO UPDATE — the first delivery writes the row,
//   subsequent deliveries refresh bundle/meta without resetting the
//   deploy-button state (deployed / deployed_at are NOT touched on
//   conflict).

const logger = baseLogger.child({ service: "pubsub-subscriber" });

let completedSub: Subscription | null = null;

async function handleMessage(msg: Message): Promise<void> {
  let parsed;
  try {
    const raw: unknown = JSON.parse(msg.data.toString("utf-8"));
    parsed = FeatureBundleMessageSchema.parse(raw);
  } catch (err) {
    logger.warn({ err }, "Invalid completed message — nacking");
    msg.nack();
    return;
  }

  try {
    await upsertGeneration({
      jobId: parsed.jobId,
      tenantId: parsed.tenantId,
      appId: parsed.appId,
      status: parsed.status,
      error: parsed.error ?? null,
      errorCode: parsed.errorCode ?? null,
      bundle: parsed.bundle ?? null,
      meta: parsed.meta ?? null,
    });

    const widgetJs = parsed.bundle?.widgetModule ?? null;
    const adminUiJs = parsed.bundle?.adminUiModule ?? null;
    if (widgetJs || adminUiJs) {
      await saveBundles(parsed.appId, { widgetJs, adminUiJs });
    }

    msg.ack();
    logger.info(
      { jobId: parsed.jobId, appId: parsed.appId, status: parsed.status },
      "generation.completed persisted",
    );
  } catch (err) {
    logger.error(
      { err, jobId: parsed.jobId, appId: parsed.appId },
      "Failed to persist generation.completed — nacking for retry",
    );
    msg.nack();
  }
}

function attachHandlers(sub: Subscription): void {
  sub.on("message", (msg: Message) => {
    void handleMessage(msg);
  });

  sub.on("error", (err: Error & { code?: number }) => {
    logger.error({ err }, "Completed subscription error");
    // code 5 = NOT_FOUND — races the docker-compose pubsub-init on
    // first boot. Re-attach after a short delay; the subscription is
    // created asynchronously by pubsub-init and reappears quickly.
    if (err.code === 5) {
      setTimeout(() => {
        completedSub?.removeAllListeners();
        completedSub = getPubSubClient().subscription(
          SUB_PLATFORM_BACK_COMPLETED,
        );
        attachHandlers(completedSub);
        logger.info("Re-attached completed subscription after NOT_FOUND");
      }, 3000);
    }
  });
}

export async function startCompletedSubscription(): Promise<void> {
  completedSub = getPubSubClient().subscription(SUB_PLATFORM_BACK_COMPLETED);
  attachHandlers(completedSub);
  logger.info(
    { subscription: SUB_PLATFORM_BACK_COMPLETED },
    "generation.completed subscription active",
  );
}

export async function stopCompletedSubscription(): Promise<void> {
  if (!completedSub) return;
  try {
    await completedSub.close();
  } catch (err) {
    logger.warn({ err }, "Error closing completed subscription");
  } finally {
    completedSub = null;
    logger.info("generation.completed subscription closed");
  }
}
