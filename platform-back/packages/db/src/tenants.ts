import type { BillingPlan } from "@platform-back/types";
import { sql } from "./connection.js";

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
