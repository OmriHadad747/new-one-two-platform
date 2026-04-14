// ─── Usage Tracking ───────────────────────────────────────────────────────────

import type { UsageRecord, UsagePeriodSummary } from "@new-one-two/types";
import { sql } from "./connection.js";

/**
 * Compute the current billing period start date for a tenant.
 * Aligns with billing_cycle_anchor so resets match Shopify's billing cycle.
 */
async function getBillingPeriodStart(tenantId: string): Promise<string> {
  const rows = await sql<{ billingCycleAnchor: Date }[]>`
    SELECT billing_cycle_anchor FROM tenants WHERE id = ${tenantId}
  `;
  const anchor = rows[0]?.billingCycleAnchor ?? new Date();
  const anchorDay = anchor.getDate();

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), anchorDay);
  if (now < periodStart) {
    periodStart.setMonth(periodStart.getMonth() - 1);
  }
  return periodStart.toISOString().slice(0, 10);
}

/**
 * Get or create the usage record for the current billing period.
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

  await sql`
    INSERT INTO usage_records (tenant_id, period_start, ${sql(column)})
    VALUES (${tenantId}, ${periodStr}, 1)
    ON CONFLICT (tenant_id, period_start)
    DO UPDATE SET ${sql(column)} = usage_records.${sql(column)} + 1,
                  updated_at = NOW()
  `;
}

// ─── Named tracking helpers ───────────────────────────────────────────────────

export const trackGeneration   = (tenantId: string) => incrementUsage(tenantId, "generations");
export const trackRevision     = (tenantId: string) => incrementUsage(tenantId, "revisions");
export const trackAppExecution = (tenantId: string) => incrementUsage(tenantId, "app_executions");
export const trackEmailSent    = (tenantId: string) => incrementUsage(tenantId, "emails_sent");
export const trackSmsSent      = (tenantId: string) => incrementUsage(tenantId, "sms_sent");
export const trackFileUploaded = (tenantId: string) => incrementUsage(tenantId, "files_uploaded");

/**
 * Check whether a specific usage counter is within the plan limit.
 */
export async function checkUsageQuota(
  tenantId: string,
  counter: "app_executions" | "emails_sent" | "sms_sent",
  planLimit: number
): Promise<{ allowed: boolean; current: number; limit: number }> {
  const usage = await getOrCreateUsageRecord(tenantId);
  const keyMap: Record<string, keyof typeof usage> = {
    app_executions: "appExecutions",
    emails_sent: "emailsSent",
    sms_sent: "smsSent",
  };
  const current = (usage[keyMap[counter]!] as number) ?? 0;
  return { allowed: current < planLimit, current, limit: planLimit };
}

/**
 * Get usage history for the last N billing periods, newest-first.
 */
export async function getUsageHistory(
  tenantId: string,
  periodCount: number = 6
): Promise<UsagePeriodSummary[]> {
  const rows = await sql<UsagePeriodSummary[]>`
    SELECT
      period_start   AS "periodStart",
      generations,
      revisions,
      app_executions AS "appExecutions",
      emails_sent    AS "emailsSent",
      sms_sent       AS "smsSent"
    FROM usage_records
    WHERE tenant_id = ${tenantId}
    ORDER BY period_start DESC
    LIMIT ${periodCount}
  `;
  return rows;
}
