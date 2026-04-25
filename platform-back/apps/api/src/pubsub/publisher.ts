import { getPubSubClient, TOPIC_GENERATION_REQUESTED } from "./client.js";

export interface GenerationRequestPayload {
  jobId: string;
  tenantId: string;
  appId: string;
  prompt: string;
  existingFeatures?: string[];
  priorBundle?: Record<string, unknown> | null;
  preComputedIntent?: Record<string, unknown> | null;
}

/**
 * Publishes a GenerationRequest to generation.requested so the Python
 * generator picks it up and starts the pipeline.
 */
export async function publishGenerationRequest(payload: GenerationRequestPayload): Promise<void> {
  const topic = getPubSubClient().topic(TOPIC_GENERATION_REQUESTED);
  await topic.publishMessage({
    data: Buffer.from(JSON.stringify(payload), "utf-8"),
  });
}
