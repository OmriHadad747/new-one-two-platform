import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  resolveWebhookContext,
  createWebhookInvocationLog,
  checkUsageQuota,
  trackAppExecution,
} from "@platform-back/db";
import { getSecret, validateShopifyHmac, hashPayload } from "@platform-back/crypto";
import { createRequestLogger } from "@platform-back/logger";
import { enqueueWebhook } from "../queue/webhook-queue.js";
import type { WebhookRouteParams } from "@platform-back/types";
import { getPlanLimits } from "@platform-back/types";
import type { BillingPlan } from "@platform-back/types";

declare module "fastify" {
  interface FastifyContextConfig {
    rawBody?: boolean;
  }
}

interface ShopifyWebhookHeaders {
  "x-shopify-hmac-sha256": string;
  "x-shopify-topic": string;
  "x-shopify-webhook-id": string;
  "x-shopify-shop-domain": string;
  "x-shopify-api-version": string;
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post<{
    Params: WebhookRouteParams;
    Headers: ShopifyWebhookHeaders;
  }>(
    "/:tenantSlug/:appSlug",
    {
      config: { rawBody: true },
      schema: {
        params: {
          type: "object",
          required: ["tenantSlug", "appSlug"],
          properties: {
            tenantSlug: { type: "string", minLength: 1 },
            appSlug: { type: "string", minLength: 1 },
          },
        },
        headers: {
          type: "object",
          required: ["x-shopify-hmac-sha256", "x-shopify-topic", "x-shopify-webhook-id"],
        },
      },
    },
    webhookHandler,
  );
}

async function webhookHandler(
  request: FastifyRequest<{
    Params: WebhookRouteParams;
    Headers: ShopifyWebhookHeaders;
  }>,
  reply: FastifyReply,
) {
  const { tenantSlug, appSlug } = request.params;
  const topic = request.headers["x-shopify-topic"];
  const shopifyWebhookId = request.headers["x-shopify-webhook-id"];
  const hmacHeader = request.headers["x-shopify-hmac-sha256"];

  const log = createRequestLogger({ requestId: request.id });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawBody: Buffer = (request as any).rawBody;
  if (!rawBody || rawBody.length === 0) {
    log.warn("Empty webhook body");
    return reply.code(400).send({ error: "Empty body" });
  }

  const ctx = await resolveWebhookContext(tenantSlug, appSlug, topic);
  if (!ctx) {
    log.warn("Could not resolve webhook context");
    return reply.code(404).send({ error: "Not found" });
  }

  const secret = await getSecret(ctx.app.shopifySecretName);
  if (!validateShopifyHmac(rawBody, hmacHeader, secret)) {
    log.warn({ shopifyWebhookId }, "HMAC validation failed");
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const payloadHash = hashPayload(rawBody);
  const { id: executionLogId, isDuplicate } = await createWebhookInvocationLog({
    webhookSubscriptionId: ctx.subscription.id,
    deployedFunctionId: ctx.deployedFunction.id,
    appId: ctx.app.id,
    tenantId: ctx.tenant.id,
    topic,
    shopifyWebhookId,
    requestPayloadHash: payloadHash,
  });

  if (isDuplicate) {
    log.info({ shopifyWebhookId, executionLogId }, "Duplicate webhook");
    return reply.code(200).send({ status: "duplicate" });
  }

  const tenantPlan = (ctx.tenant.billingPlan ?? "free") as BillingPlan;
  const execLimit = getPlanLimits(tenantPlan).maxAppExecutionsPerMonth;
  const quota = await checkUsageQuota(ctx.tenant.id, "app_executions", execLimit);
  if (!quota.allowed) {
    log.warn({ tenantId: ctx.tenant.id, plan: tenantPlan }, "Execution quota exceeded");
    return reply.code(200).send({ status: "quota_exceeded" });
  }

  await trackAppExecution(ctx.tenant.id);

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
    receivedAt: new Date().toISOString(),
  });

  log.info({ shopifyWebhookId, executionLogId, jobId: job.id }, "Webhook queued");
  return reply.code(200).send({ status: "queued", executionLogId, jobId: job.id });
}
