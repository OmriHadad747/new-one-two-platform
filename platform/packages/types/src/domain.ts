// ─── Domain Types — mirrors the PostgreSQL schema 1:1 ────────────────────────
// Consumed by: db, deployer, api

export type TenantStatus = "active" | "suspended" | "pending";
export type AppStatus = "active" | "inactive" | "deleted" | "draft";
export type VersionStatus = "draft" | "building" | "ready" | "failed" | "archived";
export type DeployedFunctionRuntime = "nodejs20" | "nodejs18";
export type LogLevel = "info" | "warn" | "error" | "debug";
export type WebhookInvocationStatus = "queued" | "running" | "success" | "failed" | "timeout";

// Unified vocabulary shared between generator (appCategory) and platform (appArchetype).
//   backend                — webhook/cron handler only, no storefront widget
//   storefront_backend     — handler + storefront widget
//   storefront_backend_admin — handler + storefront widget + admin UI panel
//   backend_admin          — handler + admin UI panel (no storefront widget)
export type AppArchetype =
  | "storefront_backend"
  | "storefront_backend_admin"
  | "backend"
  | "backend_admin";

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

export interface App {
  id: string;
  tenantId: string;
  slug: string;                  // unique within tenant
  name: string;
  status: AppStatus;
  appArchetype: AppArchetype;
  widgetJs: string | null;       // storefront widget ES module; null for backend
  adminUiJs: string | null;      // admin UI ES module; null unless storefront_backend_admin
  shopifyClientId: string;
  shopifySecretName: string;     // GCP Secret Manager resource name (HMAC signing secret)
  shopDomain: string;            // mystore.myshopify.com
  createdAt: Date;
  updatedAt: Date;
}

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

export interface WebhookSubscription {
  id: string;
  appId: string;
  tenantId: string;
  deployedFunctionId: string;
  topic: string;
  shopifyWebhookId: string;     // ID from Shopify's API
  callbackUrl: string;          // https://webhooks.platform.com/:tenantId/:appId
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookInvocationLog {
  id: string;
  webhookSubscriptionId: string;
  deployedFunctionId: string;
  appId: string;
  tenantId: string;
  topic: string;
  shopifyWebhookId: string;     // X-Shopify-Webhook-Id header — idempotency key
  status: WebhookInvocationStatus;
  durationMs: number | null;
  requestPayloadHash: string;   // SHA-256 of raw body — for dedup
  responseStatusCode: number | null;
  errorMessage: string | null;
  invocationId: string | null;  // Cloud Run trace/request ID
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}
