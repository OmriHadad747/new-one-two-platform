import type { BillingPlan, BillingInterval, SubscriptionStatus, RevisionClassification } from "@platform-back/types";
import { sql } from "./connection.js";

export interface BillingEvent {
  id: string;
  tenantId: string;
  eventType: string;
  fromPlan: BillingPlan | null;
  toPlan: BillingPlan | null;
  shopifySubscriptionId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface RevisionAnalytics {
  total: number;
  bugReports: number;
  featureModifications: number;
  newCapabilities: number;
}

export async function updateTenantBilling(
  tenantId: string,
  params: {
    billingPlan?: BillingPlan;
    billingInterval?: BillingInterval;
    subscriptionStatus?: SubscriptionStatus;
    shopifySubscriptionId?: string | null;
    trialEndsAt?: Date | null;
  },
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

export async function getBillingEvents(
  tenantId: string,
  limit = 50,
): Promise<BillingEvent[]> {
  return sql<BillingEvent[]>`
    SELECT
      id,
      tenant_id               AS "tenantId",
      event_type              AS "eventType",
      from_plan               AS "fromPlan",
      to_plan                 AS "toPlan",
      shopify_subscription_id AS "shopifySubscriptionId",
      metadata,
      created_at              AS "createdAt"
    FROM billing_events
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

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
      ${params.tenantId}, ${params.appId},
      ${params.sessionId ?? null}, ${params.jobId ?? null},
      ${params.classification}, ${params.confidence}, ${params.merchantPrompt}
    )
  `;
}

export async function getRevisionAnalytics(
  tenantId: string,
): Promise<RevisionAnalytics> {
  const rows = await sql<Array<{ classification: string; count: string }>>`
    SELECT classification, COUNT(*)::TEXT AS count
    FROM revision_classifications
    WHERE tenant_id = ${tenantId}
    GROUP BY classification
  `;
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.classification] = parseInt(row.count, 10);
  return {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    bugReports: counts["bug_report"] ?? 0,
    featureModifications: counts["feature_modification"] ?? 0,
    newCapabilities: counts["new_capability"] ?? 0,
  };
}
