import { getSecret } from "@new-one-two/crypto";
import { createRequestLogger } from "@new-one-two/logger";
import type {
  CsvClient,
  EmailClient,
  FilesClient,
  HandlerContext,
  HttpClient,
  PdfClient,
  ServicesClient,
  ShopInfo,
  SmsClient,
  StorefrontClient,
} from "@new-one-two/types";
import { buildShopifyClient } from "./shopify-client.js";

const SHOPIFY_CLIENT_ID = process.env["SHOPIFY_CLIENT_ID"] ?? null;
const SHOPIFY_CLIENT_SECRET_NAME = process.env["SHOPIFY_CLIENT_SECRET_NAME"] ?? null;
const APP_SHOP_DOMAIN = process.env["SHOP_DOMAIN"] ?? "";

// Storefront API token — same pattern as SHOPIFY_CLIENT_SECRET_NAME.
// Created at OAuth time, stored in Secret Manager, injected by the deployer.
const STOREFRONT_TOKEN_SECRET_NAME = process.env["STOREFRONT_TOKEN_SECRET_NAME"] ?? "";

// Resolved once per process lifetime — the token is long-lived.
let _storefrontTokenPromise: Promise<string> | null = null;
function resolveStorefrontToken(): Promise<string> {
  if (!_storefrontTokenPromise) {
    if (!STOREFRONT_TOKEN_SECRET_NAME) {
      _storefrontTokenPromise = Promise.reject(
        new Error(
          "Storefront API not available — no storefront token was provisioned during merchant install. " +
          "Re-install the app to provision one."
        )
      );
    } else {
      _storefrontTokenPromise = getSecret(STOREFRONT_TOKEN_SECRET_NAME);
    }
    // Suppress unhandled-rejection until first actual call.
    _storefrontTokenPromise.catch(() => undefined);
  }
  return _storefrontTokenPromise;
}

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

  const shopify = await buildShopifyClient(APP_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET_NAME);

  const shop: ShopInfo = { domain: APP_SHOP_DOMAIN };

  const email: EmailClient = {
    async send(params) {
      logger.info(
        { event: "EMAIL_SENT", tenantId, ...params },
        "email stub — provider not yet wired (see TD-007)"
      );
    },
  };

  const sms: SmsClient = {
    async send(params) {
      logger.info(
        { event: "SMS_SENT", tenantId, ...params },
        "sms stub — provider not yet wired"
      );
    },
  };

  const pdf: PdfClient = {
    async generate(_html) {
      logger.info(
        { event: "PDF_GENERATED", tenantId },
        "pdf stub — PDFKit not yet wired"
      );
      return Buffer.alloc(0);
    },
  };

  const csv: CsvClient = {
    generate(rows, headers) {
      if (rows.length === 0) return "";
      const cols = headers ?? Object.keys(rows[0] ?? {});
      const escape = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      };
      const lines = [cols.join(",")];
      for (const row of rows) {
        lines.push(cols.map((c) => escape(row[c])).join(","));
      }
      return lines.join("\n");
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

  const storefront: StorefrontClient = {
    async graphql(query, variables) {
      const token = await resolveStorefrontToken();
      const res = await fetch(
        `https://${APP_SHOP_DOMAIN}/api/2026-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Storefront-Access-Token": token,
          },
          body: JSON.stringify({ query, variables }),
        }
      );
      const json = (await res.json()) as { data?: unknown; errors?: unknown[] };
      if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
      return json.data;
    },
  };

  const services: ServicesClient = { email, sms, pdf, csv, files };

  return {
    shopify,
    db: tx,
    logger,
    tenantId,
    shop,
    email,
    services,
    http,
    storefront,
  };
}
