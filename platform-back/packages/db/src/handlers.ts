import { sql } from "./connection.js";

// ─── Core app shape ───────────────────────────────────────────────────────────

/**
 * Shape returned by the dashboard and lifecycle helpers — strictly more
 * fields than the edge's narrower AppRecord. The edge never touches this
 * shape; keep expansions here without affecting routing.
 */
export interface AppFullRecord {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  status: "draft" | "ready" | "active" | "inactive" | "deleted";
  shopDomain: string;
  appArchetype:
    | "storefront_backend"
    | "storefront_backend_admin"
    | "backend"
    | "backend_admin";
  themeInjectionStatus: string;
  themeInjectionThemeId: string | null;
  usesEmail: boolean;
  handlerSaEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppRecord {
  id: string;
  tenantId: string;
  shopDomain: string;
  status: string;
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

/**
 * Tenant-scoped app lookup. Pair mismatches return null instead of
 * leaking rows across tenants — use this anywhere the route has a
 * tenantId in its path (dashboard, lifecycle, teardown). See
 * REFACTOR_GAPS §7 (defence-in-depth over the prior unscoped signature).
 */
export async function getAppById(
  tenantId: string,
  appId: string,
): Promise<AppFullRecord | null> {
  const rows = await sql<AppFullRecord[]>`
    SELECT
      id,
      tenant_id                 AS "tenantId",
      slug,
      name,
      status,
      shop_domain               AS "shopDomain",
      app_archetype             AS "appArchetype",
      theme_injection_status    AS "themeInjectionStatus",
      theme_injection_theme_id  AS "themeInjectionThemeId",
      uses_email                AS "usesEmail",
      handler_sa_email          AS "handlerSaEmail",
      created_at                AS "createdAt",
      updated_at                AS "updatedAt"
    FROM apps
    WHERE id = ${appId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Unscoped app lookup. "Unsafe" because the caller is responsible for
 * verifying that the returned tenantId matches the authenticated tenant
 * (usually via requireTenant). Preferred pattern is getAppById above;
 * this exists for routes that don't have tenantId in the path (e.g.
 * deploy, generation lifecycle) and do the check themselves.
 */
export async function getAppByIdUnsafe(
  appId: string,
): Promise<AppRecord | null> {
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
 * Slugs needed to build webhook callback URLs and SA names at deploy time.
 */
export async function getAppSlugs(
  appId: string,
): Promise<{ appSlug: string; tenantSlug: string } | null> {
  const rows = await sql<Array<{ appSlug: string; tenantSlug: string }>>`
    SELECT a.slug AS "appSlug", t.slug AS "tenantSlug"
    FROM apps a
    JOIN tenants t ON t.id = a.tenant_id
    WHERE a.id = ${appId}
    LIMIT 1
  `;
  return rows[0] ?? null;
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

/**
 * List all non-deleted apps for a tenant, newest first. Powers the
 * dashboard's app picker.
 */
export async function listAppsForTenant(
  tenantId: string,
): Promise<AppFullRecord[]> {
  return sql<AppFullRecord[]>`
    SELECT
      id,
      tenant_id                 AS "tenantId",
      slug,
      name,
      status,
      shop_domain               AS "shopDomain",
      app_archetype             AS "appArchetype",
      theme_injection_status    AS "themeInjectionStatus",
      theme_injection_theme_id  AS "themeInjectionThemeId",
      uses_email                AS "usesEmail",
      handler_sa_email          AS "handlerSaEmail",
      created_at                AS "createdAt",
      updated_at                AS "updatedAt"
    FROM apps
    WHERE tenant_id = ${tenantId}
      AND status != 'deleted'
    ORDER BY created_at DESC
  `;
}

/**
 * Count of apps currently in 'active' status for a tenant. Feeds the
 * canActivateApp plan check — soft-deleted / inactive / draft rows don't
 * consume the seat.
 */
export async function getActiveAppCount(tenantId: string): Promise<number> {
  const rows = await sql<Array<{ n: string }>>`
    SELECT COUNT(*)::text AS n
      FROM apps
     WHERE tenant_id = ${tenantId}
       AND status = 'active'
  `;
  return Number(rows[0]?.n ?? 0);
}

// ─── Write helpers ────────────────────────────────────────────────────────────

export interface CreateAppInput {
  id?: string;
  tenantId: string;
  slug: string;
  name: string;
  shopDomain: string;
  shopifyClientId?: string;
  shopifySecretName?: string;
}

/**
 * Creates an apps row in 'draft' status. The per-handler SA is provisioned
 * lazily on first deploy — createApp does not touch GCP IAM.
 *
 * If `id` is provided it's used verbatim (dashboard allocates up front
 * for idempotent retries); otherwise Postgres's default generates one.
 */
export async function createApp(
  input: CreateAppInput,
): Promise<{ id: string }> {
  const clientId = input.shopifyClientId ?? "";
  const secretName = input.shopifySecretName ?? "";
  const rows = input.id
    ? await sql<Array<{ id: string }>>`
        INSERT INTO apps (
          id, tenant_id, slug, name, shop_domain,
          shopify_client_id, shopify_secret_name, status
        ) VALUES (
          ${input.id}, ${input.tenantId}, ${input.slug}, ${input.name},
          ${input.shopDomain}, ${clientId}, ${secretName}, 'draft'
        )
        RETURNING id
      `
    : await sql<Array<{ id: string }>>`
        INSERT INTO apps (
          tenant_id, slug, name, shop_domain,
          shopify_client_id, shopify_secret_name, status
        ) VALUES (
          ${input.tenantId}, ${input.slug}, ${input.name},
          ${input.shopDomain}, ${clientId}, ${secretName}, 'draft'
        )
        RETURNING id
      `;
  return rows[0]!;
}

export async function updateAppName(
  tenantId: string,
  appId: string,
  name: string,
): Promise<void> {
  await sql`
    UPDATE apps
       SET name = ${name}, updated_at = NOW()
     WHERE id = ${appId}
       AND tenant_id = ${tenantId}
  `;
}

export async function updateAppStatus(
  appId: string,
  status: "draft" | "ready" | "active" | "inactive" | "deleted",
): Promise<void> {
  await sql`
    UPDATE apps
       SET status = ${status}, updated_at = NOW()
     WHERE id = ${appId}
  `;
}

export async function setThemeInjection(
  appId: string,
  themeId: string,
): Promise<void> {
  await sql`
    UPDATE apps
       SET theme_injection_status = 'injected',
           theme_injection_theme_id = ${themeId},
           updated_at = NOW()
     WHERE id = ${appId}
  `;
}

export async function clearThemeInjection(appId: string): Promise<void> {
  await sql`
    UPDATE apps
       SET theme_injection_status = 'none',
           theme_injection_theme_id = NULL,
           updated_at = NOW()
     WHERE id = ${appId}
  `;
}

/**
 * Mark all infrastructure inactive without removing rows — used by
 * teardownApp so a later reactivateApp can walk the history.
 */
export async function deactivateAppInfrastructure(
  appId: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE deployed_functions
         SET is_active = FALSE
       WHERE app_id = ${appId}
         AND is_active = TRUE
    `;
    await tx`
      UPDATE webhook_subscriptions
         SET is_active = FALSE
       WHERE app_id = ${appId}
         AND is_active = TRUE
    `;
  });
}

