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

  /**
   * REST list-endpoint pagination. Yields one page (array of resources) at a
   * time; handles Link-header cursor pagination internally. Accepts the same
   * path + filter params as get(); `limit` defaults to 250. Filter params are
   * only applied to the first request — subsequent requests use only the
   * cursor, as Shopify requires.
   *
   *   for await (const batch of ctx.shopify.paginate('/orders.json', { status: 'any' })) { ... }
   */
  paginate(
    path: string,
    params?: Record<string, string | number | boolean>,
  ): AsyncGenerator<unknown[], void, unknown>;

  /**
   * GraphQL Relay-connection pagination. Yields `edges.map(e => e.node)` at
   * the given connectionPath per page; handles pageInfo.hasNextPage / endCursor
   * internally. The query MUST declare `$cursor: String` and use
   * `after: $cursor` on the target connection, and the connection MUST include
   * `pageInfo { hasNextPage endCursor }` and `edges { node { ... } }`.
   *
   *   for await (const nodes of ctx.shopify.paginateGql(query, vars, 'products')) { ... }
   */
  paginateGql(
    query: string,
    variables: Record<string, unknown>,
    connectionPath: string,
  ): AsyncGenerator<unknown[], void, unknown>;
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

/**
 * Parameters handlers pass to `ctx.email.send()`.
 *
 * Minimal by design — the handler only provides what only the handler can know
 * at runtime: who to email (`to`) and the dynamic template variables (`data`).
 * Everything else — subject, body template, brand, layout, from address,
 * delivery provider, rendering — is owned by the platform and sourced from the
 * merchant-configured `app_email_configs` and `tenant_brands` tables at send time.
 *
 * The merchant edits the template (subject, heading, body, CTA) in the Ton
 * dashboard's Email tab. Any `{{variable}}` placeholders the merchant puts in
 * those fields are resolved against `data` at send time.
 */
export interface EmailSendParams {
  /** Recipient email address. */
  to: string;
  /** Values bound to {{variable}} placeholders in the merchant-configured template. */
  data?: Record<string, unknown>;
}

/**
 * Provider-agnostic email client. The platform implementation resolves the
 * merchant's configured template, applies the tenant brand, renders MJML to
 * cross-client HTML, and submits via Resend.
 */
export interface EmailClient {
  send(params: EmailSendParams): Promise<void>;
}

// ─── Email configuration entities (platform-owned, not handler-visible) ──────
// These types describe the email config stored by the platform. Handlers never
// see them directly — they only call `ctx.email.send({ to, data })`.

export type EmailType = "transactional" | "marketing";

/**
 * Merchant-configurable email template for a single app.
 * Auto-created on deploy with AI-generated starter content; merchant edits in
 * the dashboard Email tab. Deploy is blocked until `configuredByMerchant=true`.
 */
export interface AppEmailConfig {
  appId: string;
  tenantId: string;
  subjectTemplate: string;
  headingTemplate: string | null;
  bodyTemplate: string;
  ctaLabel: string | null;
  ctaUrlTemplate: string | null;
  emailType: EmailType;
  configuredByMerchant: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Tenant-level brand shared across all email-using apps of a single merchant. */
export interface TenantBrand {
  tenantId: string;
  logoUrl: string | null;
  primaryColor: string | null;
  footerText: string | null;
  supportEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type EmailDeliveryStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed";

export interface EmailDelivery {
  id: string;
  tenantId: string;
  appId: string;
  recipient: string;
  subject: string;
  provider: string;
  providerMsgId: string | null;
  status: EmailDeliveryStatus;
  failureReason: string | null;
  isTest: boolean;
  sentAt: Date;
  deliveredAt: Date | null;
  bouncedAt: Date | null;
}

export type EmailSuppressionReason =
  | "unsubscribed"
  | "bounced"
  | "complained"
  | "manual";

export interface EmailSuppression {
  tenantId: string;
  email: string;
  reason: EmailSuppressionReason;
  sourceDeliveryId: string | null;
  createdAt: Date;
}

/** Aggregate counts returned by the email stats endpoint. */
export interface EmailStatsSummary {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  suppressed: number;
}

/**
 * AI-generated starter content produced by the handler agent when it detects
 * `ctx.email.send()` usage. Used to pre-fill `app_email_configs` on deploy so
 * merchants see a filled-in Email tab instead of a blank form.
 */
export interface EmailStarterContent {
  subject: string;
  heading: string | null;
  body: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
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
