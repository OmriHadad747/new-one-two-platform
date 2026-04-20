import { PubSub } from "@google-cloud/pubsub";

// Singleton Pub/Sub client.
//
// Local dev: the SDK routes to the emulator automatically when
// PUBSUB_EMULATOR_HOST is set (the docker-compose pubsub-emulator
// service exports it into the apps/api container). Production: the
// SDK uses workload-identity credentials from the Cloud Run SA.
//
// Topic / subscription names live in docker-compose.yml's pubsub-init
// step for local dev, and are pre-created in GCP via terraform for
// prod. Don't hand-roll topic.publish() / subscription.create() calls —
// missing topics surface as NOT_FOUND errors that are easier to debug
// than "why is my message silently dropped".

let _client: PubSub | null = null;

export function getPubSubClient(): PubSub {
  if (!_client) {
    _client = new PubSub({
      projectId: process.env["GOOGLE_CLOUD_PROJECT"] ?? "local",
    });
  }
  return _client;
}

// ─── Topic names ────────────────────────────────────────────────────────────

/** Generator publishes the completed bundle here on every generation run. */
export const TOPIC_GENERATION_COMPLETED = "generation.completed";

/** platform-back publishes a GenerationRequest here; the Python generator subscribes. */
export const TOPIC_GENERATION_REQUESTED = "generation.requested";

/** Generator publishes live per-agent progress events here. */
export const TOPIC_GENERATION_PROGRESS = "generation.progress";

// ─── Subscription names ─────────────────────────────────────────────────────

/**
 * Shared subscription on generation.completed. Same subscription name as
 * the legacy platform/apps/api consumer (`api-completed-sub`) — they do
 * NOT run side-by-side, so there's no need for a second subscription.
 * Step 14 deletes the legacy subscriber; until then avoid running both
 * apps/api and platform-back/api at the same time against the same
 * pubsub project (Pub/Sub load-balances within a subscription — one
 * consumer would starve the other).
 */
export const SUB_PLATFORM_BACK_COMPLETED = "api-completed-sub";

/** platform-back subscribes here to fan out progress events to SSE clients. */
export const SUB_API_PROGRESS = "api-progress-sub";
