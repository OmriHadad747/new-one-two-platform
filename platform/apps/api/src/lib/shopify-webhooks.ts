import { getActiveWebhookTopicsForTenant } from "@new-one-two/db";
import { logger } from "@new-one-two/logger";

const SHOPIFY_API_VERSION = "2026-01";

async function deleteWebhook(shop: string, accessToken: string, id: number): Promise<void> {
  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks/${id}.json`,
    { method: "DELETE", headers: { "X-Shopify-Access-Token": accessToken } }
  );
  if (!res.ok) {
    logger.warn({ shop, webhookId: id, status: res.status }, "Failed to delete Shopify webhook");
  }
}

async function createWebhook(
  shop: string,
  accessToken: string,
  topic: string,
  address: string
): Promise<number | null> {
  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ webhook: { topic, address, format: "json" } }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    logger.warn({ shop, topic, address, status: res.status, body: text }, "Failed to create Shopify webhook");
    return null;
  }
  const data = (await res.json()) as { webhook: { id: number } };
  return data.webhook.id;
}

/**
 * Re-registers all active webhook subscriptions for a tenant using the fresh
 * access token from the OAuth exchange. Deletes stale webhooks first so URL
 * changes (e.g. ngrok rotations) are picked up immediately without a re-deploy.
 */
export async function reRegisterTenantWebhooks(params: {
  tenantId: string;
  shop: string;
  accessToken: string;
}): Promise<void> {
  const rows = await getActiveWebhookTopicsForTenant(params.tenantId);
  if (rows.length === 0) return;

  const webhookBase = process.env["WEBHOOK_BASE_URL"] ?? "http://localhost:3001";
  const allTopics = new Set(rows.map((r) => r.topic));

  // List existing webhooks and delete any for our topics
  const listRes = await fetch(
    `https://${params.shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
    { headers: { "X-Shopify-Access-Token": params.accessToken } }
  );
  if (listRes.ok) {
    const { webhooks } = (await listRes.json()) as {
      webhooks: Array<{ id: number; topic: string }>;
    };
    for (const wh of webhooks) {
      if (allTopics.has(wh.topic)) {
        await deleteWebhook(params.shop, params.accessToken, wh.id);
        logger.debug({ topic: wh.topic, webhookId: wh.id }, "Deleted stale Shopify webhook");
      }
    }
  }

  // Re-create each (app, topic) with the current callback URL
  for (const row of rows) {
    const callbackUrl = `${webhookBase}/${row.tenantSlug}/${row.appSlug}`;
    const id = await createWebhook(params.shop, params.accessToken, row.topic, callbackUrl);
    if (id !== null) {
      logger.info(
        { topic: row.topic, shopifyWebhookId: id, callbackUrl },
        "Re-registered Shopify webhook after OAuth re-install"
      );
    }
  }
}
