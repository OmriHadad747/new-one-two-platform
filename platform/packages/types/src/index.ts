// ─────────────────────────────────────────────────────────────────────────────
// Core Domain Types — mirrors the PostgreSQL schema 1:1
// ─────────────────────────────────────────────────────────────────────────────

export type TenantStatus = "active" | "suspended" | "pending";
export type AppStatus = "active" | "inactive" | "deleted" | "draft";
export type VersionStatus = "draft" | "building" | "ready" | "failed" | "archived";
export type DeployedFunctionRuntime = "nodejs20" | "nodejs18";
export type WebhookTopic =
  | "orders/create"
  | "orders/updated"
  | "orders/cancelled"
  | "orders/paid"
  | "products/create"
  | "products/update"
  | "products/delete"
  | "customers/create"
  | "customers/update"
  | "customers/delete"
  | "inventory_levels/update"
  | "inventory_items/update"
  | "app/uninstalled"
  | (string & {}); // allow unknown future topics

export type LogLevel = "info" | "warn" | "error" | "debug";
export type ExecutionStatus = "queued" | "running" | "success" | "failed" | "timeout";

// ─── App Archetype ────────────────────────────────────────────────────────────
// Unified vocabulary shared between generator (appCategory) and platform (appArchetype).
//   backend                — webhook/cron handler only, no storefront widget
//   storefront_backend     — handler + storefront widget
//   storefront_backend_admin — handler + storefront widget + admin UI panel

export type AppArchetype = "storefront_backend" | "storefront_backend_admin" | "backend";

// ─── Tenant ──────────────────────────────────────────────────────────────────

export interface Tenant {
  id: string;                   // uuid
  slug: string;                 // unique, URL-safe
  name: string;
  status: TenantStatus;
  plan: string;                 // "starter" | "pro" | "enterprise"
  kmsKeyName: string;           // GCP KMS key resource name for this tenant
  shopDomain: string | null;    // mystore.myshopify.com — set on OAuth install
  shopifyAccessTokenSecretName: string | null;    // GCP Secret Manager path for Admin API OAuth token
  storefrontAccessTokenSecretName: string | null; // GCP Secret Manager path for Storefront API token
  createdAt: Date;
  updatedAt: Date;
}

// ─── App ─────────────────────────────────────────────────────────────────────

export interface App {
  id: string;
  tenantId: string;
  slug: string;                          // unique within tenant
  name: string;
  status: AppStatus;
  appArchetype: AppArchetype;
  widgetJs: string | null;              // storefront widget ES module; null for backend
  adminUiJs: string | null;             // admin UI ES module; null unless storefront_backend_admin
  shopifyClientId: string;
  shopifySecretName: string;             // GCP Secret Manager resource name (HMAC signing secret)
  shopifyAccessTokenSecretName: string | null; // GCP Secret Manager resource name (OAuth access token)
  shopDomain: string;                    // mystore.myshopify.com
  createdAt: Date;
  updatedAt: Date;
}

// ─── AppVersion ───────────────────────────────────────────────────────────────

export interface AppVersion {
  id: string;
  appId: string;
  tenantId: string;
  semver: string;                        // "1.0.0"
  status: VersionStatus;
  generatedCode: Record<string, string>; // { "handler.ts": "...", "package.json": "..." }
  buildLogs: string | null;
  gcsBundlePath: string | null;          // gs://bucket/tenants/{tid}/apps/{aid}/v/{vid}.zip
  createdAt: Date;
  updatedAt: Date;
}

// ─── DeployedFunction ─────────────────────────────────────────────────────────

export interface DeployedFunction {
  id: string;
  appVersionId: string;
  appId: string;
  tenantId: string;
  functionUrl: string;          // Cloud Run service URL
  runtime: DeployedFunctionRuntime;
  memoryMb: number;
  timeoutSec: number;
  envVarsEncrypted: string;     // KMS-encrypted JSON blob
  deployedAt: Date;
  isActive: boolean;
}

// ─── WebhookSubscription ──────────────────────────────────────────────────────

