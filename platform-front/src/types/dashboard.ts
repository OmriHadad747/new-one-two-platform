// Mirrors the subset of @new-one-two/types needed by the dashboard.
// Keep in sync with platform/packages/types/src/index.ts manually or via codegen.

export type TenantStatus = "active" | "suspended" | "pending";
export type AppStatus = "active" | "inactive" | "deleted" | "draft";
export type VersionStatus = "draft" | "building" | "ready" | "failed" | "archived";
export type AppArchetype = "storefront_backend" | "storefront_backend_admin" | "backend" | "backend_admin";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  plan: string;
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
  createdAt: string;
  updatedAt: string;
}

// ─── Dashboard UI helpers ─────────────────────────────────────────────────────

/** Computed from TenantStats — kept for StatsGrid component compatibility. */
export type DashboardStats = TenantStats;

export interface ActivityItem {
  id: string;
  icon: string;
  text: string;
  time: string;
  tag: string;
  tagVariant: "purple" | "teal";
}

// ─── Execution Logs ───────────────────────────────────────────────────────────

export interface ExecutionLogEntry {
  id: string;
  appId: string;
  appName: string;
  topic: string;
  status: "queued" | "running" | "success" | "failed" | "timeout";
  durationMs: number | null;
  errorMessage: string | null;
  queuedAt: string;
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
  | "codespec"
  | "handler"
  | "migration"
  | "widget_js"
  | "admin_ui"
  | "validation"
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
  status: "running" | "completed" | "failed";
  bundle?: GenerationBundle;
  error?: string;
}
