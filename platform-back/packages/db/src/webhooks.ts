import { sql } from "./connection.js";

// ─── resolveWebhookContext ────────────────────────────────────────────────────

export interface WebhookContext {
  tenant: { id: string; billingPlan: string };
  app: { id: string; shopifySecretName: string };
  subscription: { id: string };
  deployedFunction: { id: string; functionUrl: string };
}

/**
 * Single-query context resolution for incoming Shopify webhooks.
 * Returns null when the tenant/app doesn't exist, isn't active, the
 * topic has no active subscription, or the function isn't deployed.
 */
export async function resolveWebhookContext(
  tenantSlug: string,
  appSlug: string,
  topic: string,
): Promise<WebhookContext | null> {
  const rows = await sql<
    Array<{
      tenantId: string;
      billingPlan: string;
      appId: string;
      shopifySecretName: string;
      subscriptionId: string;
      deployedFunctionId: string;
      functionUrl: string;
    }>
  >`
    SELECT
      t.id                   AS "tenantId",
      t.billing_plan         AS "billingPlan",
      a.id                   AS "appId",
      a.shopify_secret_name  AS "shopifySecretName",
      ws.id                  AS "subscriptionId",
      df.id                  AS "deployedFunctionId",
      df.function_url        AS "functionUrl"
    FROM tenants t
    JOIN apps a
      ON a.tenant_id = t.id AND a.slug = ${appSlug} AND a.status = 'active'
    JOIN webhook_subscriptions ws
      ON ws.app_id = a.id AND ws.topic = ${topic} AND ws.active = TRUE
    JOIN deployed_functions df
      ON df.id = ws.deployed_function_id AND df.is_active = TRUE
    WHERE t.slug = ${tenantSlug}
      AND t.status = 'active'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    tenant: { id: row.tenantId, billingPlan: row.billingPlan },
    app: { id: row.appId, shopifySecretName: row.shopifySecretName },
    subscription: { id: row.subscriptionId },
    deployedFunction: {
      id: row.deployedFunctionId,
      functionUrl: row.functionUrl,
    },
  };
}

// ─── Webhook subscription management (deploy-time) ───────────────────────────

export interface WebhookSubscriptionRow {
  appId: string;
  tenantId: string;
  deployedFunctionId: string;
  topic: string;
  shopifyWebhookId: string;
  callbackUrl: string;
}

/**
 * Upserts webhook subscriptions for the just-deployed function.
 * ON CONFLICT (app_id, topic) updates the deployed_function_id and
 * shopify_webhook_id so re-deploys stay consistent without creating duplicates.
 */
export async function upsertWebhookSubscriptions(
  rows: WebhookSubscriptionRow[],
): Promise<void> {
  if (rows.length === 0) return;
  for (const row of rows) {
    await sql`
      INSERT INTO webhook_subscriptions (
        app_id, tenant_id, deployed_function_id,
        topic, shopify_webhook_id, callback_url, active
      ) VALUES (
        ${row.appId}, ${row.tenantId}, ${row.deployedFunctionId},
        ${row.topic}, ${row.shopifyWebhookId}, ${row.callbackUrl}, TRUE
      )
      ON CONFLICT (app_id, topic) DO UPDATE SET
        deployed_function_id = EXCLUDED.deployed_function_id,
        shopify_webhook_id   = EXCLUDED.shopify_webhook_id,
        callback_url         = EXCLUDED.callback_url,
        active               = TRUE,
        updated_at           = NOW()
    `;
  }
}

/**
 * Marks webhook subscriptions as inactive for any topic that is no longer in
 * activeTopics. Returns the Shopify webhook IDs of the deactivated rows so
 * the caller can delete them from Shopify.
 */
export async function deactivateRemovedWebhookSubscriptions(
  appId: string,
  activeTopics: string[],
): Promise<Array<{ shopifyWebhookId: string }>> {
  if (activeTopics.length === 0) {
    return sql<Array<{ shopifyWebhookId: string }>>`
      UPDATE webhook_subscriptions
         SET active = FALSE, updated_at = NOW()
       WHERE app_id = ${appId} AND active = TRUE
      RETURNING shopify_webhook_id AS "shopifyWebhookId"
    `;
  }
  return sql<Array<{ shopifyWebhookId: string }>>`
    UPDATE webhook_subscriptions
       SET active = FALSE, updated_at = NOW()
     WHERE app_id = ${appId}
       AND active = TRUE
       AND topic != ALL(${activeTopics}::text[])
    RETURNING shopify_webhook_id AS "shopifyWebhookId"
  `;
}

// ─── Invocation log ────────────────────────────────────────────────────────────

export interface CreateWebhookInvocationLogInput {
  webhookSubscriptionId: string;
  deployedFunctionId: string;
  appId: string;
  tenantId: string;
  topic: string;
  shopifyWebhookId: string;
  requestPayloadHash: string;
}

/** Creates a log row, or returns isDuplicate=true if the shopify_webhook_id
 *  was already processed (UNIQUE constraint on (app_id, shopify_webhook_id)). */
export async function createWebhookInvocationLog(
  input: CreateWebhookInvocationLogInput,
): Promise<{ id: string; isDuplicate: boolean }> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO webhook_invocation_logs (
      webhook_subscription_id, deployed_function_id,
      app_id, tenant_id, topic, shopify_webhook_id,
      request_payload_hash, status
    ) VALUES (
      ${input.webhookSubscriptionId},
      ${input.deployedFunctionId},
      ${input.appId},
      ${input.tenantId},
      ${input.topic},
      ${input.shopifyWebhookId},
      ${input.requestPayloadHash},
      'queued'
    )
    ON CONFLICT (app_id, shopify_webhook_id) DO NOTHING
    RETURNING id
  `;
  const row = rows[0];
  if (!row) {
    // Conflict — find the existing row's id so callers can log it
    const existing = await sql<Array<{ id: string }>>`
      SELECT id FROM webhook_invocation_logs
      WHERE app_id = ${input.appId}
        AND shopify_webhook_id = ${input.shopifyWebhookId}
      LIMIT 1
    `;
    return { id: existing[0]?.id ?? "", isDuplicate: true };
  }
  return { id: row.id, isDuplicate: false };
}

export interface UpdateWebhookInvocationLogInput {
  status: "running" | "success" | "failed";
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  responseStatusCode?: number;
  shopifyApiCalls?: number;
  invocationId?: string;
  errorMessage?: string;
}

export async function updateWebhookInvocationLog(
  id: string,
  input: UpdateWebhookInvocationLogInput,
): Promise<void> {
  await sql`
    UPDATE webhook_invocation_logs SET
      status                = ${input.status},
      started_at            = ${input.startedAt ?? null},
      completed_at          = ${input.completedAt ?? null},
      duration_ms           = ${input.durationMs ?? null},
      response_status_code  = ${input.responseStatusCode ?? null},
      shopify_api_calls     = ${input.shopifyApiCalls ?? 0},
      invocation_id         = ${input.invocationId ?? null},
      error_message         = ${input.errorMessage ?? null}
    WHERE id = ${id}
  `;
}
