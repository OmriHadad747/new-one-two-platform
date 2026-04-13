// ─── Tenant / App Management Queries ─────────────────────────────────────────

import type { Tenant, App, AppArchetype } from "@new-one-two/types";
import { sql } from "./connection.js";

export async function createTenant(params: {
  id?: string;
  slug: string;
  name: string;
  shopDomain?: string;
  shopifyAccessTokenSecretName?: string;
  kmsKeyName?: string;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO tenants (id, slug, name, status, shop_domain, shopify_access_token_secret_name, kms_key_name)
    VALUES (
      ${params.id ?? sql`uuid_generate_v4()`},
      ${params.slug},
      ${params.name},
      'active',
      ${params.shopDomain ?? null},
      ${params.shopifyAccessTokenSecretName ?? null},
      ${params.kmsKeyName ?? "projects/local/locations/global/keyRings/dev/cryptoKeys/dev-key"}
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  const rows = await sql<
    Array<{
      id: string;
      slug: string;
      name: string;
      status: string;
      billingPlan: string;
      billingInterval: string;
      subscriptionStatus: string;
      shopifySubscriptionId: string | null;
      trialEndsAt: Date | null;
      billingCycleAnchor: Date;
      planUpdatedAt: Date;
      kmsKeyName: string;
      shopDomain: string | null;
      shopifyAccessTokenSecretName: string | null;
      storefrontAccessTokenSecretName: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT
      id,
      slug,
      name,
      status,
      billing_plan                            AS "billingPlan",
      billing_interval                        AS "billingInterval",
      subscription_status                     AS "subscriptionStatus",
      shopify_subscription_id                 AS "shopifySubscriptionId",
      trial_ends_at                           AS "trialEndsAt",
      billing_cycle_anchor                    AS "billingCycleAnchor",
      plan_updated_at                         AS "planUpdatedAt",
      kms_key_name                            AS "kmsKeyName",
      shop_domain                             AS "shopDomain",
      shopify_access_token_secret_name        AS "shopifyAccessTokenSecretName",
      storefront_access_token_secret_name     AS "storefrontAccessTokenSecretName",
      created_at                              AS "createdAt",
      updated_at                              AS "updatedAt"
    FROM tenants
    WHERE id = ${id}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as Tenant["status"],
    billingPlan: row.billingPlan as Tenant["billingPlan"],
    billingInterval: (row.billingInterval ?? "monthly") as Tenant["billingInterval"],
    subscriptionStatus: row.subscriptionStatus as Tenant["subscriptionStatus"],
    shopifySubscriptionId: row.shopifySubscriptionId,
    trialEndsAt: row.trialEndsAt,
    billingCycleAnchor: row.billingCycleAnchor,
    planUpdatedAt: row.planUpdatedAt,
    kmsKeyName: row.kmsKeyName,
    shopDomain: row.shopDomain,
    shopifyAccessTokenSecretName: row.shopifyAccessTokenSecretName,
    storefrontAccessTokenSecretName: row.storefrontAccessTokenSecretName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Finds a tenant by shop domain. Used during OAuth callback to detect re-installs.
 */
export async function getTenantByShopDomain(shopDomain: string): Promise<Tenant | null> {
  const rows = await sql<
    Array<{
      id: string;
      slug: string;
      name: string;
      status: string;
      billingPlan: string;
      billingInterval: string;
      subscriptionStatus: string;
      shopifySubscriptionId: string | null;
      trialEndsAt: Date | null;
      billingCycleAnchor: Date;
      planUpdatedAt: Date;
      kmsKeyName: string;
      shopDomain: string | null;
      shopifyAccessTokenSecretName: string | null;
      storefrontAccessTokenSecretName: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT
      id,
      slug,
      name,
      status,
      billing_plan                            AS "billingPlan",
      billing_interval                        AS "billingInterval",
      subscription_status                     AS "subscriptionStatus",
      shopify_subscription_id                 AS "shopifySubscriptionId",
      trial_ends_at                           AS "trialEndsAt",
      billing_cycle_anchor                    AS "billingCycleAnchor",
      plan_updated_at                         AS "planUpdatedAt",
      kms_key_name                            AS "kmsKeyName",
      shop_domain                             AS "shopDomain",
      shopify_access_token_secret_name        AS "shopifyAccessTokenSecretName",
      storefront_access_token_secret_name     AS "storefrontAccessTokenSecretName",
      created_at                              AS "createdAt",
      updated_at                              AS "updatedAt"
    FROM tenants
    WHERE shop_domain = ${shopDomain}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as Tenant["status"],
    billingPlan: row.billingPlan as Tenant["billingPlan"],
    billingInterval: (row.billingInterval ?? "monthly") as Tenant["billingInterval"],
    subscriptionStatus: row.subscriptionStatus as Tenant["subscriptionStatus"],
    shopifySubscriptionId: row.shopifySubscriptionId,
    trialEndsAt: row.trialEndsAt,
    billingCycleAnchor: row.billingCycleAnchor,
    planUpdatedAt: row.planUpdatedAt,
    kmsKeyName: row.kmsKeyName,
    shopDomain: row.shopDomain,
    shopifyAccessTokenSecretName: row.shopifyAccessTokenSecretName,
    storefrontAccessTokenSecretName: row.storefrontAccessTokenSecretName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Updates a tenant's Shopify access token secret name. Used on OAuth re-install.
 */
export async function updateTenantAccessToken(
  tenantId: string,
  shopifyAccessTokenSecretName: string
): Promise<void> {
  await sql`
    UPDATE tenants
    SET
      shopify_access_token_secret_name = ${shopifyAccessTokenSecretName},
      updated_at = NOW()
    WHERE id = ${tenantId}
  `;
}

/**
 * Stores the Shopify Storefront API token secret name on the tenant.
 * Called post-OAuth after creating the token via the Admin API.
 */
export async function updateTenantStorefrontToken(
  tenantId: string,
  storefrontAccessTokenSecretName: string
): Promise<void> {
  await sql`
    UPDATE tenants
    SET
      storefront_access_token_secret_name = ${storefrontAccessTokenSecretName},
      updated_at = NOW()
    WHERE id = ${tenantId}
  `;
}

export async function createApp(params: {
  id?: string;
  tenantId: string;
  slug: string;
  name: string;
  shopDomain: string;
  appArchetype?: string;
  shopifyClientId?: string;
  shopifySecretName?: string;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO apps (
      id, tenant_id, slug, name, status,
      shop_domain, app_archetype, shopify_client_id, shopify_secret_name
    ) VALUES (
      ${params.id ?? sql`uuid_generate_v4()`},
      ${params.tenantId},
      ${params.slug},
      ${params.name},
      'draft',
      ${params.shopDomain},
      ${params.appArchetype ?? "backend"},
      ${params.shopifyClientId ?? "dev-api-key"},
      ${params.shopifySecretName ?? "projects/local/secrets/dev/versions/latest"}
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

export async function getAppById(
  tenantId: string,
  appId: string
): Promise<App | null> {
  const rows = await sql<
    Array<{
      id: string;
      tenantId: string;
      slug: string;
      name: string;
      status: string;
      appArchetype: string;
      widgetJs: string | null;
      adminUiJs: string | null;
      shopifyClientId: string;
      shopifySecretName: string;
      shopDomain: string;
      themeInjectionStatus: string;
      themeInjectionThemeId: string | null;
      currentSemver: string | null;
      activeAppVersionId: string | null;
      usesEmail: boolean;
      emailVariables: string[] | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT
      a.id,
      a.tenant_id                            AS "tenantId",
      a.slug,
      a.name,
      a.status,
      a.app_archetype                        AS "appArchetype",
      a.widget_js                            AS "widgetJs",
      a.admin_ui_js                          AS "adminUiJs",
      a.shopify_client_id                    AS "shopifyClientId",
      a.shopify_secret_name                  AS "shopifySecretName",
      a.shop_domain                          AS "shopDomain",
      a.theme_injection_status               AS "themeInjectionStatus",
      a.theme_injection_theme_id             AS "themeInjectionThemeId",
      av.semver                              AS "currentSemver",
      df.app_version_id                      AS "activeAppVersionId",
      a.uses_email                           AS "usesEmail",
      a.email_variables                      AS "emailVariables",
      a.created_at                           AS "createdAt",
      a.updated_at                           AS "updatedAt"
    FROM apps a
    LEFT JOIN deployed_functions df ON df.app_id = a.id AND df.is_active = TRUE
    LEFT JOIN app_versions av ON av.id = df.app_version_id
    WHERE a.id = ${appId} AND a.tenant_id = ${tenantId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    slug: row.slug,
    name: row.name,
    status: row.status as App["status"],
    appArchetype: row.appArchetype as AppArchetype,
    widgetJs: row.widgetJs,
    adminUiJs: row.adminUiJs,
    shopifyClientId: row.shopifyClientId,
    shopifySecretName: row.shopifySecretName,
    shopDomain: row.shopDomain,
    themeInjectionStatus: (row.themeInjectionStatus ?? "none") as App["themeInjectionStatus"],
    themeInjectionThemeId: row.themeInjectionThemeId ?? null,
    currentSemver: row.currentSemver ?? null,
    activeAppVersionId: row.activeAppVersionId ?? null,
    usesEmail: row.usesEmail ?? false,
    emailVariables: row.emailVariables ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Updates the status of an app.
 */
export async function updateAppStatus(
  appId: string,
  status: App["status"]
): Promise<void> {
  await sql`
    UPDATE apps
    SET status = ${status},
        updated_at = NOW()
    WHERE id = ${appId}
  `;
}

/**
 * Stores the storefront widget JS for a platform app.
 */
export async function updateAppWidgetJs(
  appId: string,
  widgetJs: string | null
): Promise<void> {
  await sql`
    UPDATE apps
    SET widget_js  = ${widgetJs},
        updated_at = NOW()
    WHERE id = ${appId}
  `;
}

/**
 * Stores the admin UI JS for a storefront_backend_admin app.
 * Called by the deployer after a successful bundle deployment.
 */
export async function updateAppAdminUiJs(
  appId: string,
  adminUiJs: string | null
): Promise<void> {
  await sql`
    UPDATE apps
    SET admin_ui_js = ${adminUiJs},
        updated_at  = NOW()
    WHERE id = ${appId}
  `;
}

/**
 * Updates the app_archetype for a platform app.
 * Called by the deployer — archetype is inferred from the bundle contents.
 */
export async function updateAppArchetype(
  appId: string,
  appArchetype: AppArchetype
): Promise<void> {
  await sql`
    UPDATE apps
    SET app_archetype = ${appArchetype},
        updated_at    = NOW()
    WHERE id = ${appId}
  `;
}

/**
 * Renames a platform app (name only — slug is immutable).
 */
export async function updateAppName(
  tenantId: string,
  appId: string,
  name: string
): Promise<void> {
  await sql`
    UPDATE apps
    SET name       = ${name},
        updated_at = NOW()
    WHERE id        = ${appId}
      AND tenant_id = ${tenantId}
  `;
}

/**
 * Records that a test theme has been duplicated+injected for this app.
 */
export async function setThemeInjection(
  appId: string,
  themeId: string
): Promise<void> {
  await sql`
    UPDATE apps
    SET theme_injection_status   = 'injected',
        theme_injection_theme_id = ${themeId},
        updated_at               = NOW()
    WHERE id = ${appId}
  `;
}

/**
 * Clears theme injection state (after the test theme is deleted).
 */
export async function clearThemeInjection(appId: string): Promise<void> {
  await sql`
    UPDATE apps
    SET theme_injection_status   = 'none',
        theme_injection_theme_id = NULL,
        updated_at               = NOW()
    WHERE id = ${appId}
  `;
}

/**
 * Returns all apps for a tenant, newest first.
 */
export async function getAppsByTenantId(tenantId: string): Promise<App[]> {
  const rows = await sql<
    Array<{
      id: string;
      tenantId: string;
      slug: string;
      name: string;
      status: string;
      appArchetype: string;
      widgetJs: string | null;
      adminUiJs: string | null;
      shopifyClientId: string;
      shopifySecretName: string;
      shopDomain: string;
      themeInjectionStatus: string;
      themeInjectionThemeId: string | null;
      currentSemver: string | null;
      activeAppVersionId: string | null;
      usesEmail: boolean;
      emailVariables: string[] | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT
      a.id,
      a.tenant_id                            AS "tenantId",
      a.slug,
      a.name,
      a.status,
      a.app_archetype                        AS "appArchetype",
      a.widget_js                            AS "widgetJs",
      a.admin_ui_js                          AS "adminUiJs",
      a.shopify_client_id                    AS "shopifyClientId",
      a.shopify_secret_name                  AS "shopifySecretName",
      a.shop_domain                          AS "shopDomain",
      a.theme_injection_status               AS "themeInjectionStatus",
      a.theme_injection_theme_id             AS "themeInjectionThemeId",
      av.semver                              AS "currentSemver",
      df.app_version_id                      AS "activeAppVersionId",
      a.uses_email                           AS "usesEmail",
      a.email_variables                      AS "emailVariables",
      a.created_at                           AS "createdAt",
      a.updated_at                           AS "updatedAt"
    FROM apps a
    LEFT JOIN deployed_functions df ON df.app_id = a.id AND df.is_active = TRUE
    LEFT JOIN app_versions av ON av.id = df.app_version_id
    WHERE a.tenant_id = ${tenantId}
      AND a.status != 'deleted'
    ORDER BY a.updated_at DESC
  `;
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenantId,
    slug: row.slug,
    name: row.name,
    status: row.status as App["status"],
    appArchetype: row.appArchetype as AppArchetype,
    widgetJs: row.widgetJs,
    adminUiJs: row.adminUiJs,
    shopifyClientId: row.shopifyClientId,
    shopifySecretName: row.shopifySecretName,
    shopDomain: row.shopDomain,
    themeInjectionStatus: (row.themeInjectionStatus ?? "none") as App["themeInjectionStatus"],
    themeInjectionThemeId: row.themeInjectionThemeId ?? null,
    currentSemver: row.currentSemver ?? null,
    activeAppVersionId: row.activeAppVersionId ?? null,
    usesEmail: row.usesEmail ?? false,
    emailVariables: row.emailVariables ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Returns the most recent execution logs across all apps for a tenant.
 */
export async function getRecentWebhookInvocationLogs(
  tenantId: string,
  limit = 20
): Promise<
  Array<{
    id: string;
    appId: string;
    appName: string;
    topic: string;
    status: string;
    durationMs: number | null;
    errorMessage: string | null;
    queuedAt: Date;
  }>
> {
  return sql<
    Array<{
      id: string;
      appId: string;
      appName: string;
      topic: string;
      status: string;
      durationMs: number | null;
      errorMessage: string | null;
      queuedAt: Date;
    }>
  >`
    SELECT
      el.id,
      el.app_id          AS "appId",
      a.name             AS "appName",
      el.topic,
      el.status,
      el.duration_ms     AS "durationMs",
      el.error_message   AS "errorMessage",
      el.queued_at       AS "queuedAt"
    FROM webhook_invocation_logs el
    JOIN apps a ON a.id = el.app_id
    WHERE el.tenant_id = ${tenantId}
    ORDER BY el.queued_at DESC
    LIMIT ${limit}
  `;
}

// ─── Widget invocation logs ───────────────────────────────────────────────────

export async function createWidgetInvocationLog(params: {
  appId: string;
  tenantId: string;
  path: string;
}): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO widget_invocation_logs (app_id, tenant_id, path, status)
    VALUES (${params.appId}, ${params.tenantId}, ${params.path}, 'running')
    RETURNING id
  `;
  return rows[0]!.id;
}

export async function updateWidgetInvocationLog(
  id: string,
  update: { status: "success" | "failed"; durationMs: number; errorMessage?: string }
): Promise<void> {
  await sql`
    UPDATE widget_invocation_logs
    SET status        = ${update.status},
        duration_ms   = ${update.durationMs},
        error_message = ${update.errorMessage ?? null}
    WHERE id = ${id}
  `;
}

export async function getWidgetInvocationLogs(
  appId: string,
  limit = 50
): Promise<Array<{ id: string; path: string; status: string; durationMs: number | null; errorMessage: string | null; invokedAt: Date }>> {
  return sql`
    SELECT id, path, status,
           duration_ms   AS "durationMs",
           error_message AS "errorMessage",
           invoked_at    AS "invokedAt"
    FROM widget_invocation_logs
    WHERE app_id = ${appId}
    ORDER BY invoked_at DESC
    LIMIT ${limit}
  `;
}

// ─── Admin invocation logs ────────────────────────────────────────────────────

export async function createAdminInvocationLog(params: {
  appId: string;
  tenantId: string;
  path: string;
}): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO admin_invocation_logs (app_id, tenant_id, path, status)
    VALUES (${params.appId}, ${params.tenantId}, ${params.path}, 'running')
    RETURNING id
  `;
  return rows[0]!.id;
}

export async function updateAdminInvocationLog(
  id: string,
  update: { status: "success" | "failed"; durationMs: number; errorMessage?: string }
): Promise<void> {
  await sql`
    UPDATE admin_invocation_logs
    SET status        = ${update.status},
        duration_ms   = ${update.durationMs},
        error_message = ${update.errorMessage ?? null}
    WHERE id = ${id}
  `;
}

export async function getAdminInvocationLogs(
  appId: string,
  limit = 50
): Promise<Array<{ id: string; path: string; status: string; durationMs: number | null; errorMessage: string | null; invokedAt: Date }>> {
  return sql`
    SELECT id, path, status,
           duration_ms   AS "durationMs",
           error_message AS "errorMessage",
           invoked_at    AS "invokedAt"
    FROM admin_invocation_logs
    WHERE app_id = ${appId}
    ORDER BY invoked_at DESC
    LIMIT ${limit}
  `;
}

/**
 * Returns dashboard stats for a tenant: app counts and execution metrics for current month.
 */
export async function getTenantStats(tenantId: string): Promise<{
  totalApps: number;
  liveApps: number;
  apiCallsThisMonth: number;
  avgResponseMs: number;
}> {
  const [appStats, execStats] = await Promise.all([
    sql<Array<{ total: string; live: string }>>`
      SELECT
        COUNT(*)                                                      AS "total",
        COUNT(*) FILTER (WHERE status = 'active')                    AS "live"
      FROM apps
      WHERE tenant_id = ${tenantId} AND status != 'deleted'
    `,
    sql<Array<{ calls: string; avgMs: string | null }>>`
      SELECT
        COUNT(*)                           AS "calls",
        AVG(duration_ms)                   AS "avgMs"
      FROM (
        SELECT duration_ms
        FROM webhook_invocation_logs
        WHERE tenant_id = ${tenantId}
          AND queued_at >= date_trunc('month', NOW())
        UNION ALL
        SELECT duration_ms
        FROM admin_invocation_logs
        WHERE tenant_id = ${tenantId}
          AND invoked_at >= date_trunc('month', NOW())
        UNION ALL
        SELECT duration_ms
        FROM widget_invocation_logs
        WHERE tenant_id = ${tenantId}
          AND invoked_at >= date_trunc('month', NOW())
      ) all_invocations
    `,
  ]);

  const appRow = appStats[0] ?? { total: "0", live: "0" };
  const execRow = execStats[0] ?? { calls: "0", avgMs: null };

  return {
    totalApps: parseInt(appRow.total, 10),
    liveApps: parseInt(appRow.live, 10),
    apiCallsThisMonth: parseInt(execRow.calls, 10),
    avgResponseMs: execRow.avgMs ? Math.round(parseFloat(execRow.avgMs)) : 0,
  };
}

/**
 * Returns all active apps with an Admin UI module for a given shop domain.
 * Used by the embedded Shopify Admin shell to populate the app sidebar.
 * Joins through tenants so the caller only needs to know the shop domain.
 */
export async function getAdminUiAppsByShop(shopDomain: string): Promise<App[]> {
  const rows = await sql<
    Array<{
      id: string;
      tenantId: string;
      slug: string;
      name: string;
      status: string;
      appArchetype: string;
      widgetJs: string | null;
      adminUiJs: string | null;
      shopifyClientId: string;
      shopifySecretName: string;
      shopDomain: string;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT
      a.id,
      a.tenant_id                            AS "tenantId",
      a.slug,
      a.name,
      a.status,
      a.app_archetype                        AS "appArchetype",
      a.widget_js                            AS "widgetJs",
      a.admin_ui_js                          AS "adminUiJs",
      a.shopify_client_id                    AS "shopifyClientId",
      a.shopify_secret_name                  AS "shopifySecretName",
      a.shop_domain                          AS "shopDomain",
      a.created_at                           AS "createdAt",
      a.updated_at                           AS "updatedAt"
    FROM apps a
    JOIN tenants t ON t.id = a.tenant_id
    WHERE t.shop_domain = ${shopDomain}
      AND a.admin_ui_js IS NOT NULL
      AND a.status != 'deleted'
    ORDER BY a.updated_at DESC
  `;
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenantId,
    slug: row.slug,
    name: row.name,
    status: row.status as App["status"],
    appArchetype: row.appArchetype as AppArchetype,
    widgetJs: row.widgetJs,
    adminUiJs: row.adminUiJs,
    shopifyClientId: row.shopifyClientId,
    shopifySecretName: row.shopifySecretName,
    shopDomain: row.shopDomain,
    themeInjectionStatus: "none" as const,
    themeInjectionThemeId: null,
    currentSemver: null,
    activeAppVersionId: null,
    usesEmail: false,
    emailVariables: [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Returns active webhook subscriptions for an app, including the Shopify webhook ID
 * needed to call the Shopify DELETE API during teardown.
 */
export async function getActiveWebhookSubscriptionsForApp(
  appId: string
): Promise<Array<{ topic: string; shopifyWebhookId: string }>> {
  return sql<Array<{ topic: string; shopifyWebhookId: string }>>`
    SELECT topic, shopify_webhook_id AS "shopifyWebhookId"
    FROM webhook_subscriptions
    WHERE app_id = ${appId} AND active = TRUE
  `;
}

/**
 * Deactivates all deployed_functions and webhook_subscriptions for an app.
 * Called during app deletion — does not remove rows so audit history is preserved.
 */
export async function deactivateAppInfrastructure(appId: string): Promise<void> {
  await sql`
    UPDATE deployed_functions
    SET is_active = FALSE
    WHERE app_id = ${appId} AND is_active = TRUE
  `;
  await sql`
    UPDATE webhook_subscriptions
    SET active = FALSE, updated_at = NOW()
    WHERE app_id = ${appId} AND active = TRUE
  `;
}

export async function getAppVersionSemvers(appId: string): Promise<string[]> {
  const rows = await sql<{ semver: string }[]>`
    SELECT semver FROM app_versions WHERE app_id = ${appId} ORDER BY created_at ASC
  `;
  return rows.map((r) => r.semver);
}

export async function getLatestMigrationSqlForApp(appId: string): Promise<string | null> {
  const rows = await sql<{ migSql: string | null }[]>`
    SELECT bundle->'dbMigration'->>'sql' AS "migSql"
    FROM generation_sessions
    WHERE app_id = ${appId}
      AND status = 'completed'
      AND bundle IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0]?.migSql ?? null;
}

/**
 * Returns the latest app_version for an app along with its deployed function URL,
 * used by reactivateApp to restart the container without rebuilding.
 */
export async function getLatestDeployedVersionForApp(appId: string): Promise<{
  appVersionId: string;
  semver: string;
  functionUrl: string;
  webhookTopics: string[];
} | null> {
  const rows = await sql<Array<{
    appVersionId: string;
    semver: string;
    functionUrl: string;
    webhookTopics: string[];
  }>>`
    SELECT
      av.id          AS "appVersionId",
      av.semver,
      df.function_url AS "functionUrl",
      COALESCE(
        (SELECT array_agg(topic) FROM webhook_subscriptions WHERE app_id = ${appId}),
        '{}'::text[]
      ) AS "webhookTopics"
    FROM app_versions av
    JOIN deployed_functions df ON df.app_version_id = av.id
    WHERE av.app_id = ${appId}
    ORDER BY av.created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function hardDeleteApp(appId: string): Promise<void> {
  // Two ON DELETE RESTRICT FKs block the cascade if we delete apps directly:
  //   webhook_subscriptions.deployed_function_id → deployed_functions(id) RESTRICT
  //   deployed_functions.app_version_id          → app_versions(id)       RESTRICT
  // Break those chains first, then let the remaining cascades handle the rest.
  await sql`DELETE FROM webhook_subscriptions WHERE app_id = ${appId}`;
  await sql`DELETE FROM deployed_functions     WHERE app_id = ${appId}`;
  await sql`DELETE FROM apps                   WHERE id    = ${appId}`;
}

export async function upsertWebhookSubscription(params: {
  appId: string;
  tenantId: string;
  deployedFunctionId: string;
  topic: string;
  shopifyWebhookId: string;
  callbackUrl: string;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO webhook_subscriptions (
      app_id, tenant_id, deployed_function_id,
      topic, shopify_webhook_id, callback_url, active
    ) VALUES (
      ${params.appId}, ${params.tenantId}, ${params.deployedFunctionId},
      ${params.topic}, ${params.shopifyWebhookId}, ${params.callbackUrl}, TRUE
    )
    ON CONFLICT (app_id, topic) DO UPDATE SET
      deployed_function_id = EXCLUDED.deployed_function_id,
      shopify_webhook_id   = EXCLUDED.shopify_webhook_id,
      callback_url         = EXCLUDED.callback_url,
      active               = TRUE,
      updated_at           = NOW()
    RETURNING id
  `;
  return { id: rows[0]!.id };
}
