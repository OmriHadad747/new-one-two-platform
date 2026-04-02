// Mirrors the subset of @new-one-two/types needed by the dashboard.
// Keep in sync with platform/packages/types/src/index.ts manually or via codegen.

export type TenantStatus = "active" | "suspended" | "pending";
export type AppStatus = "active" | "inactive" | "deleted";
export type VersionStatus = "draft" | "building" | "ready" | "failed" | "archived";
export type AppArchetype = "storefront_ui" | "backend_only";

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

// ─── Generation ──────────────────────────────────────────────────────────────

export interface StartGenerationRequest {
  appId: string;
  tenantId: string;
  prompt: string;
}

export interface StartGenerationResponse {
  jobId: string;
  sessionId: string;
}

export type GenerationProgressStatus = "running" | "completed" | "failed" | "retrying";

export type GenerationAgent =
  | "intent"
  | "schema"
  | "codegen"
  | "widget_config"
  | "handler"
  | "migration"
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

// ─── Dashboard UI ─────────────────────────────────────────────────────────────

export interface DashboardStats {
  totalApps: number;
  liveApps: number;
  apiCallsThisMonth: number;
  avgResponseMs: number;
}

export interface ActivityItem {
  id: string;
  icon: string;
  text: string;
  time: string;
  tag: string;
  tagVariant: "purple" | "teal";
}
