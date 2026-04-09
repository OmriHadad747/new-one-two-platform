/**
 * Centralized plan definitions — single source of truth for all plan limits.
 *
 * Every enforcement check, API response, and frontend display reads from here.
 * To change a plan limit, edit this file and redeploy — no DB migration needed.
 */
import type { BillingPlan, PlanDefinition, PlanLimits } from "@new-one-two/types";

// ─── Plan Definitions ─────────────────────────────────────────────────────────

export const PLANS: Record<BillingPlan, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    limits: {
      maxApps: 1,
      maxGenerationsPerMonth: 1,
      allowedCategories: ["storefront_backend"],
      maxAppExecutionsPerMonth: 1_000,
      maxEmailsPerMonth: 100,
      maxSmsPerMonth: 0,
      trialDays: 0,
    },
  },
  starter: {
    id: "starter",
    name: "Starter",
    priceMonthly: 1900, // $19.00
    limits: {
      maxApps: 3,
      maxGenerationsPerMonth: 3,
      allowedCategories: ["storefront_backend", "backend"],
      maxAppExecutionsPerMonth: 10_000,
      maxEmailsPerMonth: 1_000,
      maxSmsPerMonth: 0,
      trialDays: 7,
    },
  },
  growth: {
    id: "growth",
    name: "Growth",
    priceMonthly: 4900, // $49.00
    limits: {
      maxApps: 10,
      maxGenerationsPerMonth: 10,
      allowedCategories: [
        "storefront_backend",
        "storefront_backend_admin",
        "backend",
        "backend_admin",
      ],
      maxAppExecutionsPerMonth: 50_000,
      maxEmailsPerMonth: 5_000,
      maxSmsPerMonth: 100,
      trialDays: 7,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonthly: 9900, // $99.00
    limits: {
      maxApps: 999, // effectively unlimited
      maxGenerationsPerMonth: 999,
      allowedCategories: [
        "storefront_backend",
        "storefront_backend_admin",
        "backend",
        "backend_admin",
      ],
      maxAppExecutionsPerMonth: 200_000,
      maxEmailsPerMonth: 20_000,
      maxSmsPerMonth: 500,
      trialDays: 14,
    },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getPlanLimits(plan: BillingPlan): PlanLimits {
  return PLANS[plan].limits;
}

export function getPlanDefinition(plan: BillingPlan): PlanDefinition {
  return PLANS[plan];
}

export function getAllPlans(): PlanDefinition[] {
  return Object.values(PLANS);
}

/** Returns true if the given plan allows the specified app archetype. */
export function isPlanAllowedCategory(
  plan: BillingPlan,
  archetype: string
): boolean {
  return PLANS[plan].limits.allowedCategories.includes(archetype);
}
