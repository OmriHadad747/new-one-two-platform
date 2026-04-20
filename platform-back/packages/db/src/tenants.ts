import type { BillingPlan } from "@platform-back/types";
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
  kmsKeyName?: string;
}): Promise<{ id: string }> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO tenants (
      slug,
      name,
      status,
      shop_domain,
      shopify_access_token_secret_name,
      kms_key_name
    ) VALUES (
      ${params.slug},
      ${params.name},
      'active',
      ${params.shopDomain},
      ${params.shopifyAccessTokenSecretName},
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
): Promise<void> {
  await sql`
    UPDATE tenants
    SET
      shopify_access_token_secret_name = ${shopifyAccessTokenSecretName},
      updated_at = NOW()
    WHERE id = ${tenantId}
  `;
}
