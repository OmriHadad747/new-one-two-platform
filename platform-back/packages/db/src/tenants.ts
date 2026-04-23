import type { BillingPlan, BillingInterval, TenantStatus } from "@platform-back/types";
import { sql } from "./connection.js";

// Default KMS key name used for new tenants when no GCP project is set
// (local dev). Production callers should pass an explicit kmsKeyName.
const DEV_KMS_KEY_NAME =
  "projects/local/locations/global/keyRings/dev/cryptoKeys/dev-key";

export interface TenantBasics {
  id: string;
  shopDomain: string;
  storeName: string;
  plan: BillingPlan;
}

/**
 * Minimum tenant fields needed to authorize and personalize a
 * /services/* call. Fetched on every send because tenant identity
 * comes from the verified ID token, never the request body.
 *
 * Intentionally does NOT return secrets, access tokens, or anything
 * that would let a compromised service spoof tenant identity downstream.
 */
export async function getTenantBasics(
  tenantId: string,
): Promise<TenantBasics | null> {
  const rows = await sql<
    Array<{
      id: string;
      shopDomain: string;
      storeName: string | null;
      plan: BillingPlan | null;
    }>
  >`
    SELECT
      id,
      shop_domain  AS "shopDomain",
      store_name   AS "storeName",
      billing_plan AS "plan"
    FROM tenants
    WHERE id = ${tenantId} AND status = 'active'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    shopDomain: row.shopDomain,
    storeName: row.storeName ?? row.shopDomain,
    plan: row.plan ?? "free",
  };
}

// ─── Mutations used by the OAuth flow ────────────────────────────────────────

/**
 * Inserts a new tenant row. Called once per shop on first install. The
 * shop_domain UNIQUE constraint is the dedup key — re-installs hit
 * updateTenantAccessToken instead.
 */
export async function createTenant(params: {
  slug: string;
  name: string;
  shopDomain: string;
  shopifyAccessTokenSecretName: string;
  storefrontAccessTokenSecretName?: string;
  kmsKeyName?: string;
}): Promise<{ id: string }> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO tenants (
      slug,
      name,
      status,
      shop_domain,
      shopify_access_token_secret_name,
      storefront_access_token_secret_name,
      kms_key_name
    ) VALUES (
      ${params.slug},
      ${params.name},
      'active',
      ${params.shopDomain},
      ${params.shopifyAccessTokenSecretName},
      ${params.storefrontAccessTokenSecretName ?? null},
      ${params.kmsKeyName ?? DEV_KMS_KEY_NAME}
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

/**
 * Tenant lookup by shop domain. The OAuth callback uses this to detect
 * re-installs (existing → update token; missing → createTenant).
 */
export async function getTenantByShopDomain(
  shopDomain: string,
): Promise<{ id: string } | null> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM tenants WHERE shop_domain = ${shopDomain} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function updateTenantAccessToken(
  tenantId: string,
  shopifyAccessTokenSecretName: string,
  storefrontAccessTokenSecretName?: string,
): Promise<void> {
  await sql`
    UPDATE tenants
    SET
      shopify_access_token_secret_name = ${shopifyAccessTokenSecretName},
      storefront_access_token_secret_name = COALESCE(
        ${storefrontAccessTokenSecretName ?? null},
        storefront_access_token_secret_name
      ),
      updated_at = NOW()
    WHERE id = ${tenantId}
  `;
}

/**
 * Resolve the Secret Manager name holding this tenant's Shopify Admin
 * access token. Used by /services/shopify/access-token when a handler's
 * cron runner needs the token (no inbound request to read the header
 * off).
 */
export async function getTenantAccessTokenSecretName(
  tenantId: string,
): Promise<string | null> {
  const rows = await sql<Array<{ secretName: string | null }>>`
    SELECT shopify_access_token_secret_name AS "secretName"
    FROM tenants
    WHERE id = ${tenantId} AND status = 'active'
    LIMIT 1
  `;
  return rows[0]?.secretName ?? null;
}

/**
 * Resolve the Secret Manager name holding this tenant's Shopify Storefront
 * API access token. Used by /services/shopify/storefront-access-token.
 */
export async function getTenantStorefrontTokenSecretName(
  tenantId: string,
): Promise<string | null> {
  const rows = await sql<Array<{ secretName: string | null }>>`
    SELECT storefront_access_token_secret_name AS "secretName"
    FROM tenants
    WHERE id = ${tenantId} AND status = 'active'
    LIMIT 1
  `;
  return rows[0]?.secretName ?? null;
}

// ─── Dashboard reads ─────────────────────────────────────────────────────────

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  shopDomain: string | null;
  shopifyAccessTokenSecretName: string | null;
  storefrontAccessTokenSecretName: string | null;
  billingPlan: BillingPlan;
  billingInterval: BillingInterval;
  subscriptionStatus: string;
  shopifySubscriptionId: string | null;
  trialEndsAt: string | null;
  billingCycleAnchor: string;
  planUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Full dashboard-facing tenant row. Strictly more fields than getTenantBasics
 * (which is tuned for /services/* auth). Used by /tenants/:tenantId and the
 * upgrade / subscription-state UX.
 */
export async function getTenantById(
  tenantId: string,
): Promise<TenantRecord | null> {
  const rows = await sql<TenantRecord[]>`
    SELECT
      id,
      slug,
      name,
      status,
      shop_domain                          AS "shopDomain",
      shopify_access_token_secret_name     AS "shopifyAccessTokenSecretName",
      storefront_access_token_secret_name  AS "storefrontAccessTokenSecretName",
      billing_plan                         AS "billingPlan",
      billing_interval                     AS "billingInterval",
      subscription_status                  AS "subscriptionStatus",
      shopify_subscription_id              AS "shopifySubscriptionId",
      trial_ends_at                        AS "trialEndsAt",
      billing_cycle_anchor                 AS "billingCycleAnchor",
      plan_updated_at                      AS "planUpdatedAt",
      created_at                           AS "createdAt",
      updated_at                           AS "updatedAt"
    FROM tenants
    WHERE id = ${tenantId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface TenantStats {
  liveApps: number;
  totalApps: number;
}

/**
 * Headline dashboard numbers. Intentionally cheap — a single grouped
 * query over apps. Detailed usage counters come from /billing/usage.
 */
export async function getTenantStats(tenantId: string): Promise<TenantStats> {
  const rows = await sql<Array<{ status: string; n: string }>>`
    SELECT status, COUNT(*)::text AS n
      FROM apps
     WHERE tenant_id = ${tenantId}
       AND status != 'deleted'
     GROUP BY status
  `;
  let total = 0;
  let live = 0;
  for (const r of rows) {
    const n = Number(r.n);
    total += n;
    if (r.status === "active") live = n;
  }
  return { liveApps: live, totalApps: total };
}
