/**
 * Shopify OAuth — One Umbrella App install flow.
 *
 *   GET /oauth/install?shop=mystore.myshopify.com
 *     Redirects merchant to Shopify's OAuth authorization page.
 *
 *   GET /oauth/callback?code=...&shop=...&state=...&hmac=...
 *     Validates HMAC + state, exchanges code for access token, persists
 *     tenant + token, issues a platform JWT, redirects to dashboard.
 *
 * Phase-1 port. Deliberately omits (will return when their consumers land):
 *   - Webhook re-registration (webhook archetype, phase 3)
 *   - Per-app provisioning (handler SA, schema, Cloud Run) — that's a
 *     separate generate-time flow, not install-time
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { storeSecret } from "@platform-back/crypto";
import {
  createTenant,
  getTenantByShopDomain,
  updateTenantAccessToken,
} from "@platform-back/db";
import { logger } from "@platform-back/logger";
import { ErrorCode, errorResponse } from "../lib/error-response.js";
import { signJwt } from "../plugins/auth.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const SHOPIFY_CLIENT_ID = process.env["SHOPIFY_CLIENT_ID"] ?? "";
const SHOPIFY_CLIENT_SECRET = process.env["SHOPIFY_CLIENT_SECRET"] ?? "";
const PLATFORM_URL = process.env["PLATFORM_URL"] ?? "http://localhost:3010";
const DASHBOARD_URL = process.env["DASHBOARD_URL"] ?? "http://localhost:3000";
// KMS key used when creating a new tenant. Required in production; if unset,
// createTenant falls back to the dev placeholder key which is only suitable
// for local dev (the key doesn't exist in prod GCP).
const KMS_KEY_NAME = process.env["KMS_KEY_NAME"] ?? "";

if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
  throw new Error(
    "FATAL: SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set",
  );
}

const SCOPES = [
  "read_products",
  "write_products",
  "read_orders",
  "write_orders",
  "read_customers",
  "read_inventory",
  "read_themes",
  "write_themes",
  "unauthenticated_read_product_listings",
  "unauthenticated_read_product_inventory",
  "unauthenticated_read_collection_listings",
  "unauthenticated_read_checkouts",
  "unauthenticated_write_checkouts",
  "unauthenticated_read_customers",
  "unauthenticated_write_customers",
].join(",");

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { shop?: string } }>("/install", installHandler);
  app.get<{
    Querystring: {
      code?: string;
      shop?: string;
      state?: string;
      hmac?: string;
    };
  }>("/callback", callbackHandler);
}

async function installHandler(
  req: FastifyRequest<{ Querystring: { shop?: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const shop = req.query.shop;
  if (!shop || !shop.endsWith(".myshopify.com")) {
    return reply
      .code(400)
      .send(
        errorResponse(
          ErrorCode.InvalidRequest,
          "Missing or invalid shop parameter",
        ),
      );
  }

  // State encodes a nonce + shop and is HMAC-signed with the client
  // secret. No server-side session storage needed.
  const state = buildState(shop);
  const redirectUri = `${PLATFORM_URL}/oauth/callback`;
  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_CLIENT_ID}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  logger.info({ shop }, "Redirecting to Shopify OAuth");
  return reply.redirect(authUrl);
}

async function callbackHandler(
  req: FastifyRequest<{
    Querystring: {
      code?: string;
      shop?: string;
      state?: string;
      hmac?: string;
    };
  }>,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const { code, shop, state, hmac } = req.query;
  if (!code || !shop || !state || !hmac) {
    return reply
      .code(400)
      .send(
        errorResponse(
          ErrorCode.InvalidRequest,
          "Missing required OAuth parameters",
        ),
      );
  }

  // 1. HMAC verify (Shopify-signed query params).
  if (!verifyShopifyHmac(req.query as Record<string, string>, hmac)) {
    return reply
      .code(401)
      .send(errorResponse(ErrorCode.Forbidden, "HMAC validation failed"));
  }

  // 2. State verify (CSRF + shop binding).
  if (!verifyState(state, shop)) {
    return reply
      .code(400)
      .send(errorResponse(ErrorCode.InvalidRequest, "Invalid state parameter"));
  }

  // 3. Exchange the code for an access token.
  let accessToken: string;
  try {
    accessToken = await exchangeCodeForToken(shop, code);
  } catch (err) {
    logger.error({ err, shop }, "Failed to exchange OAuth code");
    return reply
      .code(502)
      .send(
        errorResponse(
          ErrorCode.BadGateway,
          "Failed to obtain access token from Shopify",
        ),
      );
  }

  // 4. Write the platform_app.base_url shop metafield. Non-fatal — handlers
  //    can also be configured with PLATFORM_URL via env at deploy time, so
  //    a transient Shopify failure here just means storefronts won't
  //    auto-discover the URL until reinstall.
  try {
    await writeShopMetafield(
      shop,
      accessToken,
      "platform_app",
      "base_url",
      PLATFORM_URL,
    );
  } catch (err) {
    logger.warn(
      { err, shop },
      "Failed to write platform_app.base_url metafield — continuing",
    );
  }

  // 5. Persist tenant + access tokens.
  let tenantId: string;
  try {
    const secretName = await persistAccessToken(shop, accessToken);

    // Provision Storefront API token. Non-fatal on failure — widgets will
    // error on first call but admin flows are unaffected. Re-install retries.
    let storefrontSecretName: string | undefined;
    try {
      storefrontSecretName = await provisionStorefrontToken(
        shop,
        accessToken,
      );
    } catch (err) {
      logger.warn(
        { err, shop },
        "Failed to provision Storefront API token — continuing without it",
      );
    }

    tenantId = await upsertTenant(shop, secretName, storefrontSecretName);
    logger.info({ shop, tenantId }, "OAuth install complete");
  } catch (err) {
    logger.error({ err, shop }, "Failed to persist tenant after OAuth");
    return reply
      .code(500)
      .send(errorResponse(ErrorCode.Internal, "Internal error during install"));
  }

  // 6. Mint platform JWT and redirect to dashboard with token in querystring.
  const platformToken = signJwt({ tenantId, shopDomain: shop });
  const redirectUrl = new URL(`${DASHBOARD_URL}/merchants/${tenantId}`);
  redirectUrl.searchParams.set("token", platformToken);
  return reply.redirect(redirectUrl.toString());
}

// ─── State (HMAC-signed) ─────────────────────────────────────────────────────

function buildState(shop: string): string {
  const nonce = crypto.randomUUID();
  const payload = Buffer.from(JSON.stringify({ nonce, shop })).toString(
    "base64url",
  );
  const sig = createHmac("sha256", SHOPIFY_CLIENT_SECRET)
    .update(payload)
    .digest("hex");
  return `${payload}.${sig}`;
}

function verifyState(state: string, shop: string): boolean {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return false;

  const expected = createHmac("sha256", SHOPIFY_CLIENT_SECRET)
    .update(payload)
    .digest("hex");
  try {
    if (
      !timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))
    ) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as { shop: string };
    return decoded.shop === shop;
  } catch {
    return false;
  }
}

// ─── Shopify HMAC over query params (callback signature) ─────────────────────

function verifyShopifyHmac(
  params: Record<string, string>,
  hmac: string,
): boolean {
  const message = Object.keys(params)
    .filter((k) => k !== "hmac")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const computed = createHmac("sha256", SHOPIFY_CLIENT_SECRET)
    .update(message)
    .digest("hex");
  try {
    return timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(hmac, "hex"),
    );
  } catch {
    return false;
  }
}

// ─── Shopify Admin API helpers ───────────────────────────────────────────────

async function exchangeCodeForToken(
  shop: string,
  code: string,
): Promise<string> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      code,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify token exchange failed [${res.status}]: ${body}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("No access_token in Shopify response");
  return data.access_token;
}

async function writeShopMetafield(
  shop: string,
  accessToken: string,
  namespace: string,
  key: string,
  value: string,
): Promise<void> {
  const res = await fetch(
    `https://${shop}/admin/api/2026-01/metafields.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        metafield: {
          namespace,
          key,
          value,
          type: "single_line_text_field",
          owner_resource: "shop",
        },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify metafield write failed [${res.status}]: ${body}`);
  }
}

// ─── Tenant + token persistence ──────────────────────────────────────────────

/**
 * Production: writes the access token to GCP Secret Manager and returns
 * the resource name to store on the tenant row.
 *
 * Dev: returns a deterministic placeholder path so callers behave the
 * same way; the operator must add the token value to SM_DEV_SECRETS in
 * .env so getSecret() can resolve it (needed by Shopify Admin API
 * callers like the future webhook re-register flow).
 */
