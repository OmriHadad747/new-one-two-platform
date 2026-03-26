import { getPubSubClient, TOPIC_GENERATION_REQUESTED } from "./client.js";
import { GenerationRequestSchema } from "./schemas.js";
import type { z } from "zod";
import { logger as baseLogger } from "@new-one-two/logger";

const logger = baseLogger.child({ service: "pubsub-client" });

/**
 * Validates and publishes a GenerationRequest to the generation.requested topic.
 *
 * Throws ZodError if the data is invalid — fail fast before hitting Pub/Sub.
 * Returns the Pub/Sub message ID.
 */
export async function publishGenerationRequest(
  data: z.input<typeof GenerationRequestSchema>
): Promise<string> {
  const parsed = GenerationRequestSchema.parse(data); // fills in defaults, throws ZodError on invalid

  const topic = getPubSubClient().topic(TOPIC_GENERATION_REQUESTED);
  const messageId = await topic.publishMessage({
    data: Buffer.from(JSON.stringify(parsed)),
    attributes: {
      jobId: parsed.jobId,
      tenantId: parsed.tenantId,
      appId: parsed.appId,
    },
  });

  logger.info({ jobId: parsed.jobId, messageId }, "GenerationRequest published");
  return messageId;
}
