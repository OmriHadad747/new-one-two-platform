/**
 * Zod schemas mirroring the JSON Schema definitions in /contract/*.schema.json.
 *
 * Both sides of the Pub/Sub channel validate against these shapes:
 * - Node.js platform (publisher + subscriber): this file
 * - Python generator: contract/validators.py (Pydantic models)
 *
 * When the contract changes, update BOTH files.
 */
import { z } from "zod";

// ─── GenerationRequest ────────────────────────────────────────────────────────

export const GenerationRequestSchema = z.object({
  jobId: z.string().uuid(),
  tenantId: z.string().uuid(),
  appId: z.string().uuid(),
  prompt: z.string().min(1),
  appArchetype: z.enum(["storefront_ui", "backend_only"]).default("backend_only"),
  existingFeatures: z.array(z.string()).default([]),
  priorBundle: z.record(z.unknown()).nullable().optional(),
  preComputedIntent: z.record(z.unknown()).nullable().optional(),
});

// ─── ProgressEvent ────────────────────────────────────────────────────────────

export const ProgressEventSchema = z.object({
  jobId: z.string().uuid(),
  agent: z.enum([
    "intent",
    "schema",
    "architect",
    "codespec",
    "planner",
    "codegen",
    "widget_config",
    "handler",
    "migration",
    "validation",
    "explanation",
  ]),
  status: z.enum(["running", "completed", "failed", "retrying"]),
  message: z.string(),
  timestampMs: z.number().int(),
  attempt: z.number().int().min(1).optional(),
});

// ─── FeatureBundleMessage ─────────────────────────────────────────────────────

export const HandlerModuleSchema = z.object({
  code: z.string(),
  webhookTopics: z.array(z.string()),
  cronSchedule: z.string().nullable(),
});

export const DbMigrationSchema = z.object({
  sql: z.string(),
});

export const TechnicalExplanationSchema = z.object({
  webhookTopics: z.array(z.string()),
  dbTables: z.array(z.string()),
  estimatedMonthlyExecutions: z.number().int().min(0),
  estimatedMonthlyCost: z.string(),
});

export const ExplanationSchema = z.object({
  merchantFacing: z.string(),
  technical: TechnicalExplanationSchema,
});

export const BundleSchema = z.object({
  widgetModule: z.string().nullable(), // raw JS ES module source; null for backend_only apps
  handlerModule: HandlerModuleSchema,
  dbMigration: DbMigrationSchema,
  explanation: ExplanationSchema,
});

export const AgentTraceEntrySchema = z.object({
  agent: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  latencyMs: z.number().int(),
});

export const MetaSchema = z.object({
  totalInputTokens: z.number().int().min(0),
  totalOutputTokens: z.number().int().min(0),
  generationMs: z.number().int().min(0),
  agentTrace: z.array(AgentTraceEntrySchema),
});

export const FeatureBundleMessageSchema = z.object({
  jobId: z.string().uuid(),
  status: z.enum(["success", "failed"]),
  error: z.string().optional(),
  bundle: BundleSchema.optional(),
  meta: MetaSchema.optional(),
});

// ─── Inferred types ───────────────────────────────────────────────────────────

export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;
export type HandlerModule = z.infer<typeof HandlerModuleSchema>;
export type DbMigration = z.infer<typeof DbMigrationSchema>;
export type TechnicalExplanation = z.infer<typeof TechnicalExplanationSchema>;
export type Explanation = z.infer<typeof ExplanationSchema>;
export type Bundle = z.infer<typeof BundleSchema>;
export type AgentTraceEntry = z.infer<typeof AgentTraceEntrySchema>;
export type Meta = z.infer<typeof MetaSchema>;
export type FeatureBundleMessage = z.infer<typeof FeatureBundleMessageSchema>;
