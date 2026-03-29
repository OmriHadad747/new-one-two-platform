import { withTenantContext } from "@new-one-two/db";
import { createRequestLogger } from "@new-one-two/logger";
import type { EmailClient, HandlerContext } from "@new-one-two/types";
import { loadModule } from "./module-loader.js";
import { buildShopifyClient } from "./shopify-client.js";

const SHOPIFY_CLIENT_ID = process.env["SHOPIFY_CLIENT_ID"] ?? null;
const SHOPIFY_CLIENT_SECRET_NAME = process.env["SHOPIFY_CLIENT_SECRET_NAME"] ?? null;
const APP_SHOP_DOMAIN = process.env["SHOP_DOMAIN"] ?? "";

// The deployer injects TENANT_ID as an env var into every harness container.
// The X-Tenant-Id header is a fallback for local development.
const ENV_TENANT_ID = process.env["TENANT_ID"] ?? null;

export async function handleWidgetInvoke(
  tenantIdFromHeader: string | undefined,
  widgetPath: string,
  body: Record<string, unknown>
): Promise<{ status: number; data: unknown }> {
  const tenantId = ENV_TENANT_ID ?? tenantIdFromHeader;

  if (!tenantId) {
    return { status: 400, data: { error: "missing_tenant_id" } };
  }

  const mod = loadModule();

  let result: unknown;

  try {
    await withTenantContext(tenantId, async (tx) => {
      const shopify = await buildShopifyClient(
        APP_SHOP_DOMAIN,
        SHOPIFY_CLIENT_ID,
        SHOPIFY_CLIENT_SECRET_NAME
      );

      const logger = createRequestLogger({ tenantId, topic: `widget:${widgetPath}` });

      const email: EmailClient = {
        async send(params) {
          logger.info(
            { event: "EMAIL_SENT", tenantId, ...params },
            "email stub — provider not yet wired (see TD-007)"
          );
        },
      };

      const ctx: HandlerContext = {
        shopify,
        db: tx,
        payload: {},
        logger,
        tenantId,
        email,
        trigger: "widget",
        widgetPath,
        widgetBody: body,
        customerId: (body.customerId as string | null) ?? null,
      };

      result = await mod.handler(ctx);
    });

    return { status: 200, data: result ?? {} };
  } catch (err: unknown) {
    return {
      status: 500,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
