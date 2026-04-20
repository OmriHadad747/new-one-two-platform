import { sql } from "./connection.js";

export interface AppRecord {
  id: string;
  tenantId: string;
  shopDomain: string;
  status: string;
}

/**
 * Fetches the basic app record for authorization checks. "Unsafe" because
 * it does NOT enforce tenant scope — callers are expected to compare the
 * returned tenantId against the authenticated tenant via requireTenant.
 */
export async function getAppById(appId: string): Promise<AppRecord | null> {
  const rows = await sql<AppRecord[]>`
    SELECT
      id,
      tenant_id   AS "tenantId",
      shop_domain AS "shopDomain",
      status
    FROM apps
    WHERE id = ${appId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface ResolvedHandler {
  functionUrl: string;
  tenantId: string;
}

/**
 * Active Cloud Run handler URL + tenant id for a (shop, app) pair.
 * Returns null when the app isn't found, isn't active, or hasn't
 * been deployed yet — callers map null to the appropriate HTTP status.
 *
 * Intentionally narrow: only returns what the edge needs to forward,
 * never tenant secrets or app metadata.
 */
export async function resolveAppHandler(
  shopDomain: string,
  appId: string,
): Promise<ResolvedHandler | null> {
  const rows = await sql<
    Array<{ functionUrl: string | null; tenantId: string }>
  >`
    SELECT df.function_url AS "functionUrl", t.id AS "tenantId"
    FROM apps a
    JOIN tenants t ON t.id = a.tenant_id
    LEFT JOIN deployed_functions df
      ON df.app_id = a.id AND df.is_active = TRUE
    WHERE a.shop_domain = ${shopDomain}
      AND a.id = ${appId}
      AND a.status = 'active'
      AND t.status = 'active'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row?.functionUrl) return null;
  return { functionUrl: row.functionUrl, tenantId: row.tenantId };
}
