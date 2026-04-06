// ─── Harness Contract ─────────────────────────────────────────────────────────
// Runtime contract between the harness and generated handlers.
// Consumed by: harness, harness-runtime, worker, webhook-gateway


// ─── ctx.logger ───────────────────────────────────────────────────────────────
// Minimal structured logger (matches pino's API without a hard dep)

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

// ─── ctx.shopify ──────────────────────────────────────────────────────────────

export interface ShopifyAdminClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  delete(path: string): Promise<unknown>;
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
}

export interface ShopifyStorefrontClient {
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
}

// ─── ctx.http ─────────────────────────────────────────────────────────────────

export interface HttpClient {
  call(url: string, options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<unknown>;
}

// ─── ctx.shop ─────────────────────────────────────────────────────────────────

export interface ShopInfo {
  domain: string; // e.g. "example.myshopify.com"
}

// ─── ctx.services ─────────────────────────────────────────────────────────────

export interface EmailSendParams {
  to: string;
  subject: string;
  templateId?: string;
  data?: Record<string, unknown>;
}

// Provider-agnostic email client. Current implementation: log stub (EMAIL_SENT event).
export interface EmailClient {
  send(params: EmailSendParams): Promise<void>;
}

export interface SmsSendParams {
  to: string;   // E.164 phone number, e.g. "+15551234567"
  body: string; // SMS message text
}

export interface SmsClient {
  send(params: SmsSendParams): Promise<void>;
}

export interface FilesClient {
  // Uploads content to object storage. Phase 3: real GCS impl.
  // Returns a signed URL valid for 1 hour.
  upload(name: string, content: Buffer | string, mimeType?: string): Promise<string>;
}

export interface ServicesClient {
  email: EmailClient;
  sms: SmsClient;
  files: FilesClient;
}

// ─── HandlerContext ───────────────────────────────────────────────────────────
// The context injected into every tenant handler call.

export interface HandlerContext {
  shopify: ShopifyAdminClient;
  db: unknown; // postgres.TransactionSql — typed loosely to avoid hard dep on postgres lib
  payload: Record<string, unknown>;
  logger: HandlerLogger;
  tenantId: string; // UUID of the current tenant — use in all INSERT statements
  shop: ShopInfo;
  services: ServicesClient;
  http: HttpClient;
  storefront: ShopifyStorefrontClient;
  trigger: "webhook" | "cron" | "widget" | "admin";
  /** Set when trigger === "widget". Path segment after /widget (e.g. "/signup"). */
  widgetPath?: string;
  /** Set when trigger === "widget". Parsed request body from the storefront. */
  widgetBody?: Record<string, unknown>;
  /** Set when trigger === "widget". Shopify customer ID; null for guests. */
  customerId?: string | null;
  /** Set when trigger === "admin". Path the admin UI called via bridge.call(). */
  adminPath?: string;
  /** Set when trigger === "admin". Parsed request body from bridge.call(). */
  adminBody?: Record<string, unknown>;
}

// The contract every generated app module must export.
export interface AppModule {
  webhookTopics: string[];
  cronSchedule: string | null;
  handler: (ctx: HandlerContext) => Promise<unknown>;
}

// ─── Harness HTTP contract ────────────────────────────────────────────────────

/** What the worker sends to POST /invoke on the harness. */
export interface HarnessInvokeRequest {
  executionLogId: string;
  tenantId: string;
  appId: string;
  topic: string;
  shopifyWebhookId: string;
  rawBodyBase64: string;
  headers: Record<string, string>;
  receivedAt: string;
}

/** What POST /invoke returns to the worker. */
export interface HarnessInvokeResponse {
  status: "success" | "failed" | "timeout";
  durationMs: number;
  shopifyApiCalls: number;
  error?: string;
}

/** What the storefront sends to POST /widget/* on the harness. */
export interface WidgetInvokeRequest {
  shopDomain: string;  // from X-Shop-Domain header
  appId: string;       // from X-App-Id header
  path: string;        // e.g. "/signup" (the part after /widget)
  body: Record<string, unknown>;
}

// ─── Queue / Gateway ──────────────────────────────────────────────────────────

/** Job payload enqueued by the webhook gateway for the worker. */
export interface WebhookJobPayload {
  executionLogId: string;
  tenantId: string;
  appId: string;
  deployedFunctionId: string;
  functionUrl: string;          // Cloud Run service URL
  topic: string;
  shopifyWebhookId: string;
  rawBodyBase64: string;        // base64-encoded raw body
  headers: Record<string, string>;
  receivedAt: string;           // ISO timestamp
}

export interface WebhookRouteParams {
  tenantSlug: string;
  appSlug: string;
}
