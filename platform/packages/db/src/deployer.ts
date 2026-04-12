// ─── Deployer Queries ─────────────────────────────────────────────────────────
// These run as the platform service (no RLS). They need cross-tenant visibility
// for build orchestration. Do NOT wrap in withTenantContext.

import type {
  Tenant,
  App,
  AppVersion,
  DeployedFunction,
  DeployedFunctionRuntime,
  WebhookSubscription,
  VersionStatus,
  AppArchetype,
} from "@new-one-two/types";
import { sql } from "./connection.js";

/**
 * Fetches an AppVersion with its parent App and Tenant for the deployment pipeline.
 */
export async function getAppVersionWithCode(appVersionId: string): Promise<{
  version: AppVersion;
  app: App;
  tenant: Pick<Tenant, "id" | "slug" | "kmsKeyName" | "shopifyAccessTokenSecretName" | "storefrontAccessTokenSecretName">;
} | null> {
  const rows = await sql<
    Array<{
      versionId: string;
      versionAppId: string;
      versionTenantId: string;
      versionSemver: string;
      versionStatus: string;
      versionGeneratedCode: Record<string, string>;
      versionBuildLogs: string | null;
      versionGcsBundlePath: string | null;
      versionCreatedAt: Date;
      versionUpdatedAt: Date;
      appId: string;
      appTenantId: string;
      appSlug: string;
      appName: string;
      appStatus: string;
      appArchetype: string;
      appWidgetJs: string | null;
      appAdminUiJs: string | null;
      appShopifyClientId: string;
      appShopifySecretName: string;
      appShopifyAccessTokenSecretName: string | null;
      appShopDomain: string;
      appCreatedAt: Date;
      appUpdatedAt: Date;
      tenantId: string;
      tenantSlug: string;
      tenantKmsKeyName: string;
      tenantShopifyAccessTokenSecretName: string | null;
      tenantStorefrontAccessTokenSecretName: string | null;
    }>
  >`
    SELECT
      av.id                AS "versionId",
      av.app_id            AS "versionAppId",
      av.tenant_id         AS "versionTenantId",
      av.semver            AS "versionSemver",
      av.status            AS "versionStatus",
      av.generated_code    AS "versionGeneratedCode",
      av.build_logs        AS "versionBuildLogs",
      av.gcs_bundle_path   AS "versionGcsBundlePath",
      av.created_at        AS "versionCreatedAt",
      av.updated_at        AS "versionUpdatedAt",

      a.id                                   AS "appId",
      a.tenant_id                            AS "appTenantId",
      a.slug                                 AS "appSlug",
      a.name                                 AS "appName",
      a.status                               AS "appStatus",
      a.app_archetype                        AS "appArchetype",
      a.widget_js                            AS "appWidgetJs",
      a.admin_ui_js                          AS "appAdminUiJs",
      a.shopify_client_id                    AS "appShopifyClientId",
      a.shopify_secret_name                  AS "appShopifySecretName",
      a.shop_domain                          AS "appShopDomain",
      a.created_at                           AS "appCreatedAt",
      a.updated_at                           AS "appUpdatedAt",

      t.id                                        AS "tenantId",
      t.slug                                      AS "tenantSlug",
      t.kms_key_name                              AS "tenantKmsKeyName",
      t.shopify_access_token_secret_name          AS "tenantShopifyAccessTokenSecretName",
      t.storefront_access_token_secret_name       AS "tenantStorefrontAccessTokenSecretName"

    FROM app_versions av
    JOIN apps a ON a.id = av.app_id
    JOIN tenants t ON t.id = av.tenant_id
    WHERE av.id = ${appVersionId}
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    version: {
      id: row.versionId,
      appId: row.versionAppId,
      tenantId: row.versionTenantId,
      semver: row.versionSemver,
      status: row.versionStatus as VersionStatus,
      generatedCode: row.versionGeneratedCode,
      buildLogs: row.versionBuildLogs,
      gcsBundlePath: row.versionGcsBundlePath,
      createdAt: row.versionCreatedAt,
      updatedAt: row.versionUpdatedAt,
    },
    app: {
      id: row.appId,
      tenantId: row.appTenantId,
      slug: row.appSlug,
      name: row.appName,
      status: row.appStatus as App["status"],
      appArchetype: row.appArchetype as AppArchetype,
      widgetJs: row.appWidgetJs,
      adminUiJs: row.appAdminUiJs,
      shopifyClientId: row.appShopifyClientId,
      shopifySecretName: row.appShopifySecretName,
      shopDomain: row.appShopDomain,
      themeInjectionStatus: "none" as const,
      themeInjectionThemeId: null,
      currentSemver: null,
      activeAppVersionId: null,
      usesEmail: false,
      emailVariables: [],
      createdAt: row.appCreatedAt,
      updatedAt: row.appUpdatedAt,
    },
    tenant: {
      id: row.tenantId,
      slug: row.tenantSlug,
      kmsKeyName: row.tenantKmsKeyName,
      shopifyAccessTokenSecretName: row.tenantShopifyAccessTokenSecretName,
      storefrontAccessTokenSecretName: row.tenantStorefrontAccessTokenSecretName,
    },
  };
}

/** Fetch an app by id alone — used during teardown when tenantId is not in scope. */
export async function getAppByIdOnly(appId: string): Promise<App | null> {
  const rows = await sql<Array<{
    id: string; tenantId: string; slug: string; name: string; status: string;
    appArchetype: string; widgetJs: string | null; adminUiJs: string | null;
    shopifyClientId: string; shopifySecretName: string; shopDomain: string;
    themeInjectionStatus: string; themeInjectionThemeId: string | null;
    usesEmail: boolean; emailVariables: string[] | null;
    createdAt: Date; updatedAt: Date;
  }>>`
    SELECT id, tenant_id AS "tenantId", slug, name, status,
           app_archetype AS "appArchetype", widget_js AS "widgetJs",
           admin_ui_js AS "adminUiJs", shopify_client_id AS "shopifyClientId",
           shopify_secret_name AS "shopifySecretName", shop_domain AS "shopDomain",
           theme_injection_status AS "themeInjectionStatus",
           theme_injection_theme_id AS "themeInjectionThemeId",
           uses_email AS "usesEmail", email_variables AS "emailVariables",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM apps WHERE id = ${appId} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id, tenantId: row.tenantId, slug: row.slug, name: row.name,
    status: row.status as App["status"], appArchetype: row.appArchetype as AppArchetype,
    widgetJs: row.widgetJs, adminUiJs: row.adminUiJs, shopifyClientId: row.shopifyClientId,
    shopifySecretName: row.shopifySecretName, shopDomain: row.shopDomain,
    themeInjectionStatus: (row.themeInjectionStatus ?? "none") as App["themeInjectionStatus"],
    themeInjectionThemeId: row.themeInjectionThemeId ?? null,
    currentSemver: null,
    activeAppVersionId: null,
    usesEmail: row.usesEmail ?? false,
    emailVariables: row.emailVariables ?? [],
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

/**
 * Returns all active webhook topics across all apps for a tenant.
 * Used by the OAuth callback to re-register webhooks after re-install.
 */
export async function getActiveWebhookTopicsForTenant(
  tenantId: string
): Promise<Array<{ tenantSlug: string; appSlug: string; topic: string }>> {
  return sql<Array<{ tenantSlug: string; appSlug: string; topic: string }>>`
    SELECT DISTINCT
      t.slug  AS "tenantSlug",
      a.slug  AS "appSlug",
      ws.topic
    FROM webhook_subscriptions ws
    JOIN apps    a ON a.id  = ws.app_id
    JOIN tenants t ON t.id  = a.tenant_id
    WHERE ws.tenant_id = ${tenantId}
      AND ws.active    = TRUE
    ORDER BY a.slug, ws.topic
  `;
}

/**
 * Sets an AppVersion's build status.
 */
export async function updateVersionStatus(
  appVersionId: string,
  status: VersionStatus,
  buildLogs?: string
): Promise<void> {
  await sql`
    UPDATE app_versions
    SET
      status     = ${status},
      build_logs = ${buildLogs ?? null},
      updated_at = NOW()
    WHERE id = ${appVersionId}
  `;
}

/**
 * Atomically inserts a new deployed_functions row (is_active=true) and
 * deactivates all prior active rows for the same app. Single CTE to prevent
 * race conditions where two rows are briefly both active.
 */
export async function upsertDeployedFunction(params: {
  appVersionId: string;
  appId: string;
  tenantId: string;
  functionUrl: string;
  runtime: DeployedFunctionRuntime;
  memoryMb: number;
  timeoutSec: number;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    WITH deactivate AS (
      UPDATE deployed_functions
      SET is_active = FALSE
      WHERE app_id = ${params.appId} AND is_active = TRUE
    )
    INSERT INTO deployed_functions (
      app_version_id, app_id, tenant_id,
      function_url, runtime, memory_mb, timeout_sec,
      is_active, deployed_at
    ) VALUES (
      ${params.appVersionId}, ${params.appId}, ${params.tenantId},
      ${params.functionUrl}, ${params.runtime}, ${params.memoryMb}, ${params.timeoutSec},
      TRUE, NOW()
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}
