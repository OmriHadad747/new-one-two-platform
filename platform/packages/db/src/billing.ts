// ─── Billing Queries ──────────────────────────────────────────────────────────

import type {
  BillingPlan,
  BillingInterval,
  SubscriptionStatus,
  BillingEvent,
  RevisionClassification,
} from "@new-one-two/types";
import { sql } from "./connection.js";

/**
 * Count active (non-deleted) apps for a tenant.
 */
export async function getActiveAppCount(tenantId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::TEXT AS count FROM apps
    WHERE tenant_id = ${tenantId}
      AND status = 'active'
  `;
  return parseInt(rows[0]!.count, 10);
}

/**
 * Update tenant billing plan and subscription state.
 */
export async function updateTenantBilling(
  tenantId: string,
  params: {
    billingPlan?: BillingPlan;
    billingInterval?: BillingInterval;
    subscriptionStatus?: SubscriptionStatus;
    shopifySubscriptionId?: string | null;
    trialEndsAt?: Date | null;
  }
): Promise<void> {
  await sql`
    UPDATE tenants SET
      ${params.billingPlan !== undefined ? sql`billing_plan = ${params.billingPlan},` : sql``}
      ${params.billingInterval !== undefined ? sql`billing_interval = ${params.billingInterval},` : sql``}
      ${params.subscriptionStatus !== undefined ? sql`subscription_status = ${params.subscriptionStatus},` : sql``}
      ${params.shopifySubscriptionId !== undefined ? sql`shopify_subscription_id = ${params.shopifySubscriptionId},` : sql``}
      ${params.trialEndsAt !== undefined ? sql`trial_ends_at = ${params.trialEndsAt},` : sql``}
      plan_updated_at = NOW(),
      updated_at = NOW()
    WHERE id = ${tenantId}
  `;
}

/**
 * Log a billing event for audit trail.
 */
export async function logBillingEvent(params: {
  tenantId: string;
  eventType: string;
  fromPlan?: BillingPlan | null;
  toPlan?: BillingPlan | null;
  shopifySubscriptionId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  await sql`
    INSERT INTO billing_events (
      tenant_id, event_type, from_plan, to_plan,
      shopify_subscription_id, metadata
    ) VALUES (
      ${params.tenantId}, ${params.eventType},
      ${params.fromPlan ?? null}, ${params.toPlan ?? null},
      ${params.shopifySubscriptionId ?? null},
      ${params.metadata ? JSON.stringify(params.metadata) : null}
    )
  `;
}

/**
 * Get billing event audit trail for a tenant, newest-first.
 */
export async function getBillingEvents(
  tenantId: string,
  limit: number = 50
): Promise<BillingEvent[]> {
  const rows = await sql<BillingEvent[]>`
    SELECT
      id,
      tenant_id       AS "tenantId",
      event_type      AS "eventType",
      from_plan       AS "fromPlan",
      to_plan         AS "toPlan",
      shopify_subscription_id AS "shopifySubscriptionId",
      metadata,
      created_at      AS "createdAt"
    FROM billing_events
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

/**
 * Store a revision classification record for analytics.
 */
export async function storeRevisionClassification(params: {
  tenantId: string;
  appId: string;
  sessionId?: string;
  jobId?: string;
  classification: RevisionClassification;
  confidence: string;
  merchantPrompt: string;
}): Promise<void> {
  await sql`
    INSERT INTO revision_classifications (
      tenant_id, app_id, session_id, job_id,
      classification, confidence, merchant_prompt
    ) VALUES (
      ${params.tenantId}, ${params.appId}, ${params.sessionId ?? null}, ${params.jobId ?? null},
      ${params.classification}, ${params.confidence}, ${params.merchantPrompt}
    )
  `;
}

/**
 * Get revision classification analytics for a tenant.
 */
export async function getRevisionAnalytics(tenantId: string): Promise<{
  total: number;
  bugReports: number;
  featureModifications: number;
  newCapabilities: number;
}> {
  const rows = await sql<{ classification: string; count: string }[]>`
    SELECT classification, COUNT(*)::TEXT AS count
    FROM revision_classifications
    WHERE tenant_id = ${tenantId}
    GROUP BY classification
  `;

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.classification] = parseInt(row.count, 10);
  }

  return {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    bugReports: counts["bug_report"] ?? 0,
    featureModifications: counts["feature_modification"] ?? 0,
    newCapabilities: counts["new_capability"] ?? 0,
  };
}
