// Mirrors the subset of @new-one-two/types needed by the dashboard.
// Keep in sync with platform/packages/types/src/index.ts manually or via codegen.

export type TenantStatus = "active" | "suspended" | "pending";
export type AppStatus = "draft" | "ready" | "active" | "inactive" | "deleted";
export type AppArchetype = "storefront_backend" | "storefront_backend_admin" | "backend" | "backend_admin";

export type BillingPlan = "free" | "starter" | "growth" | "pro";
export type BillingInterval = "monthly" | "annual";
export type SubscriptionStatus = "none" | "pending" | "active" | "frozen" | "cancelled";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  plan: string;
  billingPlan: BillingPlan;
  billingInterval: BillingInterval;
  subscriptionStatus: SubscriptionStatus;
  shopDomain: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface App {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  status: AppStatus;
  appArchetype: AppArchetype;
  widgetJs: string | null;
  shopDomain: string;
  themeInjectionStatus: "none" | "injected";
  themeInjectionThemeId: string | null;
  currentSemver: string | null;
  activeAppVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Theme Injection ──────────────────────────────────────────────────────────

export interface TemplateSection {
  sectionId: string;
  sectionType: string;
  /** Human-readable name from section Liquid schema */
  sectionName?: string;
  blockOrder: string[];
  /** Display name for each block in blockOrder, keyed by block ID */
  blockNames: Record<string, string>;
  hasOurBlock: boolean;
}

export interface ThemeTemplate {
  name: string;
  key: string;
  sections: TemplateSection[];
}

export interface ActiveTheme {
  id: number;
  name: string;
}

export interface ThemeTemplatesResponse {
  activeTheme: ActiveTheme;
  templates: ThemeTemplate[];
}

export interface InjectionTarget {
  templateKey: string;
  sectionId: string;
  /** Index in block_order where the widget is inserted. 0 = before first block, length = after last. */
  position: number;
}

export interface InjectThemeResponse {
  themeId: number;
  themeName: string;
  previewUrl: string;
  editorUrl: string;
}

// ─── Execution Logs ───────────────────────────────────────────────────────────

export interface WebhookInvocationLogEntry {
  id: string;
  appId: string;
  appName: string;
  topic: string;
  status: "queued" | "running" | "success" | "failed" | "timeout";
  durationMs: number | null;
  errorMessage: string | null;
  queuedAt: string;
}

export interface InvocationLogEntry {
  id: string;
  path: string;
  status: "running" | "success" | "failed";
  durationMs: number | null;
  errorMessage: string | null;
  invokedAt: string;
}

// ─── Billing Usage ───────────────────────────────────────────────────────────

export interface PlanLimits {
  maxApps: number;
  maxGenerationsPerMonth: number;
  maxAppExecutionsPerMonth: number;
  maxEmailsPerMonth: number;
  maxSmsPerMonth: number;
  trialDays: number;
}

export interface UsagePeriod {
  generations: number;
  revisions: number;
  appExecutions: number;
  emailsSent: number;
  smsSent: number;
}

export interface BillingUsageResponse {
  plan: BillingPlan;
  interval: BillingInterval;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: string | null;
  usage: UsagePeriod;
  limits: PlanLimits;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface TenantStats {
  totalApps: number;
  liveApps: number;
  apiCallsThisMonth: number;
  avgResponseMs: number;
}

// ─── Generation ──────────────────────────────────────────────────────────────

export interface StartGenerationRequest {
  appId: string;
  tenantId: string;
  prompt: string;
  preComputedIntent?: Record<string, unknown>;
}

// ─── Product Agent Analyze ────────────────────────────────────────────────────

export interface AnalyzeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AnalyzeResult {
  status: "needs_clarification" | "ready";
  question?: string;
  suggestions?: string[];
  summary?: string;
  intent?: Record<string, unknown>;
}

export interface StartGenerationResponse {
  jobId: string;
  sessionId: string;
}

export type GenerationProgressStatus = "running" | "completed" | "failed" | "retrying";

export type GenerationAgent =
  | "product"
  | "architect"
  | "handler"
  | "migration"
  | "widget_js"
  | "admin_ui"
  | "validation"
  | "validator"
  | "revision"
  | "explanation";

export interface ProgressEvent {
  type: "progress";
  agent: GenerationAgent;
  status: GenerationProgressStatus;
  message: string;
  timestampMs: number;
}

export interface CompletedEvent {
  type: "completed";
  status: "success" | "failed";
  error?: string;
  /** "platform_limitation" — the app concept requires a capability ctx can't deliver.
   *  Show a clear explanation; do not suggest retrying. */
  errorCode?: "platform_limitation";
  meta?: {
    totalInputTokens: number;
    totalOutputTokens: number;
    generationMs: number;
  };
}

export type GenerationSSEEvent = ProgressEvent | CompletedEvent;

export interface GenerationState {
  jobId: string | null;
  status: "idle" | "running" | "completed" | "failed";
  events: ProgressEvent[];
  completedEvent: CompletedEvent | null;
  error: string | null;
}

// ─── Generation Result Bundle ─────────────────────────────────────────────────

/**
 * Partial shape of what the generator puts in bundle.
 * Only the fields the frontend needs — the full bundle lives server-side.
 */
export interface GenerationBundle {
  /** AI-generated, step-by-step testing instructions for this specific app. */
  explanation?: string;
  /** Webhook topics this app subscribes to — e.g. ["orders/create"]. */
  triggerTopics?: string[];
  /** How the handler is invoked: webhook driven, cron, admin UI, or widget call. */
  triggerType?: "webhook" | "cron" | "admin" | "widget";
  /** True when a storefront widget module was generated. */
  hasWidget?: boolean;
  /** True when an Admin UI (Polaris) component was generated. */
  hasAdminUI?: boolean;
}

export interface GenerationResult {
  status: "running" | "completed" | "failed" | "success";
  bundle?: SessionBundle;
  error?: string;
}

// ─── Latest Session Result (full session object from /generation/app/:appId/latest) ───

/** Full FeatureBundle shape as returned by the generation API. */
export interface SessionBundle {
  handlerModule?: { code?: string; webhookTopics?: string[]; cronSchedule?: string | null };
  dbMigration?: { sql?: string };
  widgetModule?: string | null;
  adminUiModule?: string | null;
  /** Theme template pages the widget targets, e.g. ["product", "cart"]. null for backend apps. */
  widgetTargetTemplates?: string[] | null;
  explanation?: { merchantFacing?: string; technical?: unknown };
}

/** Summary row returned by GET /generation/app/:appId/sessions */
export interface SessionSummary {
  id: string;
  jobId: string | null;
  status: "running" | "completed" | "failed";
  prompt: string;
  errorMessage: string | null;
  appVersionId: string | null;
  createdAt: string;
}

/** Shape returned by GET /generation/app/:appId/latest */
export interface LatestSessionResult {
  jobId: string | null;
  status: string;
  bundle?: SessionBundle | null;
  error?: string | null;
  errorMessage?: string | null;
  prompt: string;
  webhookTopics: string[];
  cronSchedule: string | null;
  /** Persisted frontend chat history (actions stripped). Null until first save. */
  chatMessages?: Array<Record<string, unknown>> | null;
}
