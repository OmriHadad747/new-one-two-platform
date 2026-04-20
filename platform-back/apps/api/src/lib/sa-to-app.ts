import { sql } from "@platform-back/db";

// Maps a verified handler SA email → (tenantId, appId).
//
// Why a cache at all: every /services/* call resolves an SA email to an
// app, which is a DB round-trip on the critical path of every handler
// outbound request. SA bindings are stable (set at handler-deploy time,
// cleared only on uninstall), so in-process caching is a clean win.
//
// Why a TTL: since uninstall lives on the platform side (not in the
// handler itself), entries may outlive their DB row. Without any
// explicit invalidation wiring, a 5-minute TTL guarantees a paused or
// uninstalled app stops being resolvable within that window — correct,
// self-healing, and works across multiple platform-back replicas
// without coordination. The TTL is short enough that a deactivated
// tenant can't keep calling for long, long enough that cache hits
// still dominate steady-state traffic.
//
// Invalidation remains an explicit fast-path: any code that
// DEACTIVATES an app (uninstall handler, admin-disable, tenant-suspend)
// should call `invalidateSaCache(saEmail)` so propagation is immediate
// rather than TTL-bounded. If the call is forgotten, the TTL still
// catches it — missing the invalidation is a latency bug, not a
// security one.

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  identity: AppIdentity;
  expiresAt: number;
}

export interface AppIdentity {
  tenantId: string;
  appId: string;
}

const cache = new Map<string, CacheEntry>();

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
  const now = Date.now();
  const cached = cache.get(saEmail);
  if (cached && cached.expiresAt > now) {
    return cached.identity;
  }
  if (cached) {
    // Entry exists but is stale — evict rather than refresh-in-place so
    // a row that has since been deactivated at the DB returns null.
    cache.delete(saEmail);
  }

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
  cache.set(saEmail, { identity, expiresAt: now + CACHE_TTL_MS });
  return identity;
}

/**
 * Eagerly invalidate a cache entry. Call from any code path that
 * deactivates an app or tenant (uninstall handler, admin-disable,
 * tenant-suspend) so propagation is immediate rather than bounded by
 * the TTL. Safe to call with an unknown SA email — it's a no-op.
 */
export function invalidateSaCache(saEmail: string): void {
  cache.delete(saEmail);
}

/**
 * Drop every cached entry. Intended for tests and for exceptional
 * situations (e.g. rotating the SA→app binding scheme at runtime);
 * not called during normal operation.
 */
export function clearSaCache(): void {
  cache.clear();
}
