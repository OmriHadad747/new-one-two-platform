// ─── Webhook Gateway Queries ──────────────────────────────────────────────────
// These are hot-path queries called on every inbound webhook. They're designed
// to be fetched together in a single query to minimize round-trips.

import type { Tenant, App, DeployedFunction, WebhookSubscription, AppArchetype } from "@new-one-two/types";
import { sql } from "./connection.js";

export interface GatewayContext {
  tenant: Tenant;
  app: App;
  deployedFunction: DeployedFunction;
  subscription: WebhookSubscription;
}

/**
 * Resolves everything the webhook gateway needs in ONE query.
 * Returns null if tenant/app doesn't exist, is inactive, or has no active function.
 */
export async function resolveWebhookContext(
  tenantSlug: string,
  appSlug: string,
  topic: string
): Promise<GatewayContext | null> {
  const rows = await sql<
    Array<{
      tenantId: string;
      tenantSlug: string;
      tenantName: string;
      tenantStatus: string;
      tenantPlan: string;
      tenantBillingPlan: string;
      tenantKmsKeyName: string;
      tenantShopDomain: string | null;
      tenantShopifyAccessTokenSecretName: string | null;
      tenantStorefrontAccessTokenSecretName: string | null;
      appId: string;
      appTenantId: string;
      appSlug: string;
      appName: string;
      appStatus: string;
      appArchetype: string;
      appWidgetJs: string | null;
      appAdminUiJs: string | null;
      appShopifyClientId: string;
      appShopifySecretName: string;
      appShopifyAccessTokenSecretName: string | null;
      appShopDomain: string;
      appCreatedAt: Date;
      appUpdatedAt: Date;
      dfId: string;
      dfFunctionUrl: string;
      dfMemoryMb: number;
      dfTimeoutSec: number;
      dfEnvVarsEncrypted: string | null;
      wsId: string;
      wsTopic: string;
      wsShopifyWebhookId: string;
      wsCallbackUrl: string;
    }>
  >`
    SELECT
      t.id                                   AS tenant_id,
      t.slug                                 AS tenant_slug,
      t.name                                 AS tenant_name,
      t.status                               AS tenant_status,
      t.plan                                 AS tenant_plan,
      t.billing_plan                         AS tenant_billing_plan,
      t.kms_key_name                         AS tenant_kms_key_name,
      t.shop_domain                          AS tenant_shop_domain,
      t.shopify_access_token_secret_name      AS tenant_shopify_access_token_secret_name,
      t.storefront_access_token_secret_name   AS tenant_storefront_access_token_secret_name,

      a.id                                   AS app_id,
      a.tenant_id                            AS app_tenant_id,
      a.slug                                 AS app_slug,
      a.name                                 AS app_name,
      a.status                               AS app_status,
      a.app_archetype                        AS app_archetype,
      a.widget_js                            AS app_widget_js,
      a.admin_ui_js                          AS app_admin_ui_js,
      a.shopify_client_id                    AS app_shopify_client_id,
      a.shopify_secret_name                  AS app_shopify_secret_name,
      a.shop_domain                          AS app_shop_domain,
      a.created_at                           AS app_created_at,
      a.updated_at                           AS app_updated_at,

      df.id           AS df_id,
      df.function_url AS df_function_url,
      df.memory_mb    AS df_memory_mb,
      df.timeout_sec  AS df_timeout_sec,
      df.env_vars_encrypted AS df_env_vars_encrypted,

      ws.id                  AS ws_id,
      ws.topic               AS ws_topic,
      ws.shopify_webhook_id  AS ws_shopify_webhook_id,
      ws.callback_url        AS ws_callback_url

    FROM tenants t
    JOIN apps a
      ON a.tenant_id = t.id
      AND a.slug = ${appSlug}
      AND a.status = 'active'
    JOIN webhook_subscriptions ws
      ON ws.app_id = a.id
      AND ws.topic = ${topic}
      AND ws.active = TRUE
    JOIN deployed_functions df
      ON df.id = ws.deployed_function_id
      AND df.is_active = TRUE
    WHERE
      t.slug = ${tenantSlug}
      AND t.status = 'active'
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    tenant: {
      id: row.tenantId,
      slug: row.tenantSlug,
      name: row.tenantName,
      status: row.tenantStatus as Tenant["status"],
      plan: row.tenantPlan,
      billingPlan: row.tenantBillingPlan as any,
      billingInterval: "monthly" as any,
      subscriptionStatus: "none" as any,
      shopifySubscriptionId: null,
      trialEndsAt: null,
      billingCycleAnchor: new Date(),
      planUpdatedAt: new Date(),
      kmsKeyName: row.tenantKmsKeyName,
      shopDomain: row.tenantShopDomain,
      shopifyAccessTokenSecretName: row.tenantShopifyAccessTokenSecretName,
      storefrontAccessTokenSecretName: row.tenantStorefrontAccessTokenSecretName,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    app: {
      id: row.appId,
      tenantId: row.appTenantId,
      slug: row.appSlug,
      name: row.appName,
      status: row.appStatus as App["status"],
      appArchetype: row.appArchetype as AppArchetype,
      widgetJs: row.appWidgetJs,
      adminUiJs: row.appAdminUiJs,
      shopifyClientId: row.appShopifyClientId,
      shopifySecretName: row.appShopifySecretName,
      shopDomain: row.appShopDomain,
      themeInjectionStatus: "none" as const,
      themeInjectionThemeId: null,
      currentSemver: null,
      activeAppVersionId: null,
      createdAt: row.appCreatedAt,
      updatedAt: row.appUpdatedAt,
    },
    deployedFunction: {
      id: row.dfId,
      appVersionId: "",
      appId: row.appId,
      tenantId: row.tenantId,
      functionUrl: row.dfFunctionUrl,
      runtime: "nodejs20",
      memoryMb: row.dfMemoryMb,
      timeoutSec: row.dfTimeoutSec,
      envVarsEncrypted: row.dfEnvVarsEncrypted ?? "",
      deployedAt: new Date(),
      isActive: true,
    },
    subscription: {
      id: row.wsId,
      appId: row.appId,
      tenantId: row.tenantId,
      deployedFunctionId: row.dfId,
      topic: row.wsTopic as WebhookSubscription["topic"],
      shopifyWebhookId: row.wsShopifyWebhookId,
      callbackUrl: row.wsCallbackUrl,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

/**
 * Creates an execution log entry (idempotent — returns existing if duplicate).
 * The unique index on (app_id, shopify_webhook_id) enforces at-most-once queuing.
 */
export async function createWebhookInvocationLog(params: {
  webhookSubscriptionId: string;
  deployedFunctionId: string;
  appId: string;
  tenantId: string;
  topic: string;
  shopifyWebhookId: string;
  requestPayloadHash: string;
}): Promise<{ id: string; isDuplicate: boolean }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO webhook_invocation_logs (
      webhook_subscription_id,
      deployed_function_id,
      app_id,
      tenant_id,
      topic,
      shopify_webhook_id,
      request_payload_hash,
      status
    ) VALUES (
      ${params.webhookSubscriptionId},
      ${params.deployedFunctionId},
      ${params.appId},
      ${params.tenantId},
      ${params.topic},
      ${params.shopifyWebhookId},
      ${params.requestPayloadHash},
      'queued'
    )
    ON CONFLICT (app_id, shopify_webhook_id) DO NOTHING
    RETURNING id
  `;

  if (rows.length === 0) {
    // Duplicate — find the existing log
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM webhook_invocation_logs
      WHERE app_id = ${params.appId}
        AND shopify_webhook_id = ${params.shopifyWebhookId}
      LIMIT 1
    `;
    return { id: existing[0]!.id, isDuplicate: true };
  }

  return { id: rows[0]!.id, isDuplicate: false };
}

/**
 * Transitions execution log status. Called by the worker.
 */
export async function updateWebhookInvocationLog(
  id: string,
  update: {
    status: "running" | "success" | "failed" | "timeout";
    durationMs?: number;
    responseStatusCode?: number;
    errorMessage?: string;
    invocationId?: string;
    shopifyApiCalls?: number;
    startedAt?: Date;
    completedAt?: Date;
  }
): Promise<void> {
  await sql`
    UPDATE webhook_invocation_logs
    SET
      status               = ${update.status},
      duration_ms          = ${update.durationMs ?? null},
      response_status_code = ${update.responseStatusCode ?? null},
      error_message        = ${update.errorMessage ?? null},
      invocation_id        = ${update.invocationId ?? null},
      shopify_api_calls    = ${update.shopifyApiCalls ?? 0},
      started_at           = ${update.startedAt ?? null},
      completed_at         = ${update.completedAt ?? null}
    WHERE id = ${id}
  `;
}
