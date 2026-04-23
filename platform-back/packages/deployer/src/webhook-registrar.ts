import { getSecret } from "@platform-back/crypto";
import {
  getTenantAccessTokenSecretName,
  upsertWebhookSubscriptions,
  deactivateRemovedWebhookSubscriptions,
  getActiveWebhookSubscriptionsForTenant,
} from "@platform-back/db";
import { logger } from "@platform-back/logger";

const SHOPIFY_API_VERSION = "2024-01";

export interface RegisterWebhooksInput {
  appId: string;
  appSlug: string;
  tenantId: string;
  tenantSlug: string;
  shopDomain: string;
  deployedFunctionId: string;
  webhookTopics: string[];
}

/**
 * Reconciles Shopify webhook subscriptions against the current deploy's
 * webhookTopics list. On re-deploy with the same topics, only the DB
 * deployed_function_id pointer changes. New topics are registered with
 * Shopify; removed topics are deleted from Shopify and deactivated in DB.
 *
 * Idempotent: safe to retry on partial failure.
 */
export async function registerWebhooks(
  input: RegisterWebhooksInput,
): Promise<void> {
  const {
    appId,
    appSlug,
    tenantId,
    tenantSlug,
    shopDomain,
    deployedFunctionId,
    webhookTopics,
  } = input;

  const gatewayUrl = requireEnv("WEBHOOK_GATEWAY_URL");
  const callbackUrl = `${gatewayUrl}/${tenantSlug}/${appSlug}`;

  // Fetch admin token from Secret Manager.
  const secretName = await getTenantAccessTokenSecretName(tenantId);
  if (!secretName) {
    throw new Error(
      `registerWebhooks: no Shopify admin token on file for tenant ${tenantId}`,
    );
  }
  const adminToken = await getSecret(secretName);

  // List all Shopify webhooks pointing at our gateway callback URL.
  const existing = await listShopifyWebhooks(shopDomain, adminToken, callbackUrl);
  const shopifyById = new Map(existing.map((w) => [w.topic, w.id]));

  const activeTopicSet = new Set(webhookTopics);

  // Register missing topics with Shopify.
  const registeredRows: Array<{
    appId: string;
    tenantId: string;
    deployedFunctionId: string;
    topic: string;
    shopifyWebhookId: string;
    callbackUrl: string;
  }> = [];

  for (const topic of webhookTopics) {
    let shopifyId = shopifyById.get(topic);
    if (!shopifyId) {
      shopifyId = await createShopifyWebhook(
        shopDomain,
        adminToken,
        topic,
        callbackUrl,
      );
      logger.info({ appId, topic, shopifyId }, "Shopify webhook registered");
    } else {
      logger.info(
        { appId, topic, shopifyId },
        "Shopify webhook already registered — updating DB pointer",
      );
    }
    registeredRows.push({
      appId,
      tenantId,
      deployedFunctionId,
      topic,
      shopifyWebhookId: shopifyId,
      callbackUrl,
    });
  }

  // Delete stale Shopify webhooks (topics dropped from this version).
  for (const [topic, shopifyId] of shopifyById) {
    if (!activeTopicSet.has(topic)) {
      await deleteShopifyWebhook(shopDomain, adminToken, shopifyId).catch(
        (err) => {
          logger.warn(
            { err, appId, topic, shopifyId },
            "Failed to delete stale Shopify webhook — continuing",
          );
        },
      );
    }
  }

  // Upsert active subscriptions in DB.
  await upsertWebhookSubscriptions(registeredRows);

  // Deactivate DB rows for topics no longer in this version.
  await deactivateRemovedWebhookSubscriptions(appId, webhookTopics);
}

// ─── Shopify Admin REST helpers ──────────────────────────────────────────────

interface ShopifyWebhook {
  id: string;
  topic: string;
  address: string;
}

async function listShopifyWebhooks(
  shop: string,
  adminToken: string,
  callbackUrl: string,
): Promise<ShopifyWebhook[]> {
  const url =
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json` +
    `?address=${encodeURIComponent(callbackUrl)}&limit=250`;
  const res = await fetch(url, {
    headers: { "X-Shopify-Access-Token": adminToken },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `listShopifyWebhooks failed [${res.status}]: ${body}`,
    );
  }
  const data = (await res.json()) as { webhooks?: ShopifyWebhook[] };
  return (data.webhooks ?? []).map((w) => ({
    id: String(w.id),
    topic: w.topic,
    address: w.address,
  }));
}

async function createShopifyWebhook(
  shop: string,
  adminToken: string,
  topic: string,
  callbackUrl: string,
): Promise<string> {
  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": adminToken,
      },
      body: JSON.stringify({
        webhook: { topic, address: callbackUrl, format: "json" },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `createShopifyWebhook [${topic}] failed [${res.status}]: ${body}`,
    );
  }
  const data = (await res.json()) as { webhook?: { id?: number | string } };
  const id = data.webhook?.id;
  if (!id) throw new Error(`createShopifyWebhook: no id in response for ${topic}`);
  return String(id);
}

async function deleteShopifyWebhook(
  shop: string,
  adminToken: string,
  shopifyWebhookId: string,
): Promise<void> {
  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks/${shopifyWebhookId}.json`,
    {
      method: "DELETE",
      headers: { "X-Shopify-Access-Token": adminToken },
    },
  );
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(
      `deleteShopifyWebhook [${shopifyWebhookId}] failed [${res.status}]: ${body}`,
    );
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// ─── Reinstall reconciliation ────────────────────────────────────────────────

