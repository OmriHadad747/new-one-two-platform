// ─── Pub/Sub Message Types ────────────────────────────────────────────────────
// Wire format between apps/api ↔ Python generator ↔ apps/api.
// Mirrors the Zod schemas in @new-one-two/pubsub-client and the Pydantic
// models in generator/contract/validators.py.
// Source of truth: /contract/*.schema.json
// Consumed by: api (generation routes), deployer

import type { AppArchetype } from "./domain.js";

/** Published to generation.requested by apps/api. */
export interface GenerationRequestMessage {
  jobId: string;
  tenantId: string;
  appId: string;
  prompt: string;
  appArchetype?: AppArchetype;         // default: "backend"
  existingFeatures?: string[];         // default: []
  priorBundle?: Record<string, unknown> | null;
}

/** Published to generation.progress by the Python generator. */
export interface ProgressEventMessage {
  jobId: string;
  agent:
    | "product"
    | "architect"
    | "codespec"
    | "handler"
    | "migration"
    | "widget_js"
    | "admin_ui"
    | "validation"
    | "explanation";
  status: "running" | "completed" | "failed" | "retrying";
  message: string;
  timestampMs: number;
  attempt?: number;
}

/** Generated CommonJS handler module produced by the Python generator. */
export interface HandlerModule {
  code: string;
  webhookTopics: string[];
  cronSchedule: string | null;
  npmPackages: string[];
}

/** Tenant-scoped SQL migration produced by the Python generator. */
export interface DbMigration {
  sql: string;
}

export interface TechnicalExplanation {
  webhookTopics: string[];
  dbTables: string[];
  estimatedMonthlyExecutions: number;
  estimatedMonthlyCost: string;
}

export interface FeatureExplanation {
  merchantFacing: string;
  technical: TechnicalExplanation;
}

/** Theme template pages a storefront widget is designed to appear on. */
export type WidgetTargetTemplate =
  | "product"
  | "collection"
  | "index"
  | "cart"
  | "page"
  | "blog"
  | "article"
  | "search";

/** The complete validated feature bundle produced by the Python generator. */
export interface FeatureBundle {
  widgetModule: string | null;   // storefront widget ES module; null for backend apps
  adminUiModule: string | null;  // admin UI ES module; null unless storefront_backend_admin
  /** Theme template pages the widget targets. null for backend apps. */
  widgetTargetTemplates: WidgetTargetTemplate[] | null;
  handlerModule: HandlerModule;
  dbMigration: DbMigration;
  explanation: FeatureExplanation;
}

export interface AgentTraceEntry {
  agent: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface GenerationMeta {
  totalInputTokens: number;
  totalOutputTokens: number;
  generationMs: number;
  agentTrace: AgentTraceEntry[];
}

/** Published to generation.completed by the Python generator. */
export interface FeatureBundleMessage {
  jobId: string;
  status: "success" | "failed";
  error?: string;
  bundle?: FeatureBundle;
  meta?: GenerationMeta;
}
