import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

declare module "fastify" {
  interface FastifyContextConfig {
    rawBody?: boolean;
  }
}
import { resolveWebhookContext, createExecutionLog } from "@new-one-two/db";
import { getSecret, validateShopifyHmac, hashPayload } from "@new-one-two/crypto";
import { createRequestLogger } from "@new-one-two/logger";
import { enqueueWebhook } from "../queue/webhook-queue.js";
import type { WebhookRouteParams } from "@new-one-two/types";

// Shopify sends these headers with every webhook
interface ShopifyWebhookHeaders {
  "x-shopify-hmac-sha256": string;
  "x-shopify-topic": string;
  "x-shopify-webhook-id": string;
  "x-shopify-shop-domain": string;
  "x-shopify-api-version": string;
}

// ─── Route Registration ────────────────────────────────────────────────────────

export async function webhookRoutes(app: FastifyInstance) {
  app.post<{
    Params: WebhookRouteParams;
    Headers: ShopifyWebhookHeaders;
  }>(
    "/:tenantId/:appId",
    {
      config: { rawBody: true }, // required for HMAC validation
      schema: {
        params: {
          type: "object",
          required: ["tenantId", "appId"],
          properties: {
            tenantId: { type: "string", minLength: 1 },
            appId: { type: "string", minLength: 1 },
          },
        },
        headers: {
          type: "object",
          required: [
            "x-shopify-hmac-sha256",
            "x-shopify-topic",
            "x-shopify-webhook-id",
          ],
          properties: {
            "x-shopify-hmac-sha256": { type: "string" },
            "x-shopify-topic": { type: "string" },
            "x-shopify-webhook-id": { type: "string" },
            "x-shopify-shop-domain": { type: "string" },
          },
        },
      },
    },
    webhookHandler
  );
}

// ─── Handler ───────────────────────────────────────────────────────────────────

async function webhookHandler(
  request: FastifyRequest<{
    Params: WebhookRouteParams;
    Headers: ShopifyWebhookHeaders;
  }>,
  reply: FastifyReply
) {
  const { tenantId, appId } = request.params;
  const topic = request.headers["x-shopify-topic"];
  const shopifyWebhookId = request.headers["x-shopify-webhook-id"];
  const hmacHeader = request.headers["x-shopify-hmac-sha256"];

  const log = createRequestLogger({
    tenantId,
    appId,
    requestId: request.id,
    topic,
  });

  const receivedAt = new Date().toISOString();

  // ── 1. Get raw body ────────────────────────────────────────────────────────
  // Fastify doesn't expose rawBody by default; the raw-body plugin stores it.
  const rawBody: Buffer = (request as any).rawBody;
  if (!rawBody || rawBody.length === 0) {
    log.warn("Empty webhook body received");
    return reply.code(400).send({ error: "Empty body" });
  }

  // ── 2. Resolve context (tenant + app + deployed function) ──────────────────
  // This single query validates that the tenant/app exists and is active,
  // and fetches everything needed for HMAC validation and routing.
  const ctx = await resolveWebhookContext(tenantId, appId, topic);

  if (!ctx) {
    // Don't leak whether the tenant/app exists — always 404
    log.warn("Could not resolve webhook context — tenant/app/function not found or inactive");
    return reply.code(404).send({ error: "Not found" });
  }

  // ── 3. Validate Shopify HMAC ───────────────────────────────────────────────
  // Fetch the webhook signing secret from GCP Secret Manager, then validate.
  const secret = await getSecret(ctx.app.shopifySecretName);
  const isValid = validateShopifyHmac(rawBody, hmacHeader, secret);

  if (!isValid) {
    log.warn({ shopifyWebhookId }, "HMAC validation failed — rejecting webhook");
    // Return 401 immediately; Shopify will retry — we intentionally don't
    // provide detail so attackers can't distinguish wrong secret from wrong body.
    return reply.code(401).send({ error: "Unauthorized" });
  }

  log.debug({ shopifyWebhookId, topic }, "HMAC validated");

  // ── 4. Idempotency check + create execution log ────────────────────────────
  const payloadHash = hashPayload(rawBody);

  const { id: executionLogId, isDuplicate } = await createExecutionLog({
    webhookSubscriptionId: ctx.subscription.id,
    deployedFunctionId: ctx.deployedFunction.id,
    appId: ctx.app.id,
    tenantId: ctx.tenant.id,
    topic,
    shopifyWebhookId,
    requestPayloadHash: payloadHash,
  });

  if (isDuplicate) {
    // Shopify retries on 5xx — returning 200 here stops the retry loop
    // for genuinely duplicate deliveries.
    log.info({ shopifyWebhookId, executionLogId }, "Duplicate webhook — already processed");
    return reply.code(200).send({ status: "duplicate" });
  }

  // ── 5. Enqueue for async execution ────────────────────────────────────────
  const job = await enqueueWebhook({
    executionLogId,
    tenantId: ctx.tenant.id,
    appId: ctx.app.id,
    deployedFunctionId: ctx.deployedFunction.id,
    functionUrl: ctx.deployedFunction.functionUrl,
    topic,
    shopifyWebhookId,
    rawBodyBase64: rawBody.toString("base64"),
    headers: {
      "x-shopify-topic": topic,
      "x-shopify-webhook-id": shopifyWebhookId,
      "x-shopify-shop-domain": request.headers["x-shopify-shop-domain"] ?? "",
      "x-shopify-api-version": request.headers["x-shopify-api-version"] ?? "",
    },
    receivedAt,
  });

  log.info(
    { shopifyWebhookId, executionLogId, jobId: job.id, topic },
    "Webhook accepted and queued"
  );

  // ── 6. Respond to Shopify ──────────────────────────────────────────────────
  // Shopify requires a 200 response within 5s to avoid retries.
  // We always respond synchronously after queuing — the Lambda runs async.
  return reply.code(200).send({
    status: "queued",
    executionLogId,
    jobId: job.id,
  });
}
