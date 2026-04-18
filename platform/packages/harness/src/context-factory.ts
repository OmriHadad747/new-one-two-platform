import { createRequestLogger } from "@new-one-two/logger";
import type {
  FilesClient,
  HandlerContext,
  HttpClient,
  ServicesClient,
  ShopInfo,
  SmsClient,
  BillingPlan,
} from "@new-one-two/types";
import { getPlanLimits } from "@new-one-two/types";
import { checkUsageQuota, incrementUsage } from "@new-one-two/db";
import { buildShopifyAdminClient, buildShopifyStorefrontClient } from "./shopify-client.js";
import { createEmailService } from "./email-service.js";

const SHOPIFY_ACCESS_TOKEN_SECRET_NAME = process.env["SHOPIFY_ACCESS_TOKEN_SECRET_NAME"] ?? null;
const APP_SHOP_DOMAIN = process.env["SHOP_DOMAIN"] ?? "";

export interface CreateBaseContextOptions {
  tenantId: string;
  tx: unknown;
  loggerTopic: string;
  appId?: string;
  executionLogId?: string;
  billingPlan?: BillingPlan;
}

export async function createBaseContext(options: CreateBaseContextOptions): Promise<Omit<HandlerContext, "trigger" | "payload">> {
  const { tenantId, tx, loggerTopic, appId, executionLogId, billingPlan } = options;
  const plan: BillingPlan = billingPlan ?? "free";

  const logger = createRequestLogger({
    tenantId,
    topic: loggerTopic,
    ...(appId !== undefined && { appId }),
    ...(executionLogId !== undefined && { requestId: executionLogId }),
  });

  const shopify_admin = buildShopifyAdminClient(APP_SHOP_DOMAIN, SHOPIFY_ACCESS_TOKEN_SECRET_NAME);
  const shopify_storefront = buildShopifyStorefrontClient(APP_SHOP_DOMAIN);

  const shop: ShopInfo = { domain: APP_SHOP_DOMAIN };

  const sms: SmsClient = {
    async send(params) {
      const smsLimit = getPlanLimits(plan).maxSmsPerMonth;
      if (smsLimit === 0) {
        logger.warn({ tenantId, plan }, "SMS not available on this plan");
        throw new Error("SMS is not available on your current plan.");
      }
      const quota = await checkUsageQuota(tenantId, "sms_sent", smsLimit);
      if (!quota.allowed) {
        logger.warn({ tenantId, current: quota.current, limit: quota.limit }, "SMS quota exceeded");
        throw new Error(`Monthly SMS limit (${quota.limit}) reached.`);
      }
      await incrementUsage(tenantId, "sms_sent");
      logger.info(
        { event: "SMS_SENT", tenantId, ...params },
        "sms stub — provider not yet wired"
      );
    },
  };

  const files: FilesClient = {
    async upload(name, _content, _mimeType) {
      logger.info(
        { event: "FILE_UPLOADED", tenantId, name },
        "files stub — GCS not yet wired"
      );
      return `https://storage.stub/${tenantId}/${name}`;
    },
  };

  // Single fetch helper powering all three consumers. `json` and `text` serialize
  // object bodies as JSON; `buffer` passes Buffer / Uint8Array through raw so
  // handlers can POST binary (image uploads, octet-stream payloads, etc.).
  async function httpFetch(url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } | undefined, responseKind: "json" | "buffer" | "text"): Promise<Response> {
    const method = opts?.method ?? "GET";
    logger.info({ event: "HTTP_CALL", url, method, responseKind }, "external http call");

    const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
    let body: string | Uint8Array | undefined;
    if (opts?.body != null) {
      if (opts.body instanceof Uint8Array) {
        // Buffer and other typed arrays are Uint8Array subclasses — pass raw.
        body = opts.body;
      } else if (typeof opts.body === "string") {
        body = opts.body;
      } else {
        body = JSON.stringify(opts.body);
        if (!("Content-Type" in headers) && !("content-type" in headers)) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    const res = await fetch(url, { method, headers, ...(body != null ? { body } : {}) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
    return res;
  }

  const http: HttpClient = {
    async json(url, opts) {
      const res = await httpFetch(url, opts, "json");
      return res.json();
    },
    async buffer(url, opts) {
      const res = await httpFetch(url, opts, "buffer");
      return Buffer.from(await res.arrayBuffer());
    },
    async text(url, opts) {
      const res = await httpFetch(url, opts, "text");
      return res.text();
    },
  };

  // Real email service — the handler only sees `ctx.email.send({ to, data })`.
  // All template, brand, rendering, and delivery work is owned by the platform
  // inside `createEmailService`. If `appId` is not set (e.g. system-level
  // invocation), `ctx.email.send` becomes a no-op that logs a warning — the
  // service needs per-app context to load the merchant's template.
  //
  // The "storeName" used in the From field is derived from the shop domain —
  // "acme.myshopify.com" becomes "acme". MVP tradeoff: avoids a per-send DB
  // lookup to fetch tenants.name. A future iteration can thread the real
  // tenant name through ctx creation if merchants complain.
  const storeNameFromDomain = APP_SHOP_DOMAIN
    ? APP_SHOP_DOMAIN.replace(/\.myshopify\.com$/i, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "Your Store";

  const email: ServicesClient["email"] = appId
    ? createEmailService({
        tenantId,
        appId,
        storeName: storeNameFromDomain,
        plan,
        logger,
      })
    : {
        async send(params) {
          logger.warn(
            { event: "EMAIL_NO_APP_CONTEXT", tenantId, ...params },
            "ctx.email.send called without appId — cannot load merchant config"
          );
        },
      };

  const services: ServicesClient = { email, sms, files };

  return {
    shopify: shopify_admin,
    db: tx,
    logger,
    tenantId,
    shop,
    services,
    http,
    storefront: shopify_storefront,
  };
}