/**
 * On merchant reinstall: delete every known Shopify webhook by ID (in case
 * the gateway URL changed since last deploy), then re-register all active
 * subscriptions fresh against the current WEBHOOK_GATEWAY_URL.
 *
 * Non-fatal per app — a partial failure doesn't abort the OAuth flow.
 * Idempotent: safe to retry.
 */
export async function reregisterTenantWebhooks(
  tenantId: string,
  shopDomain: string,
): Promise<void> {
  const subs = await getActiveWebhookSubscriptionsForTenant(tenantId);
  if (subs.length === 0) return;

  const secretName = await getTenantAccessTokenSecretName(tenantId);
  if (!secretName) {
    logger.warn({ tenantId }, "reregisterTenantWebhooks: no access token on file — skipping");
    return;
  }
  let adminToken: string;
  try {
    adminToken = await getSecret(secretName);
  } catch (err) {
    logger.warn({ err, tenantId }, "reregisterTenantWebhooks: token resolve failed — skipping");
    return;
  }

  // Group rows by appId.
  const byApp = new Map<string, typeof subs>();
  for (const row of subs) {
    const group = byApp.get(row.appId) ?? [];
    group.push(row);
    byApp.set(row.appId, group);
  }

  for (const [appId, rows] of byApp) {
    try {
      // Delete stale Shopify subscriptions by known ID before re-registering.
      // Handles the case where the gateway URL changed between deploys.
      for (const row of rows) {
        await deleteShopifyWebhook(shopDomain, adminToken, row.shopifyWebhookId).catch(
          (err) => {
            logger.warn(
              { err, appId, topic: row.topic, shopifyWebhookId: row.shopifyWebhookId },
              "reregisterTenantWebhooks: delete failed — continuing",
            );
          },
        );
      }

      const { appSlug, tenantSlug, deployedFunctionId } = rows[0]!;
      await registerWebhooks({
        appId,
        appSlug,
        tenantId,
        tenantSlug,
        shopDomain,
        deployedFunctionId,
        webhookTopics: rows.map((r) => r.topic),
      });

      logger.info(
        { appId, topicCount: rows.length },
        "reregisterTenantWebhooks: app webhooks refreshed",
      );
    } catch (err) {
      logger.warn({ err, appId }, "reregisterTenantWebhooks: app failed — continuing");
    }
  }
}

// ─── Unregister (teardown / permanent-delete path) ───────────────────────────

export interface UnregisterShopifyWebhooksInput {
  shopDomain: string;
  /** null when the tenant has no admin token on file — we skip cleanly. */
  accessTokenSecretName: string | null;
  webhooks: Array<{ topic: string; shopifyWebhookId: string }>;
}

/**
 * Best-effort removal of Shopify-side webhook subscriptions when an app
 * is torn down or permanently deleted. Non-fatal: skips on missing token,
 * logs + continues on any per-webhook DELETE failure so partial outages
 * don't prevent the rest of the teardown flow from progressing. The DB
 * side (webhook_subscriptions.is_active) is flipped separately by
 * deactivateAppInfrastructure / hardDeleteApp.
 */
export async function unregisterShopifyWebhooks(
  input: UnregisterShopifyWebhooksInput,
): Promise<void> {
  if (input.webhooks.length === 0) return;

  if (!input.accessTokenSecretName) {
    logger.warn(
      { shopDomain: input.shopDomain },
      "unregisterShopifyWebhooks: no access-token secret on tenant — skipping",
    );
    return;
  }

  let adminToken: string;
  try {
    adminToken = await getSecret(input.accessTokenSecretName);
  } catch (err) {
    logger.warn(
      { err, shopDomain: input.shopDomain },
      "unregisterShopifyWebhooks: secret resolve failed — skipping",
    );
    return;
  }

  for (const wh of input.webhooks) {
    try {
      await deleteShopifyWebhook(input.shopDomain, adminToken, wh.shopifyWebhookId);
      logger.info(
        { topic: wh.topic, shopifyWebhookId: wh.shopifyWebhookId },
        "unregisterShopifyWebhooks: removed",
      );
    } catch (err) {
      logger.warn(
        { err, topic: wh.topic, shopifyWebhookId: wh.shopifyWebhookId },
        "unregisterShopifyWebhooks: DELETE failed — continuing",
      );
    }
  }
}
