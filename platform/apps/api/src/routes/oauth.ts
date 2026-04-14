/**
 * Shopify OAuth routes — One Umbrella App install flow.
 *
 * GET /oauth/install?shop=mystore.myshopify.com
 *   → Redirects the merchant to Shopify's OAuth authorization page.
 *
 * GET /oauth/callback?code=...&shop=...&state=...&hmac=...
 *   → Shopify redirects here after merchant approves.
 *   → Exchanges the code for an access token, creates/updates the tenant,
 *     stores the token in GCP Secret Manager, then redirects to the dashboard.
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "@new-one-two/logger";
import {
  createTenant,
  getTenantByShopDomain,
  updateTenantAccessToken,
  updateTenantStorefrontToken,
} from "@new-one-two/db";
import { reRegisterTenantWebhooks } from "../lib/shopify-webhooks.js";
import { signJwt } from "../plugins/auth.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const SHOPIFY_CLIENT_ID = process.env["SHOPIFY_CLIENT_ID"] ?? "";
const SHOPIFY_CLIENT_SECRET = process.env["SHOPIFY_CLIENT_SECRET"] ?? "";
const PLATFORM_URL = process.env["PLATFORM_URL"] ?? "http://localhost:3002";
const DASHBOARD_URL = process.env["DASHBOARD_URL"] ?? "http://localhost:3000";

// Scopes the app requests. Extend as new platform features require new APIs.
const SCOPES = [
  "read_products",
  "write_products",
  "read_orders",
  "write_orders",
  "read_customers",
  "read_inventory",
  "read_themes",
  "write_themes",
].join(",");

// ─── Route Registration ────────────────────────────────────────────────────────

export const oauthRoute: FastifyPluginAsync = async (app) => {
  // ─── GET /oauth/install ─────────────────────────────────────────────────────

  app.get<{ Querystring: { shop?: string } }>(
    "/install",
    async (
      req: FastifyRequest<{ Querystring: { shop?: string } }>,
      reply: FastifyReply
    ) => {
      const shop = req.query.shop;

      if (!shop || !shop.endsWith(".myshopify.com")) {
        return reply.status(400).send({ error: "Missing or invalid shop parameter" });
      }

      // State encodes a nonce + shop so we can validate it on callback without
      // server-side session storage.
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
  );

  // ─── GET /oauth/callback ────────────────────────────────────────────────────

  app.get<{
    Querystring: { code?: string; shop?: string; state?: string; hmac?: string };
  }>(
    "/callback",
    async (
      req: FastifyRequest<{
        Querystring: { code?: string; shop?: string; state?: string; hmac?: string };
      }>,
      reply: FastifyReply
    ) => {
      const { code, shop, state, hmac } = req.query;

      if (!code || !shop || !state || !hmac) {
        return reply.status(400).send({ error: "Missing required OAuth parameters" });
      }

      // 1. Validate HMAC from Shopify
      if (!verifyShopifyHmac(req.query as Record<string, string>, hmac)) {
        return reply.status(401).send({ error: "HMAC validation failed" });
      }

      // 2. Validate state (CSRF + shop binding)
      if (!verifyState(state, shop)) {
        return reply.status(400).send({ error: "Invalid state parameter" });
      }

      // 3. Exchange code for access token
      let accessToken: string;
      try {
        accessToken = await exchangeCodeForToken(shop, code);
      } catch (err) {
        logger.error({ err, shop }, "Failed to exchange OAuth code");
        return reply.status(502).send({ error: "Failed to obtain access token from Shopify" });
      }

      // 4. Write shop metafield so the App Block can discover the platform URL.
      //    Non-fatal: log and continue if this fails (storefront widgets just
      //    won't work until the merchant re-installs or the metafield is set manually).
      try {
        await writeShopMetafield(shop, accessToken, "platform_app", "base_url", PLATFORM_URL);
      } catch (err) {
        logger.warn({ err, shop }, "Failed to write platform_app.base_url metafield — continuing");
      }

      // 5. Persist tenant + access token
      let tenantId: string;
      try {
        const secretName = await storeAccessToken(shop, accessToken);
        tenantId = await upsertTenant(shop, secretName);
        logger.info({ shop, tenantId }, "OAuth install complete");
      } catch (err) {
        logger.error({ err, shop }, "Failed to persist tenant after OAuth");
        return reply.status(500).send({ error: "Internal error during install" });
      }

      // 5b. Create and persist a Storefront API token for this shop.
      //     Non-fatal — apps that don't use ctx.storefront will still work.
      try {
        const storefrontToken = await createStorefrontToken(shop, accessToken);
        const storefrontSecretName = await storeStorefrontToken(shop, storefrontToken);
        await updateTenantStorefrontToken(tenantId, storefrontSecretName);
        logger.info({ shop, tenantId }, "Storefront token created and stored");
      } catch (err) {
        logger.warn({ err, shop, tenantId }, "Failed to create Storefront token — ctx.storefront will be unavailable until re-install");
      }

      // 6. Re-register all active webhooks with the current WEBHOOK_BASE_URL.
      //    Non-fatal — handles ngrok URL rotations and re-installs without
      //    requiring a full re-deploy.
      try {
        await reRegisterTenantWebhooks({ tenantId, shop, accessToken });
      } catch (err) {
        logger.warn({ err, shop, tenantId }, "Failed to re-register webhooks after OAuth — continuing");
      }

      // Issue a platform JWT so the dashboard can authenticate subsequent API calls.
      const platformToken = signJwt({ tenantId, shopDomain: shop });
      const redirectUrl = new URL(`${DASHBOARD_URL}/merchants/${tenantId}`);
      redirectUrl.searchParams.set("token", platformToken);
      return reply.redirect(redirectUrl.toString());
    }
  );
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a signed state token that encodes the shop domain.
 * No server-side storage needed — the signature ties the state to the secret.
 */
