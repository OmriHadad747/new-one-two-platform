import { getPubSubClient, TOPIC_GENERATION_REQUESTED } from "./client.js";
import { GenerationRequestSchema, type GenerationRequest } from "./schemas.js";
import { logger as baseLogger } from "@new-one-two/logger";

const logger = baseLogger.child({ service: "pubsub-client" });

/**
 * Validates and publishes a GenerationRequest to the generation.requested topic.
 *
 * Throws ZodError if the data is invalid — fail fast before hitting Pub/Sub.
 * Returns the Pub/Sub message ID.
 */
export async function publishGenerationRequest(
  data: GenerationRequest
): Promise<string> {
  GenerationRequestSchema.parse(data); // throws ZodError on invalid data

  const topic = getPubSubClient().topic(TOPIC_GENERATION_REQUESTED);
  const messageId = await topic.publishMessage({
    data: Buffer.from(JSON.stringify(data)),
    attributes: {
      jobId: data.jobId,
      tenantId: data.tenantId,
      appId: data.appId,
    },
  });

  logger.info({ jobId: data.jobId, messageId }, "GenerationRequest published");
  return messageId;
}