async function persistAccessToken(
  shop: string,
  accessToken: string,
): Promise<string> {
  if (process.env["NODE_ENV"] !== "production") {
    const shopPrefix = shop.replace(".myshopify.com", "");
    const secretName = `projects/local/secrets/${shopPrefix}-access-token/versions/latest`;
    // DEV-ONLY: Secret Manager is unreachable locally, so the token value
    // has to be surfaced somewhere human-accessible. Operator copy-pastes
    // the SM_DEV_SECRETS entry into .env. Guarded by NODE_ENV != production
    // so this can never reach prod log aggregators.
    logger.info(
      { shop, secretName },
      "[dev] Access token not persisted to Secret Manager. " +
        `Add to SM_DEV_SECRETS in platform-back/.env: ` +
        `"${secretName}":"${accessToken}"`,
    );
    return secretName;
  }

  const secretId = `${shop
    .replace(".myshopify.com", "")
    .replace(/[^a-z0-9]/g, "-")}-shopify-token`;
  return storeSecret(secretId, accessToken);
}

/**
 * Creates the tenant on first install, updates the access token secret
 * name on re-install. Returns the tenant id.
 */
async function upsertTenant(
  shop: string,
  accessTokenSecretName: string,
  storefrontSecretName?: string,
): Promise<string> {
  const existing = await getTenantByShopDomain(shop);
  if (existing) {
    await updateTenantAccessToken(
      existing.id,
      accessTokenSecretName,
      storefrontSecretName,
    );
    return existing.id;
  }

  const slug = shop
    .replace(".myshopify.com", "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") // trim edge hyphens from aggressive replace
    || "shop"; // guard against empty string (shouldn't happen with valid Shopify domains)

  const { id } = await createTenant({
    slug,
    name: shop,
    shopDomain: shop,
    shopifyAccessTokenSecretName: accessTokenSecretName,
    ...(storefrontSecretName !== undefined && {
      storefrontAccessTokenSecretName: storefrontSecretName,
    }),
    ...(KMS_KEY_NAME && { kmsKeyName: KMS_KEY_NAME }),
  });
  return id;
}

