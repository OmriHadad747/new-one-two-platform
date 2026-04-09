// ─── Billing & Plan Types ─────────────────────────────────────────────────────
// Shared between: db, api, platform-front
//
// Shopify Billing API is the sole payment provider (custom distribution, 0% rev share).
// Plans gate: app count, generation count, app categories, service quotas.

export type BillingPlan = "free" | "starter" | "growth" | "pro";

export type SubscriptionStatus =
  | "none"        // no active subscription (free plan)
  | "pending"     // Shopify confirmation page shown, awaiting merchant approval
  | "active"      // approved and billing
  | "frozen"      // Shopify froze (payment failure)
  | "cancelled";  // merchant cancelled or uninstalled

export type RevisionClassification = "bug_report" | "feature_modification" | "new_capability";

// ─── Plan Definition ──────────────────────────────────────────────────────────

export interface PlanLimits {
  maxApps: number;                   // max active apps (Infinity for unlimited)
  maxGenerationsPerMonth: number;    // new app generations per billing period
  allowedCategories: string[];       // AppArchetype values this plan can use
  maxAppExecutionsPerMonth: number;  // handler invocations (webhook + cron + widget + admin)
  maxEmailsPerMonth: number;
  maxSmsPerMonth: number;
  trialDays: number;                 // 0 = no trial
}

export interface PlanDefinition {
  id: BillingPlan;
  name: string;                      // display name
  priceMonthly: number;              // USD cents (0 for free)
  limits: PlanLimits;
}

// ─── Usage ────────────────────────────────────────────────────────────────────

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

export interface UsageSummary {
  current: UsageRecord;
  limits: PlanLimits;
  plan: BillingPlan;
}

// ─── Revision Classification ──────────────────────────────────────────────────

export interface RevisionClassificationRecord {
  id: string;
  tenantId: string;
  appId: string;
  sessionId: string | null;
  jobId: string | null;
  classification: RevisionClassification;
  confidence: string;
  merchantPrompt: string;
  createdAt: Date;
}

// ─── Billing Events (audit) ──────────────────────────────────────────────────

export interface BillingEvent {
  id: string;
  tenantId: string;
  eventType: string;
  fromPlan: BillingPlan | null;
  toPlan: BillingPlan | null;
  shopifySubscriptionId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

// ─── API DTOs ─────────────────────────────────────────────────────────────────

/** POST /billing/subscribe request body. */
export interface SubscribeRequest {
  tenantId: string;
  plan: BillingPlan;
}

/** Response from POST /billing/subscribe — redirect merchant to Shopify confirmation. */
export interface SubscribeResponse {
  confirmationUrl: string;
}

/** GET /billing/usage response. */
export interface BillingUsageResponse {
  plan: BillingPlan;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: string | null;
  usage: UsageRecord;
  limits: PlanLimits;
}

/** GET /billing/plans response. */
export interface BillingPlansResponse {
  plans: PlanDefinition[];
  currentPlan: BillingPlan;
}
