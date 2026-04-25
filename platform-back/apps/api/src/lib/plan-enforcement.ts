/**
 * Plan enforcement — checks plan limits before allowing billable actions.
 *
 * Enforcement points:
 *   - canActivateApp     → PATCH /tenants/:id/apps/:appId  (status=active)
 *                          Enforces the active-app seat cap. Draft / ready
 *                          apps don't consume a seat — merchants can line
 *                          up apps and only pay for the one they flip live.
 *   - canStartGeneration → POST /generation   (generations-per-month cap)
 *   - isCategoryAllowed  → POST /generation   (plan-gated app categories,
 *                                              when preComputedIntent
 *                                              declares appCategory)
 *
 * Wired elsewhere via shared checkUsageQuota/getPlanLimits:
 *   - app executions  → webhook-gateway (before BullMQ enqueue)
 *   - email sends     → /services/email/send
 *   - file storage    → /services/files/upload (cumulative, not per-month)
 *
 * Explicitly NOT enforced:
 *   - App creation — unlimited; merchants can draft freely.
 *   - Revisions    — unlimited by product design (see BILLING.md).
 */
import type { BillingPlan } from "@platform-back/types";
import { getPlanLimits } from "@platform-back/types";
import type { TenantRecord } from "@platform-back/db";
import { getActiveAppCount, getOrCreateUsageRecord } from "@platform-back/db";

export interface EnforcementResult {
  allowed: boolean;
  /** Human-readable, merchant-facing. */
  reason?: string;
  /** Name of the plan that would unlock this action, when one exists. */
  upgradeHint?: string;
}

// ─── App seats ───────────────────────────────────────────────────────────────

/**
 * Draft / inactive apps don't consume a seat — this check fires only on
 * the activate transition. Creation itself is unlimited so merchants can
 * prepare apps before flipping one live.
 */
export async function canActivateApp(tenant: TenantRecord): Promise<EnforcementResult> {
  const limits = getPlanLimits(tenant.billingPlan);
  const active = await getActiveAppCount(tenant.id);
  if (active >= limits.maxApps) {
    return denied(
      `Your ${tenant.billingPlan} plan allows up to ${limits.maxApps} active apps. ` +
        `You currently have ${active} active. Deactivate one to swap it out, or upgrade for more.`,
      tenant.billingPlan,
    );
  }
  return { allowed: true };
}

// ─── Generation (per-month) ──────────────────────────────────────────────────

export async function canStartGeneration(tenant: TenantRecord): Promise<EnforcementResult> {
  const limits = getPlanLimits(tenant.billingPlan);
  const usage = await getOrCreateUsageRecord(tenant.id);
  if (usage.generations >= limits.maxGenerationsPerMonth) {
    return denied(
      `Your ${tenant.billingPlan} plan allows ${limits.maxGenerationsPerMonth} ` +
        `new app generations per month. You've used ${usage.generations}.`,
      tenant.billingPlan,
    );
  }
  return { allowed: true };
}

// ─── App category gate ───────────────────────────────────────────────────────

export function isCategoryAllowed(plan: BillingPlan, archetype: string): EnforcementResult {
  const limits = getPlanLimits(plan);
  if (!limits.allowedCategories.includes(archetype)) {
    return denied(`Your ${plan} plan doesn't support ${formatArchetype(archetype)} apps.`, plan);
  }
  return { allowed: true };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function denied(reason: string, plan: BillingPlan): EnforcementResult {
  const next = (
    { free: "starter", starter: "growth", growth: "pro", pro: null, internal: null } as const
  )[plan];
  return next !== null
    ? {
        allowed: false,
        reason,
        upgradeHint: `Upgrade to the ${next} plan for higher limits.`,
      }
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
