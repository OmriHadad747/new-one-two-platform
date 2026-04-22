// Billing plans. Narrowed copy of platform/packages/types/src/billing.ts —
// only the parts platform-back currently reads (limits enforced at quota
// checks). Full billing system port comes later.

export type BillingPlan = "free" | "starter" | "growth" | "pro" | "internal";
export type BillingInterval = "monthly" | "annual";
export type SubscriptionStatus = "none" | "pending" | "active" | "frozen" | "cancelled";

export interface PlanLimits {
  maxApps: number;
  maxGenerationsPerMonth: number;
  allowedCategories: string[];
  maxAppExecutionsPerMonth: number;
  maxEmailsPerMonth: number;
  maxSmsPerMonth: number;
  // Cumulative hard cap on bytes stored in the files service across all
  // of this tenant's apps. Checked pre-insert by /services/files/upload.
  // Infinity on internal.
  maxStorageBytes: number;
  trialDays: number;
}

export interface PlanDefinition {
  id: BillingPlan;
  name: string;
  priceMonthly: number;
  priceYearly: number;
  limits: PlanLimits;
}

export const PLANS: Record<BillingPlan, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    priceYearly: 0,
    limits: {
      maxApps: 1,
      maxGenerationsPerMonth: 1,
      allowedCategories: ["backend"],
      maxAppExecutionsPerMonth: 1_000,
      maxEmailsPerMonth: 100,
      maxSmsPerMonth: 0,
      maxStorageBytes: 100 * 1024 * 1024, // 100 MiB
      trialDays: 0,
    },
  },
  starter: {
    id: "starter",
    name: "Starter",
    priceMonthly: 2900,
    priceYearly: 29000,
    limits: {
      maxApps: 3,
      maxGenerationsPerMonth: 3,
      allowedCategories: ["storefront_backend", "backend"],
      maxAppExecutionsPerMonth: 10_000,
      maxEmailsPerMonth: 1_000,
      maxSmsPerMonth: 0,
      maxStorageBytes: 1 * 1024 * 1024 * 1024, // 1 GiB
      trialDays: 7,
    },
  },
  growth: {
    id: "growth",
    name: "Growth",
    priceMonthly: 9900,
    priceYearly: 99000,
    limits: {
      maxApps: 10,
      maxGenerationsPerMonth: 10,
      allowedCategories: [
        "storefront_backend",
        "storefront_backend_admin",
        "backend",
        "backend_admin",
      ],
      maxAppExecutionsPerMonth: 100_000,
      maxEmailsPerMonth: 10_000,
      maxSmsPerMonth: 0,
      maxStorageBytes: 10 * 1024 * 1024 * 1024, // 10 GiB
      trialDays: 7,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonthly: 29900,
    priceYearly: 299000,
    limits: {
      maxApps: 50,
      maxGenerationsPerMonth: 50,
      allowedCategories: [
        "storefront_backend",
        "storefront_backend_admin",
        "backend",
        "backend_admin",
      ],
      maxAppExecutionsPerMonth: 1_000_000,
      maxEmailsPerMonth: 100_000,
      maxSmsPerMonth: 0,
      maxStorageBytes: 50 * 1024 * 1024 * 1024, // 50 GiB
      trialDays: 14,
    },
  },
  internal: {
    id: "internal",
    name: "Internal",
    priceMonthly: 0,
    priceYearly: 0,
    limits: {
      maxApps: Number.POSITIVE_INFINITY,
      maxGenerationsPerMonth: Number.POSITIVE_INFINITY,
      allowedCategories: [
        "storefront_backend",
        "storefront_backend_admin",
        "backend",
        "backend_admin",
      ],
      maxAppExecutionsPerMonth: Number.POSITIVE_INFINITY,
      maxEmailsPerMonth: Number.POSITIVE_INFINITY,
      maxSmsPerMonth: Number.POSITIVE_INFINITY,
      maxStorageBytes: Number.POSITIVE_INFINITY,
      trialDays: 0,
    },
  },
};

export function getPlanLimits(plan: BillingPlan): PlanLimits {
  return PLANS[plan].limits;
}

// ─── Usage record (read by quota checks) ─────────────────────────────────────

export interface UsageRecord {
  id: string;
  tenantId: string;
  periodStart: Date;
  generations: number;
  revisions: number;
  appExecutions: number;
  emailsSent: number;
  smsSent: number;
  filesUploaded: number;
  createdAt: Date;
  updatedAt: Date;
}