export interface WebhookSubscription {
  id: string;
  appId: string;
  tenantId: string;
  deployedFunctionId: string;
  topic: WebhookTopic;
  shopifyWebhookId: string;     // ID from Shopify's API
  callbackUrl: string;          // https://webhooks.platform.com/:tenantId/:appId
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── ExecutionLog ─────────────────────────────────────────────────────────────

export interface ExecutionLog {
  id: string;
  webhookSubscriptionId: string;
  deployedFunctionId: string;
  appId: string;
  tenantId: string;
  topic: WebhookTopic;
  shopifyWebhookId: string;     // X-Shopify-Webhook-Id header — idempotency key
  status: ExecutionStatus;
  durationMs: number | null;
  requestPayloadHash: string;   // SHA-256 of raw body — for dedup
  responseStatusCode: number | null;
  errorMessage: string | null;
  invocationId: string | null;  // Cloud Run trace/request ID
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

// ─── Queue Job Payloads ───────────────────────────────────────────────────────

export interface WebhookJobPayload {
  executionLogId: string;
  tenantId: string;
  appId: string;
  deployedFunctionId: string;
  functionUrl: string;          // Cloud Run service URL
  topic: WebhookTopic;
  shopifyWebhookId: string;
  rawBodyBase64: string;        // base64-encoded raw body
  headers: Record<string, string>;
  receivedAt: string;           // ISO timestamp
}

// ─── Gateway Context (per-request) ───────────────────────────────────────────

export interface WebhookRouteParams {
  tenantSlug: string;
  appSlug: string;
}

export interface ResolvedWebhookContext {
  tenant: Tenant;
  app: App;
  deployedFunction: DeployedFunction;
  subscription: WebhookSubscription;
}

// ─── Harness Contract ─────────────────────────────────────────────────────────

// Minimal structured logger interface (matches pino's API without a hard dep)
export interface HandlerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
}

export interface EmailSendParams {
  to: string;
  subject: string;
  templateId?: string;
  data?: Record<string, unknown>;
}

// Provider-agnostic email client. Current implementation: log stub (EMAIL_SENT event).
// See TD-007 for the real provider integration.
export interface EmailClient {
  send(params: EmailSendParams): Promise<void>;
}

// ─── ctx.http ─────────────────────────────────────────────────────────────────
// Thin authenticated fetch wrapper. All calls are logged with tenant context.
export interface HttpClient {
  call(url: string, options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<unknown>;
}

// ─── ctx.storefront ───────────────────────────────────────────────────────────
// Shopify Storefront API (GraphQL). Uses the Storefront Access Token stored at
// OAuth time — no additional auth needed. Returns unwrapped data{} layer.
export interface StorefrontClient {
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
}

// ─── ctx.shop ─────────────────────────────────────────────────────────────────
export interface ShopInfo {
  domain: string; // e.g. "example.myshopify.com"
}

// ─── ctx.services ─────────────────────────────────────────────────────────────

export interface SmsSendParams {
  to: string;   // E.164 phone number, e.g. "+15551234567"
  body: string; // SMS message text
}

export interface SmsClient {
  send(params: SmsSendParams): Promise<void>;
}

export interface PdfClient {
  /** Renders an HTML string to a PDF buffer. Phase 3: real PDFKit impl. */
  generate(html: string): Promise<Buffer>;
}

export interface CsvClient {
  /** Serialises rows to a CSV string. Pure in-process — always real. */
  generate(rows: Record<string, unknown>[], headers?: string[]): string;
}

export interface FilesClient {
  /**
   * Uploads content to object storage. Phase 3: real GCS impl.
   * Returns a signed URL valid for 1 hour.
   */
  upload(name: string, content: Buffer | string, mimeType?: string): Promise<string>;
}

export interface ServicesClient {
  email: EmailClient;
  sms: SmsClient;
  pdf: PdfClient;
  csv: CsvClient;
  files: FilesClient;
}

// ─── HandlerContext ───────────────────────────────────────────────────────────

// The context injected into every tenant handler call
export interface HandlerContext {
  shopify: {
    get(path: string): Promise<unknown>;
    post(path: string, body: unknown): Promise<unknown>;
    graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
  };
  db: unknown; // postgres.TransactionSql — typed loosely to avoid hard dep on postgres lib
  payload: Record<string, unknown>;
  logger: HandlerLogger;
  tenantId: string; // UUID of the current tenant — use in all INSERT statements
  /** Shopify store information */
  shop: ShopInfo;
  /** Legacy email shortcut — same as ctx.services.email */
  email: EmailClient;
  /** All platform services (email, sms, pdf, csv, files) */
  services: ServicesClient;
  /** External HTTP client — for calling third-party APIs */
  http: HttpClient;
  /** Shopify Storefront API — public GraphQL with Storefront Access Token */
  storefront: StorefrontClient;
  /** How the handler was invoked. Use this instead of inspecting ctx.payload. */
  trigger: "webhook" | "cron" | "widget" | "admin";
  /** Set when trigger === "widget". The path segment after /widget (e.g. "/signup"). */
  widgetPath?: string;
  /** Set when trigger === "widget". Parsed request body from the storefront. */
  widgetBody?: Record<string, unknown>;
  /** Set when trigger === "widget". Shopify customer ID from the storefront session, null for guests. */
  customerId?: string | null;
  /** Set when trigger === "admin". The path the admin UI called via bridge.call() (e.g. "/subscribers"). */
  adminPath?: string;
  /** Set when trigger === "admin". Parsed request body from the admin UI bridge.call(). */
  adminBody?: Record<string, unknown>;
}

// The contract every generated app module must export
export interface AppModule {
  webhookTopics: WebhookTopic[];
  cronSchedule: string | null;
  handler: (ctx: HandlerContext) => Promise<unknown>;
}

// What the worker sends to POST /invoke on the harness
export interface HarnessInvokeRequest {
  executionLogId: string;
  tenantId: string;
  appId: string;
  topic: WebhookTopic;
  shopifyWebhookId: string;
  rawBodyBase64: string;
  headers: Record<string, string>;
  receivedAt: string;
}

// What the storefront sends to POST /widget/* on the deployed function harness
export interface WidgetInvokeRequest {
  shopDomain: string;  // from X-Shop-Domain header
  appId: string;       // from X-App-Id header
  path: string;        // e.g. "/signup" (the part after /widget)
  body: Record<string, unknown>;
}

// What POST /invoke returns to the worker
export interface HarnessInvokeResponse {
  status: "success" | "failed" | "timeout";
  durationMs: number;
  shopifyApiCalls: number;
  error?: string;
}

// ─── Phase 3: AI Generator Types ──────────────────────────────────────────────

export type ShopifyResource = "orders" | "customers" | "inventory" | "products" | "discounts";
export type TriggerType = "webhook" | "cron" | "both";
export type IntentComplexity = "low" | "medium" | "high";

// Agent 1 output
export interface StructuredIntent {
  triggerType: TriggerType;
  resources: ShopifyResource[];
  desiredOutcome: string;
  complexity: IntentComplexity;
  cronSchedule: string | null;
}

// Agent 2 output
export interface ApiOperation {
  step: number;
  description: string;
  type: "query" | "mutation";
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  bodyExample: Record<string, unknown> | null;
}

export interface ApiPlan {
  webhookTopics: WebhookTopic[];
  cronSchedule: string | null;
  operations: ApiOperation[];
}

// Agent 4 output
export interface ValidationResult {
  passed: boolean;
  errors: string[];
}

// SSE events emitted by the generator during chain execution
export type GeneratorEventType = "status" | "complete" | "error";

export interface GeneratorStatusEvent {
  type: "status";
  agent: string;
  message: string;
}

export interface GeneratorCompleteEvent {
  type: "complete";
  sessionId: string;
  appVersionId: string;
  explanation: string;
  code: string;
  webhookTopics: WebhookTopic[];
  cronSchedule: string | null;
  attemptCount: number;
}

export interface GeneratorErrorEvent {
  type: "error";
  sessionId: string | null;
  message: string;
}

export type GeneratorEvent = GeneratorStatusEvent | GeneratorCompleteEvent | GeneratorErrorEvent;

// POST /generate request body
export interface GenerateRequest {
  appId: string;
  tenantId: string;
  prompt: string;
  sessionId?: string; // set when re-running with "Request changes"
}

// POST /generate/:sessionId/approve request triggers deployment
export interface ApproveGenerationRequest {
  appVersionId: string;
}

// ─── Phase 4: Pub/Sub FeatureBundle Types ─────────────────────────────────────
// These mirror the Zod schemas in @new-one-two/pubsub-client/src/schemas.ts
// and the Pydantic models in generator/contract/validators.py.
// Source of truth: /contract/*.schema.json

/** Published to generation.requested by apps/api. */
export interface GenerationRequestMessage {
  jobId: string;
  tenantId: string;
  appId: string;
  prompt: string;
  appArchetype?: AppArchetype;         // default: "backend" (set by Zod/Pydantic)
  existingFeatures?: string[];         // default: [] (set by Zod/Pydantic)
  priorBundle?: Record<string, unknown> | null;
}

/** Published to generation.progress by the Python generator. */
export interface ProgressEventMessage {
  jobId: string;
  agent:
  | "intent"
  | "schema"
  | "codegen"
  | "widget_config"
  | "handler"
  | "migration"
  | "validation"
  | "explanation";
  status: "running" | "completed" | "failed" | "retrying";
  message: string;
  timestampMs: number;
  attempt?: number;
}

/** Generated CommonJS handler module for the harness. */
export interface HandlerModule {
  code: string;
  webhookTopics: string[];
  cronSchedule: string | null;
}

/** Tenant-scoped SQL migration. */
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

/** The complete validated feature bundle produced by the Python generator. */
export interface FeatureBundle {
  widgetModule: string | null;   // storefront widget ES module; null for backend apps
  adminUiModule: string | null;  // admin UI ES module; null unless storefront_backend_admin
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

/** POST /tenants request body. */
export interface CreateTenantRequest {
  /** Supply a fixed UUID for reproducible local dev/testing. Omit to auto-generate. */
  id?: string;
  slug: string;
  name: string;
  plan?: string; // default: "starter"
}

/** POST /tenants/:tenantId/apps request body. */
export interface CreateAppRequest {
  /** Supply a fixed UUID for reproducible local dev/testing. Omit to auto-generate. */
  id?: string;
  slug: string;
  name: string;
}

/** POST /generation request body (apps/api). */
export interface StartGenerationRequest {
  appId: string;
  tenantId: string;
  prompt: string;
}

/** POST /generation/:jobId/revise request body. */
export interface ReviseGenerationRequest {
  feedback: string;
}
