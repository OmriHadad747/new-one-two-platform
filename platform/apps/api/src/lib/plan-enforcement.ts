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

// ─── Check: Can Create App ────────────────────────────────────────────────────

export async function canCreateApp(tenant: Tenant): Promise<EnforcementResult> {
  const limits = getPlanLimits(tenant.billingPlan);
  const activeApps = await getActiveAppCount(tenant.id);

  if (activeApps >= limits.maxApps) {
    return {
      allowed: false,
      reason: `Your ${tenant.billingPlan} plan allows up to ${limits.maxApps} apps. You currently have ${activeApps}.`,
      upgradeHint: suggestUpgrade(tenant.billingPlan),
    };
  }

  return { allowed: true };
}

// ─── Check: Can Start Generation ──────────────────────────────────────────────

export async function canStartGeneration(tenant: Tenant): Promise<EnforcementResult> {
  const limits = getPlanLimits(tenant.billingPlan);
  const usage = await getOrCreateUsageRecord(tenant.id);

  if (usage.generations >= limits.maxGenerationsPerMonth) {
    return {
      allowed: false,
      reason: `Your ${tenant.billingPlan} plan allows ${limits.maxGenerationsPerMonth} new app generations per month. You've used ${usage.generations}.`,
      upgradeHint: suggestUpgrade(tenant.billingPlan),
    };
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
    return {
      allowed: false,
      reason: `Your ${plan} plan doesn't support ${formatArchetype(archetype)} apps.`,
      upgradeHint: suggestUpgrade(plan),
    };
  }

  return { allowed: true };
}

// ─── Check: App Execution Quota ───────────────────────────────────────────────

export async function canExecuteApp(tenantId: string, plan: BillingPlan): Promise<EnforcementResult> {
  const limits = getPlanLimits(plan);
  const usage = await getOrCreateUsageRecord(tenantId);

  if (usage.appExecutions >= limits.maxAppExecutionsPerMonth) {
    return {
      allowed: false,
      reason: `Your ${plan} plan allows ${limits.maxAppExecutionsPerMonth.toLocaleString()} app executions per month. Limit reached.`,
      upgradeHint: suggestUpgrade(plan),
    };
  }

  return { allowed: true };
}

// ─── Check: Email Quota ───────────────────────────────────────────────────────

export async function canSendEmail(tenantId: string, plan: BillingPlan): Promise<EnforcementResult> {
  const limits = getPlanLimits(plan);
  const usage = await getOrCreateUsageRecord(tenantId);

  if (usage.emailsSent >= limits.maxEmailsPerMonth) {
    return {
      allowed: false,
      reason: `Monthly email limit (${limits.maxEmailsPerMonth.toLocaleString()}) reached.`,
      upgradeHint: suggestUpgrade(plan),
    };
  }

  return { allowed: true };
}

// ─── Check: SMS Quota ─────────────────────────────────────────────────────────

export async function canSendSms(tenantId: string, plan: BillingPlan): Promise<EnforcementResult> {
  const limits = getPlanLimits(plan);

  if (limits.maxSmsPerMonth === 0) {
    return {
      allowed: false,
      reason: `SMS is not available on the ${plan} plan.`,
      upgradeHint: suggestUpgrade(plan),
    };
  }

  const usage = await getOrCreateUsageRecord(tenantId);
  if (usage.smsSent >= limits.maxSmsPerMonth) {
    return {
      allowed: false,
      reason: `Monthly SMS limit (${limits.maxSmsPerMonth}) reached.`,
      upgradeHint: suggestUpgrade(plan),
    };
  }

  return { allowed: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function suggestUpgrade(currentPlan: BillingPlan): string | undefined {
  const upgradePath: Record<BillingPlan, BillingPlan | null> = {
    free: "starter",
    starter: "growth",
    growth: "pro",
    pro: null,
  };
  const next = upgradePath[currentPlan];
  return next ? `Upgrade to the ${next} plan for higher limits.` : undefined;
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
