import { z } from "zod";

// Zod schemas for Pub/Sub FeatureBundleMessage payloads.
//
// Single source of truth for the wire shape is
// platform-ai/contract/validators.py::Bundle. The Pydantic models there
// and these Zod schemas must move in lockstep — both sides of the
// channel revalidate incoming payloads so a schema drift surfaces as a
// nack rather than a silent corruption.
//
// handlerModule.files — [{path, contents}]; generator-authored TypeScript
//   files that drop into the platform-back handler template.
// dbMigration — single {path, contents}; plain feature DDL, no RLS,
//   no tenant_id.
// widgetModule / adminUiModule — ES module strings for storefront widget
//   and admin panel; null for backend-only apps.

// ─── GeneratedFile ──────────────────────────────────────────────────────────

export const GeneratedFileSchema = z.object({
  path: z.string().min(1).max(512),
  // 1 MiB per file matches the platform-back deploy endpoint's cap so a
  // bundle that passes here is deploy-acceptable.
  contents: z.string().max(1024 * 1024),
});

// ─── HandlerModule ──────────────────────────────────────────────────────────

export const HandlerModuleSchema = z.object({
  files: z.array(GeneratedFileSchema).min(1),
  webhookTopics: z.array(z.string()),
  cronSchedule: z.string().nullable().optional(),
});

// ─── Explanation ────────────────────────────────────────────────────────────

export const TechnicalExplanationSchema = z.object({
  webhookTopics: z.array(z.string()),
  dbTables: z.array(z.string()),
  estimatedMonthlyExecutions: z.number().int().min(0),
  estimatedMonthlyCost: z.string(),
});

export const FeatureExplanationSchema = z.object({
  merchantFacing: z.string(),
  technical: TechnicalExplanationSchema,
});

// ─── Email starter ──────────────────────────────────────────────────────────

export const EmailStarterContentSchema = z.object({
  subject: z.string(),
  heading: z.string().nullable().optional(),
  body: z.string(),
  ctaLabel: z.string().nullable().optional(),
  ctaUrl: z.string().nullable().optional(),
});

// ─── Catalog manifest ───────────────────────────────────────────────────────

// Slim {path, method} projection of widgetApiCatalog / adminApiCatalog. The
// served bundle gets `window.__PLATFORM_CATALOG__ = [...]` prepended so the
// SDK (host.call / bridge.call) can dispatch GET-with-querystring vs
// POST-with-body by per-path lookup at call time. requestShape and
// responseShape stay in the architect plan — the runtime doesn't need them.
export const CatalogEntrySchema = z.object({
  path: z.string().min(1).max(512),
  method: z.enum(["GET", "POST"]),
});

// ─── Bundle ─────────────────────────────────────────────────────────────────

export const BundleSchema = z.object({
  widgetModule: z.string().nullable().optional(),
  adminUiModule: z.string().nullable().optional(),
  widgetTargetTemplates: z.array(z.string()).nullable().optional(),
  // Default to [] so older messages (pre-method-aware-SDK) deserialize
  // cleanly; bundle-storage falls back to all-POST when the catalog is
  // empty, matching the prior always-POST SDK behaviour.
  widgetCatalog: z.array(CatalogEntrySchema).default([]),
  adminCatalog: z.array(CatalogEntrySchema).default([]),
  handlerModule: HandlerModuleSchema,
  dbMigration: GeneratedFileSchema,
  explanation: FeatureExplanationSchema,
  usesEmail: z.boolean().default(false),
  emailVariables: z.array(z.string()).default([]),
  emailTypeSuggestion: z.enum(["transactional", "marketing"]).nullable().optional(),
  emailStarterContent: EmailStarterContentSchema.nullable().optional(),
});

// ─── Meta ───────────────────────────────────────────────────────────────────

export const AgentTraceEntrySchema = z.object({
  agent: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  latencyMs: z.number().int(),
});

export const GenerationMetaSchema = z.object({
  totalInputTokens: z.number().int().min(0),
  totalOutputTokens: z.number().int().min(0),
  generationMs: z.number().int().min(0),
  agentTrace: z.array(AgentTraceEntrySchema),
});

// ─── FeatureBundleMessage (top-level envelope) ──────────────────────────────

export const FeatureBundleMessageSchema = z.object({
  jobId: z.string().uuid(),
  // tenantId + appId echo the originating GenerationRequest so the
  // subscriber can write the generations row without a second round-
  // trip to a request-tracking table.
  tenantId: z.string().uuid(),
  appId: z.string().uuid(),
  status: z.enum(["success", "failed"]),
  error: z.string().optional(),
  // Architect's "no viable mitigation" verdict — dashboard surfaces as
  // non-retryable.
  errorCode: z.enum(["platform_limitation"]).optional(),
  bundle: BundleSchema.optional(),
  meta: GenerationMetaSchema.optional(),
});

export type FeatureBundleMessage = z.infer<typeof FeatureBundleMessageSchema>;
export type Bundle = z.infer<typeof BundleSchema>;
export type HandlerModule = z.infer<typeof HandlerModuleSchema>;
export type GeneratedFile = z.infer<typeof GeneratedFileSchema>;
export type GenerationMeta = z.infer<typeof GenerationMetaSchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
