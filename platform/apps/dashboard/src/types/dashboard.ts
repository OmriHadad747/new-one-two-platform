// Domain types re-exported from the platform types package.
// Since dashboard is a standalone Vite app (not in the monorepo workspace),
// we duplicate the minimal subset we need here.

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

export interface AppVersion {
  id: string;
  appId: string;
  semver: string;
  status: VersionStatus;
  generatedCode: Record<string, string>;
  buildLogs: string | null;
  createdAt: string;
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

// ─── UI State ────────────────────────────────────────────────────────────────

export interface GenerationState {
  jobId: string | null;
  status: "idle" | "running" | "completed" | "failed";
  events: ProgressEvent[];
  completedEvent: CompletedEvent | null;
  error: string | null;
}

// ─── Stats (computed / mock for now) ─────────────────────────────────────────

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