/**
 * Creates a Shopify Storefront API access token via the Admin REST API,
 * persists it to Secret Manager, and returns the versioned secret name.
 */
async function provisionStorefrontToken(
  shop: string,
  adminAccessToken: string,
): Promise<string> {
  const res = await fetch(
    `https://${shop}/admin/api/2026-01/storefront_access_tokens.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": adminAccessToken,
      },
      body: JSON.stringify({
        storefront_access_token: { title: "platform-app" },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Shopify Storefront token creation failed [${res.status}]: ${body}`,
    );
  }
  const data = (await res.json()) as {
    storefront_access_token?: { access_token?: string };
  };
  const token = data.storefront_access_token?.access_token;
  if (!token) {
    throw new Error("No access_token in Shopify Storefront token response");
  }

  if (process.env["NODE_ENV"] !== "production") {
    const shopPrefix = shop.replace(".myshopify.com", "");
    const secretName = `projects/local/secrets/${shopPrefix}-storefront-token/versions/latest`;
    logger.info(
      { shop, secretName },
      "[dev] Storefront token not persisted to Secret Manager. " +
        `Add to SM_DEV_SECRETS in platform-back/.env: ` +
        `"${secretName}":"${token}"`,
    );
    return secretName;
  }

  const secretId = `${shop
    .replace(".myshopify.com", "")
    .replace(/[^a-z0-9]/g, "-")}-storefront-token`;
  return storeSecret(secretId, token);
}
