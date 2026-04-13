/**
 * Plan enforcement — checks plan limits before allowing billable actions.
 *
 * Enforcement points:
 *   - canCreateApp()         → wired in POST /tenants/:id/apps
 *   - canStartGeneration()   → wired in POST /generation
 *   - isCategoryAllowed()    → wired in POST /generation (when preComputedIntent has appCategory)
 *
 * Wired in other services (use shared checkUsageQuota from @new-one-two/db):
 *   - App executions   → webhook-gateway/routes/webhook.ts (before enqueue)
 *   - Email sends      → harness/context-factory.ts (before ctx.services.email.send())
 *   - SMS sends        → harness/context-factory.ts (before ctx.services.sms.send())
 *
 * NOT enforced (unlimited):
 *   - Revisions
 */
import type { Tenant } from "@new-one-two/types";
import type { BillingPlan } from "@new-one-two/types";
import { getPlanLimits } from "./plans.js";
import {
  getOrCreateUsageRecord,
  getActiveAppCount,
} from "@new-one-two/db";

// ─── Enforcement Results ──────────────────────────────────────────────────────

export interface EnforcementResult {
  allowed: boolean;
  reason?: string;      // human-readable explanation for the merchant
  upgradeHint?: string; // which plan would unlock this
}

// ─── Check: Can Activate App ─────────────────────────────────────────────────
//
// Called when setting an app to status="active". Creation is always free —
// merchants can have unlimited drafts/inactive apps and swap which ones are live.

export async function canActivateApp(tenant: Tenant): Promise<EnforcementResult> {
  const limits = getPlanLimits(tenant.billingPlan);
  const activeApps = await getActiveAppCount(tenant.id);

  if (activeApps >= limits.maxApps) {
    return denied(
      `Your ${tenant.billingPlan} plan allows up to ${limits.maxApps} active apps. You currently have ${activeApps} active. Deactivate one to swap it out, or upgrade for more.`,
      tenant.billingPlan
    );
  }

  return { allowed: true };
}

// ─── Check: Can Start Generation ──────────────────────────────────────────────

export async function canStartGeneration(tenant: Tenant): Promise<EnforcementResult> {
  const limits = getPlanLimits(tenant.billingPlan);
  const usage = await getOrCreateUsageRecord(tenant.id);

  if (usage.generations >= limits.maxGenerationsPerMonth) {
    return denied(
      `Your ${tenant.billingPlan} plan allows ${limits.maxGenerationsPerMonth} new app generations per month. You've used ${usage.generations}.`,
      tenant.billingPlan
    );
  }

  return { allowed: true };
}

// ─── Check: Is Category Allowed ───────────────────────────────────────────────

export function isCategoryAllowed(
  plan: BillingPlan,
  archetype: string
): EnforcementResult {
  const limits = getPlanLimits(plan);

  if (!limits.allowedCategories.includes(archetype)) {
    return denied(`Your ${plan} plan doesn't support ${formatArchetype(archetype)} apps.`, plan);
  }

  return { allowed: true };
}

// ─── Check: App Execution Quota ───────────────────────────────────────────────

export async function canExecuteApp(tenantId: string, plan: BillingPlan): Promise<EnforcementResult> {
  const limits = getPlanLimits(plan);
  const usage = await getOrCreateUsageRecord(tenantId);

  if (usage.appExecutions >= limits.maxAppExecutionsPerMonth) {
    return denied(
      `Your ${plan} plan allows ${limits.maxAppExecutionsPerMonth.toLocaleString()} app executions per month. Limit reached.`,
      plan
    );
  }

  return { allowed: true };
}

// ─── Check: Email Quota ───────────────────────────────────────────────────────

export async function canSendEmail(tenantId: string, plan: BillingPlan): Promise<EnforcementResult> {
  const limits = getPlanLimits(plan);
  const usage = await getOrCreateUsageRecord(tenantId);

  if (usage.emailsSent >= limits.maxEmailsPerMonth) {
    return denied(`Monthly email limit (${limits.maxEmailsPerMonth.toLocaleString()}) reached.`, plan);
  }

  return { allowed: true };
}

// ─── Check: SMS Quota ─────────────────────────────────────────────────────────

export async function canSendSms(tenantId: string, plan: BillingPlan): Promise<EnforcementResult> {
  const limits = getPlanLimits(plan);

  if (limits.maxSmsPerMonth === 0) {
    return denied(`SMS is not available on the ${plan} plan.`, plan);
  }

  const usage = await getOrCreateUsageRecord(tenantId);
  if (usage.smsSent >= limits.maxSmsPerMonth) {
    return denied(`Monthly SMS limit (${limits.maxSmsPerMonth}) reached.`, plan);
  }

  return { allowed: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function denied(reason: string, plan: BillingPlan): EnforcementResult {
  const next = ({ free: "starter", starter: "growth", growth: "pro", pro: null, internal: null } as const)[plan];
  return next !== null
    ? { allowed: false, reason, upgradeHint: `Upgrade to the ${next} plan for higher limits.` }
    : { allowed: false, reason };
}

function formatArchetype(archetype: string): string {
  const labels: Record<string, string> = {
    storefront_backend: "Storefront + Backend",
    storefront_backend_admin: "Storefront + Backend + Admin",
    backend: "Backend Only",
    backend_admin: "Backend + Admin",
  };
  return labels[archetype] ?? archetype;
}
