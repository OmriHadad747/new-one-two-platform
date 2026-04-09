// ─── Billing & Usage Queries ─────────────────────────────────────────────────

import type {
  BillingPlan,
  SubscriptionStatus,
  UsageRecord,
  RevisionClassification,
} from "@new-one-two/types";
import { sql } from "./connection.js";

/**
 * Compute the current billing period start date for a tenant.
 * Uses billing_cycle_anchor (the day the subscription was activated) to align
 * usage resets with Shopify's billing cycle, not the calendar month.
 */
async function getBillingPeriodStart(tenantId: string): Promise<string> {
  const rows = await sql<{ billingCycleAnchor: Date }[]>`
    SELECT billing_cycle_anchor FROM tenants WHERE id = ${tenantId}
  `;
  const anchor = rows[0]?.billingCycleAnchor ?? new Date();
  const anchorDay = anchor.getDate();

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), anchorDay);
  // If we haven't reached the anchor day this month, the period started last month
  if (now < periodStart) {
    periodStart.setMonth(periodStart.getMonth() - 1);
  }
  return periodStart.toISOString().slice(0, 10);
}

/**
 * Get or create the usage record for the current billing period.
 * Period aligns with billing_cycle_anchor (subscription start date).
 * Uses ON CONFLICT DO UPDATE to avoid the race condition of DO NOTHING + SELECT.
 */
export async function getOrCreateUsageRecord(tenantId: string): Promise<UsageRecord> {
  const periodStr = await getBillingPeriodStart(tenantId);

  const rows = await sql<UsageRecord[]>`
    INSERT INTO usage_records (tenant_id, period_start)
    VALUES (${tenantId}, ${periodStr})
    ON CONFLICT (tenant_id, period_start)
    DO UPDATE SET updated_at = NOW()
    RETURNING *
  `;

  return rows[0]!;
}

/**
 * Atomically increment a usage counter for the current billing period.
 */
export async function incrementUsage(
  tenantId: string,
  column: "generations" | "revisions" | "app_executions" | "emails_sent" | "sms_sent" | "files_uploaded"
): Promise<void> {
  const periodStr = await getBillingPeriodStart(tenantId);

  // Upsert + increment in one statement
  await sql`
    INSERT INTO usage_records (tenant_id, period_start, ${sql(column)})
    VALUES (${tenantId}, ${periodStr}, 1)
    ON CONFLICT (tenant_id, period_start)
    DO UPDATE SET ${sql(column)} = usage_records.${sql(column)} + 1,
                  updated_at = NOW()
  `;
}

/**
 * Count active (non-deleted) apps for a tenant.
 */
export async function getActiveAppCount(tenantId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::TEXT AS count FROM apps
    WHERE tenant_id = ${tenantId}
      AND status NOT IN ('deleted')
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
    subscriptionStatus?: SubscriptionStatus;
    shopifySubscriptionId?: string | null;
    trialEndsAt?: Date | null;
  }
): Promise<void> {
  await sql`
    UPDATE tenants SET
      ${params.billingPlan !== undefined ? sql`billing_plan = ${params.billingPlan},` : sql``}
      ${params.subscriptionStatus !== undefined ? sql`subscription_status = ${params.subscriptionStatus},` : sql``}
      ${params.shopifySubscriptionId !== undefined ? sql`shopify_subscription_id = ${params.shopifySubscriptionId},` : sql``}
      ${params.trialEndsAt !== undefined ? sql`trial_ends_at = ${params.trialEndsAt},` : sql``}
      plan_updated_at = NOW(),
      updated_at = NOW()
    WHERE id = ${tenantId}
  `;
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

/**
 * Check whether a specific usage counter is within the plan limit.
 * Returns { allowed, current, limit } — caller decides what to do on rejection.
 * Usable from any service that imports @new-one-two/db.
 */
export async function checkUsageQuota(
  tenantId: string,
  counter: "app_executions" | "emails_sent" | "sms_sent",
  planLimit: number
): Promise<{ allowed: boolean; current: number; limit: number }> {
  const usage = await getOrCreateUsageRecord(tenantId);
  // Map DB snake_case column names to camelCase UsageRecord keys
  const keyMap: Record<string, keyof typeof usage> = {
    app_executions: "appExecutions",
    emails_sent: "emailsSent",
    sms_sent: "smsSent",
  };
  const current = (usage[keyMap[counter]!] as number) ?? 0;
  return { allowed: current < planLimit, current, limit: planLimit };
}
