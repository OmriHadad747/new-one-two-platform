import postgres from "postgres";
import { logger } from "@platform-back/logger";

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  throw new Error("FATAL: DATABASE_URL is not set");
}

// One pooled client per process. `postgres` opens lazily on first query.
// Cloud Run instances are short-lived; small pool keeps Postgres connection
// count bounded as the service scales horizontally.
export const sql = postgres(DATABASE_URL, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
  onnotice: () => {},
});

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

export async function closeDb(): Promise<void> {
  try {
    await sql.end({ timeout: 5 });
  } catch (err) {
    logger.warn({ err }, "Error closing Postgres pool");
  }
}