/**
 * Hard-deletes an app and all FK-cascade children. Order matters: the
 * two ON DELETE RESTRICT FKs (webhook_subscriptions.deployed_function_id,
 * deployed_functions.app_version_id) must be dropped explicitly before
 * the apps row cascade fires — everything else (files, invocation logs,
 * generations, email_deliveries, app_versions) cleans itself up via
 * ON DELETE CASCADE.
 */
export async function hardDeleteApp(appId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM webhook_subscriptions WHERE app_id = ${appId}`;
    await tx`DELETE FROM deployed_functions    WHERE app_id = ${appId}`;
    await tx`DELETE FROM apps                   WHERE id     = ${appId}`;
  });
}

// ─── Webhook + version metadata (used by teardown / permanent-delete) ────────

export interface ActiveWebhookSubscription {
  id: string;
  topic: string;
  shopifyWebhookId: string;
}

/**
 * Active Shopify webhook subscriptions for an app — feeds
 * unregisterShopifyWebhooks on teardown / redeploy.
 */
export async function getActiveWebhookSubscriptionsForApp(
  appId: string,
): Promise<ActiveWebhookSubscription[]> {
  return sql<ActiveWebhookSubscription[]>`
    SELECT
      id,
      topic,
      shopify_webhook_id AS "shopifyWebhookId"
    FROM webhook_subscriptions
    WHERE app_id = ${appId}
      AND is_active = TRUE
  `;
}

/**
 * Semvers of every app_versions row for this app — feeds Artifact
 * Registry cleanup on permanent delete.
 */
export async function getAppVersionSemvers(appId: string): Promise<string[]> {
  const rows = await sql<Array<{ semver: string }>>`
    SELECT semver FROM app_versions WHERE app_id = ${appId}
  `;
  return rows.map((r) => r.semver);
}

export interface LatestDeployedVersion {
  deployedFunctionId: string;
  appVersionId: string;
  imageName: string | null; // resolved by caller via dockerImageName(appId, semver)
  semver: string;
  webhookTopics: string[];
  /** Cron expression captured at deploy; null when the app has no tick. */
  cronSchedule: string | null;
}

/**
 * Most-recently-active deployment for an app, whether currently active
 * or not — feeds reactivateApp so it can redeploy the existing image
 * without rebuilding. Falls back to the latest deployed_functions row
 * when none are active.
 */
export async function getLatestDeployedVersionForApp(
  appId: string,
): Promise<LatestDeployedVersion | null> {
  const rows = await sql<
    Array<{
      deployedFunctionId: string;
      appVersionId: string;
      semver: string;
      cronSchedule: string | null;
      webhookTopics: string[];
    }>
  >`
    SELECT
      df.id              AS "deployedFunctionId",
      df.app_version_id  AS "appVersionId",
      av.semver          AS "semver",
      df.cron_schedule   AS "cronSchedule",
      COALESCE(
        ARRAY(
          SELECT DISTINCT topic
          FROM webhook_subscriptions
          WHERE app_id = df.app_id
        ),
        '{}'::text[]
      ) AS "webhookTopics"
    FROM deployed_functions df
    JOIN app_versions av ON av.id = df.app_version_id
    WHERE df.app_id = ${appId}
    ORDER BY df.deployed_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    deployedFunctionId: row.deployedFunctionId,
    appVersionId: row.appVersionId,
    imageName: null,
    semver: row.semver,
    webhookTopics: row.webhookTopics ?? [],
    cronSchedule: row.cronSchedule,
  };
}