function buildState(shop: string): string {
  const nonce = crypto.randomUUID();
  const payload = Buffer.from(JSON.stringify({ nonce, shop })).toString("base64url");
  const sig = createHmac("sha256", SHOPIFY_CLIENT_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/**
 * Verifies the state token and checks it was issued for this shop.
 */
function verifyState(state: string, shop: string): boolean {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return false;

  const expected = createHmac("sha256", SHOPIFY_CLIENT_SECRET).update(payload).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return false;
  } catch {
    return false;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      shop: string;
    };
    return decoded.shop === shop;
  } catch {
    return false;
  }
}

/**
 * Validates the HMAC Shopify attaches to OAuth callback query params.
 * All params except `hmac` itself are sorted, joined, and HMAC-SHA256'd
 * with the client secret.
 */
function verifyShopifyHmac(
  params: Record<string, string>,
  hmac: string
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
    return timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(hmac, "hex"));
  } catch {
    return false;
  }
}

/**
 * Writes a shop-level metafield via the Shopify Admin REST API.
 * Used post-install to set platform_app.base_url so the App Block can
 * discover the platform URL without hard-coding it in the theme extension.
 */
async function writeShopMetafield(
  shop: string,
  accessToken: string,
  namespace: string,
  key: string,
  value: string
): Promise<void> {
  const res = await fetch(`https://${shop}/admin/api/2024-01/metafields.json`, {
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
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify metafield write failed [${res.status}]: ${body}`);
  }
}

/**
 * Exchanges the OAuth authorization code for a permanent access token.
 */
async function exchangeCodeForToken(shop: string, code: string): Promise<string> {
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

/**
 * Stores the access token in GCP Secret Manager (or env in local dev).
 * Returns the secret resource name to store on the tenant.
 */
async function storeAccessToken(shop: string, accessToken: string): Promise<string> {
  // In local dev, skip Secret Manager and return a deterministic placeholder path.
  // The token value must be added manually to SM_DEV_SECRETS in platform/.env so
  // that getSecret() can resolve it (needed for webhook registration during deploy).
  if (process.env["NODE_ENV"] !== "production") {
    const secretName = `projects/local/secrets/${shop.replace(".myshopify.com", "")}-access-token/versions/latest`;
    // Never log the token itself — even in dev it is a real Shopify Admin API
    // token that grants full shop access. Log a paste-in template instead and
    // let the operator copy the value from their browser / shopify CLI.
    logger.info(
      { shop, secretName, tokenLength: accessToken.length },
      "[dev] Access token not persisted to Secret Manager. " +
      `To enable Shopify webhook registration, add to SM_DEV_SECRETS in platform/.env: ` +
      `"${secretName}":"<paste-access-token-here>"`
    );
    return secretName;
  }

  // Production: write to Secret Manager via the crypto package.
  // The secret ID is deterministic — re-installs update the same secret.
  const { storeSecret } = await import("@new-one-two/crypto");
  const secretId = `${shop.replace(".myshopify.com", "").replace(/[^a-z0-9]/g, "-")}-shopify-token`;
  const secretName = await storeSecret(secretId, accessToken);
  return secretName;
}

/**
 * Creates a Shopify Storefront API access token for this shop via the Admin API.
 * The token is long-lived and scoped to unauthenticated storefront reads.
 * Shopify is idempotent on the title — re-installs will return a new token.
 */
async function createStorefrontToken(shop: string, adminAccessToken: string): Promise<string> {
  const res = await fetch(
    `https://${shop}/admin/api/2026-01/storefront_access_tokens.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": adminAccessToken,
      },
      body: JSON.stringify({
        storefront_access_token: { title: "new-one-two-platform" },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify storefront token creation failed [${res.status}]: ${body}`);
  }

  const data = (await res.json()) as {
    storefront_access_token?: { access_token?: string };
  };
  const token = data.storefront_access_token?.access_token;
  if (!token) throw new Error("No access_token in Shopify storefront token response");
  return token;
}

/**
 * Stores the Storefront API token in GCP Secret Manager (or dev env).
 * Returns the secret resource name.
 */
async function storeStorefrontToken(shop: string, token: string): Promise<string> {
  if (process.env["NODE_ENV"] !== "production") {
    const secretName = `projects/local/secrets/${shop.replace(".myshopify.com", "")}-storefront-token/versions/latest`;
    // Never log the token itself — see storeAccessToken above for context.
    logger.info(
      { shop, secretName, tokenLength: token.length },
      "[dev] Storefront token not persisted to Secret Manager. " +
      `Add to SM_DEV_SECRETS in platform/.env: "${secretName}":"<paste-storefront-token-here>"`
    );
    return secretName;
  }

  const { storeSecret } = await import("@new-one-two/crypto");
  const secretId = `${shop.replace(".myshopify.com", "").replace(/[^a-z0-9]/g, "-")}-storefront-token`;
  return storeSecret(secretId, token);
}

/**
 * Creates the tenant on first install; updates the access token secret on re-install.
 * Returns the tenant ID.
 */
async function upsertTenant(shop: string, accessTokenSecretName: string): Promise<string> {
  const existing = await getTenantByShopDomain(shop);

  if (existing) {
    await updateTenantAccessToken(existing.id, accessTokenSecretName);
    return existing.id;
  }

  const slug = shop
    .replace(".myshopify.com", "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");

  const { id } = await createTenant({
    slug,
    name: shop,
    shopDomain: shop,
    shopifyAccessTokenSecretName: accessTokenSecretName,
  });

  return id;
}
