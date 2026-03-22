import { PubSub } from "@google-cloud/pubsub";

let _client: PubSub | null = null;

/**
 * Returns a singleton PubSub client.
 *
 * In local dev, set PUBSUB_EMULATOR_HOST=pubsub-emulator:8085 and
 * GOOGLE_CLOUD_PROJECT=local. The SDK automatically routes to the emulator.
 * No code changes needed between dev and production.
 */
export function getPubSubClient(): PubSub {
  if (!_client) {
    _client = new PubSub({
      projectId: process.env["GOOGLE_CLOUD_PROJECT"] ?? "local",
    });
  }
  return _client;
}

// ─── Topic names ──────────────────────────────────────────────────────────────

export const TOPIC_GENERATION_REQUESTED = "generation.requested";
export const TOPIC_GENERATION_PROGRESS = "generation.progress";
export const TOPIC_GENERATION_COMPLETED = "generation.completed";

// ─── Subscription names ───────────────────────────────────────────────────────

/** Python generator subscribes here to receive work. */
export const SUB_GENERATOR = "generator-sub";

/** apps/api subscribes to stream progress events to SSE clients. */
export const SUB_API_PROGRESS = "api-progress-sub";

/** apps/api subscribes to receive completed bundles and write them to DB. */
export const SUB_API_COMPLETED = "api-completed-sub";
