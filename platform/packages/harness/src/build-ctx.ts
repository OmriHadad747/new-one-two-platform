import { withTenantContext } from "@new-one-two/db";
import { createRequestLogger } from "@new-one-two/logger";
import type { EmailClient, HandlerContext, HarnessInvokeRequest } from "@new-one-two/types";
import { buildShopifyClient } from "./shopify-client.js";

const SHOPIFY_CLIENT_ID = process.env["SHOPIFY_CLIENT_ID"] ?? null;
const SHOPIFY_CLIENT_SECRET_NAME = process.env["SHOPIFY_CLIENT_SECRET_NAME"] ?? null;

const APP_SHOP_DOMAIN = process.env["SHOP_DOMAIN"] ?? "";

export async function buildCtx(
  req: HarnessInvokeRequest,
  // tx is injected by invoke-handler inside the withTenantContext callback
  tx: unknown
): Promise<HandlerContext> {
  const payload = JSON.parse(
    Buffer.from(req.rawBodyBase64, "base64").toString("utf8")
  ) as Record<string, unknown>;

  const logger = createRequestLogger({
    tenantId: req.tenantId,
    appId: req.appId,
    requestId: req.executionLogId,
    topic: req.topic,
  });

  const shopify = await buildShopifyClient(APP_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET_NAME);

  const email: EmailClient = {
    async send(params) {
      logger.info(
        { event: "EMAIL_SENT", tenantId: req.tenantId, ...params },
        "email stub — provider not yet wired (see TD-007)"
      );
    },
  };

  return { shopify, db: tx, payload, logger, tenantId: req.tenantId, email };
}

// Re-export withTenantContext so invoke-handler can use it without extra imports
export { withTenantContext };
