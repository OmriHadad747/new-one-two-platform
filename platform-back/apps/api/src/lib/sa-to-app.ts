import { sql } from "@platform-back/db";

// Maps a verified handler SA email → (tenantId, appId). Cached per
// process because the SA-to-app binding is set once at handler-deploy
// time and never changes (uninstall deletes the row, but the cache
// entry would only matter for in-flight requests, which the deploy
// teardown waits for).
//
// Cache size is bounded — Cloud Run instances are scaled per-tenant
// in aggregate, so even a busy platform-back instance sees at most a
// few thousand distinct SAs. We don't add an LRU until that pressure
// shows up in metrics.

export interface AppIdentity {
  tenantId: string;
  appId: string;
}

const cache = new Map<string, AppIdentity>();

/**
 * Looks up the (tenantId, appId) bound to an SA email. Returns null
 * when no active app is associated — caller maps to 403 (untrusted SA).
 *
 * The query intentionally filters on `apps.status = 'active'` and the
 * tenant's status — a paused or uninstalled tenant must not be able
 * to send through us even if its handler is somehow still running.
 */
export async function resolveAppFromSaEmail(
  saEmail: string,
): Promise<AppIdentity | null> {
  const cached = cache.get(saEmail);
  if (cached) return cached;

  const rows = await sql<Array<{ tenantId: string; appId: string }>>`
    SELECT
      a.tenant_id AS "tenantId",
      a.id        AS "appId"
    FROM apps a
    JOIN tenants t ON t.id = a.tenant_id
    WHERE a.handler_sa_email = ${saEmail}
      AND a.status = 'active'
      AND t.status = 'active'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  const identity: AppIdentity = { tenantId: row.tenantId, appId: row.appId };
  cache.set(saEmail, identity);
  return identity;
}

/**
 * Eagerly invalidate a cache entry. Currently UNCALLED — wire this from
 * the uninstall flow when it's built (TD-019-style: when an app is
 * deleted/uninstalled, also drop its SA email from the cache so a new
 * app reusing the same SA name doesn't hit a stale tenantId mapping).
 */
export function invalidateSaCache(saEmail: string): void {
  cache.delete(saEmail);
}
