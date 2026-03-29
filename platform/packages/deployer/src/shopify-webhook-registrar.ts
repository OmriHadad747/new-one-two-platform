import { getSecret } from "@new-one-two/crypto";
import { getActiveWebhookTopicsForTenant } from "@new-one-two/db";
import { logger } from "@new-one-two/logger";

const SHOPIFY_API_VERSION = "2026-01";

// ─── Internal Shopify REST helpers ────────────────────────────────────────────

interface ShopifyWebhook {
  id: number;
  topic: string;
  address: string;
}

async function shopifyGet(shop: string, accessToken: string, path: string): Promise<unknown> {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
    headers: { "X-Shopify-Access-Token": accessToken },
  });
  if (!res.ok) {
    logger.warn({ shop, path, status: res.status }, "Shopify GET failed");
    return null;
  }
  return res.json();
}

async function shopifyPost(
  shop: string,
  accessToken: string,
  path: string,
  body: unknown
): Promise<{ id: number } | null> {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    logger.warn({ shop, path, status: res.status, body: text }, "Shopify POST failed");
    return null;
  }
  const data = (await res.json()) as { webhook?: { id: number } };
  return data.webhook ?? null;
}

async function shopifyDelete(shop: string, accessToken: string, path: string): Promise<void> {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
    method: "DELETE",
    headers: { "X-Shopify-Access-Token": accessToken },
  });
  if (!res.ok) {
    logger.warn({ shop, path, status: res.status }, "Shopify DELETE failed");
  }
}

async function listWebhooks(shop: string, accessToken: string): Promise<ShopifyWebhook[]> {
  const data = await shopifyGet(shop, accessToken, "/webhooks.json");
  return (data as { webhooks?: ShopifyWebhook[] })?.webhooks ?? [];
}

// ─── Core registration logic ──────────────────────────────────────────────────

/**
 * Idempotent: deletes any existing webhooks for the given topics (handles URL
 * changes like ngrok rotations), then creates fresh ones.
 * Returns a map of topic → Shopify webhook ID for DB persistence.
 */
async function syncWebhooks(
  shop: string,
  accessToken: string,
  topics: string[],
  callbackUrl: string
): Promise<Record<string, string>> {
  const topicSet = new Set(topics);

  // Remove stale webhooks for our topics before recreating
  const existing = await listWebhooks(shop, accessToken);
  for (const wh of existing) {
    if (topicSet.has(wh.topic)) {
      await shopifyDelete(shop, accessToken, `/webhooks/${wh.id}.json`);
      logger.debug({ topic: wh.topic, webhookId: wh.id }, "Deleted stale Shopify webhook");
    }
  }

  const result: Record<string, string> = {};
  for (const topic of topics) {
    const wh = await shopifyPost(shop, accessToken, "/webhooks.json", {
      webhook: { topic, address: callbackUrl, format: "json" },
    });
    if (wh) {
      result[topic] = String(wh.id);
      logger.info({ topic, shopifyWebhookId: wh.id, callbackUrl }, "Registered Shopify webhook");
    }
  }
  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Called by the deployer after a successful deployment.
 * Resolves the merchant access token from Secret Manager and registers the
 * app's webhook topics with Shopify.
 *
 * Non-fatal: if the token is unavailable (e.g. not yet in SM_DEV_SECRETS),
 * a warning is logged and the deployment completes without webhook registration.
 *
 * @returns map of topic → shopifyWebhookId (empty if registration was skipped)
 */
export async function registerShopifyWebhooks(params: {
  shop: string;
  accessTokenSecretName: string | null;
  topics: string[];
  callbackUrl: string;
}): Promise<Record<string, string>> {
  if (params.topics.length === 0) return {};

  if (!params.accessTokenSecretName) {
    logger.warn({ shop: params.shop }, "Shopify webhook registration skipped — no access token secret name on tenant");
    return {};
  }

  let accessToken: string;
  try {
    accessToken = await getSecret(params.accessTokenSecretName);
  } catch (err) {
    logger.warn(
      { err, secretName: params.accessTokenSecretName },
      "Shopify webhook registration skipped — could not resolve access token. " +
      `In dev, add the merchant token to SM_DEV_SECRETS under key "${params.accessTokenSecretName}".`
    );
    return {};
  }

  return syncWebhooks(params.shop, accessToken, params.topics, params.callbackUrl);
}

/**
 * Called by the OAuth callback after a merchant re-installs the app.
 * Re-registers all active webhook subscriptions for the tenant using the
 * fresh access token, pointing them at the current WEBHOOK_BASE_URL.
 * This is the primary mechanism for surviving ngrok URL rotations.
 */
export async function reRegisterTenantWebhooks(params: {
  tenantId: string;
  shop: string;
  accessToken: string;
}): Promise<void> {
  const rows = await getActiveWebhookTopicsForTenant(params.tenantId);
  if (rows.length === 0) return;

  const webhookBase = process.env["WEBHOOK_BASE_URL"] ?? "http://localhost:3001";

  // Collect all topics across all apps so we can bulk-delete first
  const allTopics = rows.map((r) => r.topic);

  const existing = await listWebhooks(params.shop, params.accessToken);
  for (const wh of existing) {
    if (allTopics.includes(wh.topic)) {
      await shopifyDelete(params.shop, params.accessToken, `/webhooks/${wh.id}.json`);
      logger.debug({ topic: wh.topic, webhookId: wh.id }, "Deleted stale Shopify webhook (re-install)");
    }
  }

  // Re-create per (app, topic) — each app has its own callback URL
  for (const row of rows) {
    const callbackUrl = `${webhookBase}/${row.tenantSlug}/${row.appSlug}`;
    const wh = await shopifyPost(params.shop, params.accessToken, "/webhooks.json", {
      webhook: { topic: row.topic, address: callbackUrl, format: "json" },
    });
    if (wh) {
      logger.info(
        { topic: row.topic, shopifyWebhookId: wh.id, callbackUrl },
        "Re-registered Shopify webhook after OAuth re-install"
      );
    }
  }
}
