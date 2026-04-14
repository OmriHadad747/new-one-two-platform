// ─── Webhook Gateway Queries ──────────────────────────────────────────────────
// These are hot-path queries called on every inbound webhook. They're designed
// to be fetched together in a single query to minimize round-trips.
//
// `GatewayContext` is deliberately a narrow projection — only the fields the
// webhook-gateway actually reads. Returning full `Tenant` / `App` / etc. would
// have required padding the result with fabricated timestamps and hard-coded
// placeholders for columns the query does not SELECT, which misled log
// consumers into thinking they were reading real audit metadata.

import type { BillingPlan } from "@new-one-two/types";
import { sql } from "./connection.js";

export interface GatewayContext {
  tenant: {
    id: string;
    slug: string;
    billingPlan: BillingPlan;
  };
  app: {
    id: string;
    slug: string;
    shopifySecretName: string;
    shopDomain: string;
  };
  deployedFunction: {
    id: string;
    functionUrl: string;
    memoryMb: number;
    timeoutSec: number;
  };
  subscription: {
    id: string;
    topic: string;
  };
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
      tenantBillingPlan: string;
      appId: string;
      appSlug: string;
      appShopifySecretName: string;
      appShopDomain: string;
      dfId: string;
      dfFunctionUrl: string;
      dfMemoryMb: number;
      dfTimeoutSec: number;
      wsId: string;
      wsTopic: string;
    }>
  >`
    SELECT
      t.id                          AS "tenantId",
      t.slug                        AS "tenantSlug",
      t.billing_plan                AS "tenantBillingPlan",

      a.id                          AS "appId",
      a.slug                        AS "appSlug",
      a.shopify_secret_name         AS "appShopifySecretName",
      a.shop_domain                 AS "appShopDomain",

      df.id                         AS "dfId",
      df.function_url               AS "dfFunctionUrl",
      df.memory_mb                  AS "dfMemoryMb",
      df.timeout_sec                AS "dfTimeoutSec",

      ws.id                         AS "wsId",
      ws.topic                      AS "wsTopic"

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
      billingPlan: row.tenantBillingPlan as BillingPlan,
    },
    app: {
      id: row.appId,
      slug: row.appSlug,
      shopifySecretName: row.appShopifySecretName,
      shopDomain: row.appShopDomain,
    },
    deployedFunction: {
      id: row.dfId,
      functionUrl: row.dfFunctionUrl,
      memoryMb: row.dfMemoryMb,
      timeoutSec: row.dfTimeoutSec,
    },
    subscription: {
      id: row.wsId,
      topic: row.wsTopic,
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
