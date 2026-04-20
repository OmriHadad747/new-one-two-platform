import type { UsageRecord } from "@platform-back/types";
import { sql } from "./connection.js";

// Counters tracked on usage_records. Scoped to the columns that exist on
// the table — keep in sync if the schema gains/loses columns.
export type UsageCounter =
  | "generations"
  | "revisions"
  | "app_executions"
  | "emails_sent"
  | "sms_sent"
  | "files_uploaded";

/**
 * Compute the current billing-period start date for a tenant. Anchored
 * to billing_cycle_anchor so resets line up with Shopify's billing
 * cycle, not the calendar month.
 */
async function getBillingPeriodStart(tenantId: string): Promise<string> {
  const rows = await sql<Array<{ billingCycleAnchor: Date | null }>>`
    SELECT billing_cycle_anchor AS "billingCycleAnchor"
    FROM tenants
    WHERE id = ${tenantId}
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

export async function getOrCreateUsageRecord(
  tenantId: string,
): Promise<UsageRecord> {
  const periodStr = await getBillingPeriodStart(tenantId);
  const rows = await sql<UsageRecord[]>`
    INSERT INTO usage_records (tenant_id, period_start)
    VALUES (${tenantId}, ${periodStr})
    ON CONFLICT (tenant_id, period_start)
    DO UPDATE SET updated_at = NOW()
    RETURNING
      id,
      tenant_id      AS "tenantId",
      period_start   AS "periodStart",
      generations,
      revisions,
      app_executions AS "appExecutions",
      emails_sent    AS "emailsSent",
      sms_sent       AS "smsSent",
      files_uploaded AS "filesUploaded",
      created_at     AS "createdAt",
      updated_at     AS "updatedAt"
  `;
  return rows[0]!;
}

/**
 * Atomically increment a usage counter for the current billing period.
 * Race-safe via INSERT … ON CONFLICT DO UPDATE.
 */
export async function incrementUsage(
  tenantId: string,
  column: UsageCounter,
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

/**
 * Returns whether a counter is still under its plan-derived limit.
 * Caller resolves the plan limit (via getPlanLimits) and passes it in
 * so this helper stays plan-agnostic.
 */
export async function checkUsageQuota(
  tenantId: string,
  counter: "app_executions" | "emails_sent" | "sms_sent",
  planLimit: number,
): Promise<{ allowed: boolean; current: number; limit: number }> {
  const usage = await getOrCreateUsageRecord(tenantId);
  const keyMap: Record<string, keyof UsageRecord> = {
    app_executions: "appExecutions",
    emails_sent: "emailsSent",
    sms_sent: "smsSent",
  };
  const current = (usage[keyMap[counter]!] as number) ?? 0;
  return { allowed: current < planLimit, current, limit: planLimit };
}
