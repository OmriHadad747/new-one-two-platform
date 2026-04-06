import { createRequestLogger } from "@new-one-two/logger";
import type {
  FilesClient,
  HandlerContext,
  HttpClient,
  ServicesClient,
  ShopInfo,
  SmsClient,
} from "@new-one-two/types";
import { buildShopifyAdminClient, buildShopifyStorefrontClient } from "./shopify-client.js";

const SHOPIFY_CLIENT_ID = process.env["SHOPIFY_CLIENT_ID"] ?? null;
const SHOPIFY_CLIENT_SECRET_NAME = process.env["SHOPIFY_CLIENT_SECRET_NAME"] ?? null;
const APP_SHOP_DOMAIN = process.env["SHOP_DOMAIN"] ?? "";

export interface CreateBaseContextOptions {
  tenantId: string;
  tx: unknown;
  loggerTopic: string;
  appId?: string;
  executionLogId?: string;
}

export async function createBaseContext(options: CreateBaseContextOptions): Promise<Omit<HandlerContext, "trigger" | "payload">> {
  const { tenantId, tx, loggerTopic, appId, executionLogId } = options;

  const logger = createRequestLogger({
    tenantId,
    topic: loggerTopic,
    ...(appId !== undefined && { appId }),
    ...(executionLogId !== undefined && { requestId: executionLogId }),
  });

  const shopify_admin = buildShopifyAdminClient(APP_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET_NAME);
  const shopify_storefront = buildShopifyStorefrontClient(APP_SHOP_DOMAIN);

  const shop: ShopInfo = { domain: APP_SHOP_DOMAIN };

  const sms: SmsClient = {
    async send(params) {
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

  const http: HttpClient = {
    async call(url, options) {
      const method = options?.method ?? "GET";
      logger.info({ event: "HTTP_CALL", url, method }, "external http call");
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
        ...(options?.body != null ? { body: JSON.stringify(options.body) } : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
      return res.json();
    },
  };

  const email: ServicesClient["email"] = {
    async send(params) {
      logger.info(
        { event: "EMAIL_SENT", tenantId, ...params },
        "email stub — provider not yet wired"
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
