import { logger } from "@new-one-two/logger";
import { fetchDeploymentContext, parseMetadata } from "./build-context.js";
import { createBuildContext, removeBuildContext } from "./fs-builder.js";
import { dockerBuild, dockerPush, deleteDockerImage } from "./docker-ops.js";
import { deployToDockerLocal, stopDockerLocal } from "./cloud-run-dev.js";
import { deployToCloudRun, deleteCloudRunService } from "./cloud-run-ops.js";
import {
  writeDeployedFunction,
  writeWebhookSubscriptions,
  setVersionStatus,
} from "./db-writer.js";
import { dockerImageName, callbackUrl } from "./service-namer.js";
import { registerShopifyWebhooks, unregisterShopifyWebhooks } from "./shopify-webhook-registrar.js";
import { runTenantMigration, rollbackTenantMigration } from "./migration-runner.js";
import {
  createDraftAppVersion,
  updateGenerationSession,
  updateAppWidgetJs,
  updateAppAdminUiJs,
  updateAppArchetype,
  updateAppStatus,
  getActiveWebhookSubscriptionsForApp,
  deactivateAppInfrastructure,
  getTenantById,
  getAppById,
  getAppVersionSemvers,
  getLatestMigrationSqlForApp,
  hardDeleteApp,
  getLatestDeployedVersionForApp,
} from "@new-one-two/db";
import type { FeatureBundle } from "@new-one-two/types";
import { uploadWidgetJs, uploadAdminUiJs } from "./gcs-widget.js";

const DEPLOY_MODE = process.env["DEPLOY_MODE"] ?? "cloudrun";

function buildHarnessEnvVars(params: {
  tenantId: string;
  appId: string;
  shopDomain: string;
  accessTokenSecretName: string | null;
  storefrontTokenSecretName: string | null;
}): Record<string, string> {
  // When deploying locally, the harness runs inside Docker but the DB/Redis
  // are on the host. Rewrite localhost → host.docker.internal so the container
  // can reach host-bound services.
  const dockerHost = DEPLOY_MODE === "local" ? "host.docker.internal" : "localhost";
  const databaseUrl = (process.env["DATABASE_URL"] ?? "").replace(
    /(@|\/\/)localhost(:\d+)/g,
    `$1${dockerHost}$2`
  );
  const envVars: Record<string, string> = {
    TENANT_ID: params.tenantId,
    APP_ID: params.appId,
    SHOP_DOMAIN: params.shopDomain,
    DATABASE_URL: databaseUrl,
    NODE_ENV: "production",
    LOG_LEVEL: process.env["LOG_LEVEL"] ?? "info",
    SERVICE_NAME: `harness-${params.appId}`,
  };

  // Per-tenant offline access token — minted at merchant install (oauth.ts),
  // stored in Secret Manager. Absent until OAuth completes; the harness stubs
  // ctx.shopify.* when this is empty.
  if (params.accessTokenSecretName) {
    envVars["SHOPIFY_ACCESS_TOKEN_SECRET_NAME"] = params.accessTokenSecretName;
  }

  // Storefront API token — fetched lazily by the harness from Secret Manager.
  // Only injected when a storefront token was provisioned during OAuth.
  if (params.storefrontTokenSecretName) {
    envVars["STOREFRONT_TOKEN_SECRET_NAME"] = params.storefrontTokenSecretName;
  }

  // Pass dev escape hatches through to the harness container
  if (process.env["SM_DEV_SECRETS"]) {
    envVars["SM_DEV_SECRETS"] = process.env["SM_DEV_SECRETS"];
  }
  if (process.env["KMS_DEV_KEY"]) {
    envVars["KMS_DEV_KEY"] = process.env["KMS_DEV_KEY"];
  }

  return envVars;
}

export async function deployAppVersion(appVersionId: string): Promise<{
  functionUrl: string;
  deployedFunctionId: string;
}> {
  logger.info({ appVersionId }, "Starting deployment");

  const { version, app, tenant } = await fetchDeploymentContext(appVersionId);
  const { webhookTopics, npmPackages } = parseMetadata(version.generatedCode);
  const imageName = dockerImageName(app.id, version.semver);

  await setVersionStatus(appVersionId, "building");

  let buildDir: string | null = null;
  let buildOutput = "";

  try {
    // 1. Create temp build directory with harness + tenant code
    buildDir = await createBuildContext(app.id, version.semver, version.generatedCode, npmPackages);
    logger.info({ appVersionId, buildDir }, "Build context created");

    // 2. Build Docker image
    const { output } = await dockerBuild(buildDir, imageName);
    buildOutput = output;

    // 3. Push image (skipped in dev when SKIP_DOCKER_PUSH=true)
    await dockerPush(imageName);

    // 4. Deploy to Cloud Run (or local docker)
    const envVars = buildHarnessEnvVars({
      tenantId: tenant.id,
      appId: app.id,
      shopDomain: app.shopDomain,
      accessTokenSecretName: tenant.shopifyAccessTokenSecretName ?? null,
      storefrontTokenSecretName: tenant.storefrontAccessTokenSecretName ?? null,
    });

    const { functionUrl } =
      DEPLOY_MODE === "local"
        ? await deployToDockerLocal(app.id, imageName, envVars)
        : await deployToCloudRun(app.id, imageName, envVars);

    logger.info({ appVersionId, functionUrl }, "Service deployed");

    // 5. Write deployed_functions row (atomic CTE deactivates previous)
    const { id: deployedFunctionId } = await writeDeployedFunction({
      appVersionId,
      appId: app.id,
      tenantId: tenant.id,
      functionUrl,
      runtime: "nodejs20",
      memoryMb: 256,
      timeoutSec: 30,
    });

    // 6. Register webhooks with Shopify, then persist subscriptions to DB.
    //    Registration is non-fatal — a failed Shopify call falls back to a
    //    local placeholder ID so the DB row is always written.
    if (webhookTopics.length > 0) {
      const appCallbackUrl = callbackUrl(tenant.slug, app.slug);
      const shopifyWebhookIds = await registerShopifyWebhooks({
        shop: app.shopDomain,
        accessTokenSecretName: tenant.shopifyAccessTokenSecretName,
        topics: webhookTopics,
        callbackUrl: appCallbackUrl,
      });
      await writeWebhookSubscriptions({
        appId: app.id,
        tenantId: tenant.id,
        deployedFunctionId,
        topics: webhookTopics,
        callbackUrl: appCallbackUrl,
        shopifyWebhookIds,
      });
    }

    // 7. Mark version as ready
    await setVersionStatus(appVersionId, "ready", buildOutput);

    logger.info({ appVersionId, deployedFunctionId, functionUrl }, "Deployment complete");
    return { functionUrl, deployedFunctionId };
  } catch (err) {
    await setVersionStatus(
      appVersionId,
      "failed",
      buildOutput || String(err instanceof Error ? err.message : err)
    );
    throw err;
  } finally {
    if (buildDir) {
      await removeBuildContext(buildDir);
    }
  }
}

/**
 * Deploys a complete FeatureBundle produced by the Python CrewAI generator.
 *
 * Deployment sequence (atomic — rolls back migration on failure):
 *   1. Run DB migration (tenant-scoped, RLS-safe)
 *   2. Store widget JS in apps.widget_js (storefront_backend / storefront_backend_admin apps only)
 *      Served at GET /widgets/:shop/:appId.js by the webhook gateway
 *   3. Create draft AppVersion from handlerModule.code
 *   4. Build + push Docker image and deploy to Cloud Run
 *   5. Wire webhook subscriptions
 *   6. Link the generation session to the deployed AppVersion
 *
 * On failure: migration is rolled back and app returns to "ready" so the merchant
 * can retry. The generation session is NOT marked failed — generation succeeded and
 * the bundle is valid; only the infrastructure step failed.
 *
 * This function reads the app and tenant context from the DB using appId.
 */
export async function deployFeatureBundle(params: {
  sessionId: string;
  appId: string;
  tenantId: string;
  bundle: FeatureBundle;
}): Promise<{ functionUrl: string; deployedFunctionId: string }> {
  const { sessionId, appId, tenantId, bundle } = params;
  logger.info({ sessionId, appId }, "Starting FeatureBundle deployment");

  // Fetch app context for Shopify API key and shop domain
  // We reuse getAppVersionWithCode's inner query pattern via db directly
  const { sql } = await import("@new-one-two/db");
  const appRows = await sql<
    Array<{
      shopifyClientId: string;
      shopifySecretName: string;
      shopDomain: string;
      tenantSlug: string;
      appSlug: string;
    }>
  >`
    SELECT
      a.shopify_client_id     AS "shopifyClientId",
      a.shopify_secret_name AS "shopifySecretName",
      a.shop_domain         AS "shopDomain",
      t.slug AS "tenantSlug",
      a.slug AS "appSlug"
    FROM apps a
    JOIN tenants t ON t.id = a.tenant_id
    WHERE a.id = ${appId} AND a.tenant_id = ${tenantId}
    LIMIT 1
  `;

  if (appRows.length === 0) {
    throw new Error(`App ${appId} not found for tenant ${tenantId}`);
  }

  let migrationRan = false;
  // Strip surrounding quotes that the LLM sometimes emits (e.g. `""`) to avoid
  // a PostgreSQL "zero-length delimited identifier" error.
  const migrationSql = (bundle.dbMigration?.sql ?? "").trim().replace(/^"+|"+$/g, "").trim();

  try {
    // Step 1: Apply DB migration (skipped if sql is empty).
    if (migrationSql) {
      await runTenantMigration(tenantId, migrationSql);
      migrationRan = true;
    }

    // Step 2: Set archetype, store widget JS and admin UI JS.
    const archetype =
      bundle.adminUiModule != null && bundle.widgetModule != null ? "storefront_backend_admin" :
      bundle.adminUiModule != null  ? "backend_admin" :
      bundle.widgetModule  != null  ? "storefront_backend" :
      "backend";
    await updateAppArchetype(appId, archetype);
    if (bundle.widgetModule !== null) {
      await updateAppWidgetJs(appId, bundle.widgetModule);
      // Upload to GCS for production serving (skipped in local dev)
      await uploadWidgetJs(appId, bundle.widgetModule);
    }
    if (bundle.adminUiModule !== null) {
      await updateAppAdminUiJs(appId, bundle.adminUiModule);
      await uploadAdminUiJs(appId, bundle.adminUiModule);
    }

    // Step 3: Create draft AppVersion from handler code + metadata
    const { id: appVersionId } = await createDraftAppVersion({
      appId,
      tenantId,
      generatedCode: {
        "handler.js": bundle.handlerModule.code,
        "_metadata.json": JSON.stringify({
          webhookTopics: bundle.handlerModule.webhookTopics,
          cronSchedule: bundle.handlerModule.cronSchedule,
          npmPackages: bundle.handlerModule.npmPackages ?? [],
        }),
      },
    });

    // Steps 4-6: reuse existing deployAppVersion pipeline
    const result = await deployAppVersion(appVersionId);

    // Step 7: Mark app as active
    await updateAppStatus(appId, "active");

    // Step 8: Link session to the deployed version
    await updateGenerationSession(tenantId, sessionId, {
      appVersionId,
      status: "completed",
    });

    logger.info({ sessionId, appId, appVersionId }, "FeatureBundle deployed");
    return result;
  } catch (err) {
    logger.error({ err, sessionId, appId }, "FeatureBundle deployment failed");

    // Roll back DB migration if it ran but subsequent steps failed.
    if (migrationRan) {
      await rollbackTenantMigration(tenantId, migrationSql);
    }

    // Do NOT mark the session as "failed" — generation succeeded and the bundle
    // is valid. The session stays "completed". Only infrastructure failed here.
    // Return app to "ready" so the merchant can retry the deploy.
    await updateAppStatus(appId, "ready");

    throw err;
  }
}

/**
 * Reactivates a previously deactivated app:
 *   1. Restarts the container from the existing Docker image (no rebuild)
 *   2. Re-registers Shopify webhooks
 *   3. Re-activates deployed_functions + webhook_subscriptions in DB
 *   4. Marks app as active
 */
export async function reactivateApp(tenantId: string, appId: string): Promise<void> {
  // Tenant-scoped lookup: a mismatched (tenantId, appId) pair returns null
  // here instead of deactivating another tenant's infra.
  const app = await getAppById(tenantId, appId);
  if (!app) {
    throw new Error(`reactivateApp: app ${appId} not found for tenant ${tenantId}`);
  }

  const tenant = await getTenantById(app.tenantId);
  if (!tenant) {
    throw new Error(`reactivateApp: tenant not found for app ${appId}`);
  }

  const latest = await getLatestDeployedVersionForApp(appId);
  if (!latest) {
    throw new Error(`reactivateApp: no prior deployment found for app ${appId}`);
  }

  const { semver, webhookTopics } = latest;
  const imageName = dockerImageName(appId, semver);

  const envVars = buildHarnessEnvVars({
    tenantId: tenant.id,
    appId: app.id,
    shopDomain: app.shopDomain,
    accessTokenSecretName: tenant.shopifyAccessTokenSecretName ?? null,
    storefrontTokenSecretName: tenant.storefrontAccessTokenSecretName ?? null,
  });

  // 1. Restart container from existing image
  const { functionUrl } =
    DEPLOY_MODE === "local"
      ? await deployToDockerLocal(appId, imageName, envVars)
      : await deployToCloudRun(appId, imageName, envVars);

  logger.info({ appId, functionUrl }, "reactivateApp: container restarted");

  // 2. Write new deployed_functions row (deactivates previous)
  const { id: deployedFunctionId } = await writeDeployedFunction({
    appVersionId: latest.appVersionId,
    appId: app.id,
    tenantId: tenant.id,
    functionUrl,
    runtime: "nodejs20",
    memoryMb: 256,
    timeoutSec: 30,
  });

  // 3. Re-register webhooks
  if (webhookTopics.length > 0) {
    const appCallbackUrl = callbackUrl(tenant.slug, app.slug);
    const shopifyWebhookIds = await registerShopifyWebhooks({
      shop: app.shopDomain,
      accessTokenSecretName: tenant.shopifyAccessTokenSecretName,
      topics: webhookTopics,
      callbackUrl: appCallbackUrl,
    });
    await writeWebhookSubscriptions({
      appId: app.id,
      tenantId: tenant.id,
      deployedFunctionId,
      topics: webhookTopics,
      callbackUrl: appCallbackUrl,
      shopifyWebhookIds,
    });
  }

  logger.info({ appId }, "reactivateApp: app is active");
}

/**
 * Tears down all infrastructure for a deleted app:
 *   1. Unregisters Shopify webhooks
 *   2. Stops the harness (Cloud Run service or local Docker container)
 *   3. Deactivates deployed_functions + webhook_subscriptions in DB
 *
 * Non-fatal per step — logs warnings and continues so partial failures
 * don't leave the app stuck in a non-deleted state.
 */
export async function teardownApp(tenantId: string, appId: string): Promise<void> {
  // Tenant-scoped lookup: a mismatched (tenantId, appId) pair returns null
  // here instead of tearing down another tenant's infra.
  const app = await getAppById(tenantId, appId);
  if (!app) {
    logger.warn({ tenantId, appId }, "teardownApp: app not found for tenant, skipping");
    return;
  }

  const tenant = await getTenantById(app.tenantId);

  // 1. Unregister Shopify webhooks
  try {
    const webhooks = await getActiveWebhookSubscriptionsForApp(appId);
    if (webhooks.length > 0 && tenant) {
      await unregisterShopifyWebhooks({
        shop: app.shopDomain,
        accessTokenSecretName: tenant.shopifyAccessTokenSecretName,
        webhooks,
      });
    }
  } catch (err) {
    logger.warn({ err, appId }, "teardownApp: Shopify webhook unregistration failed (continuing)");
  }

  // 2. Stop the harness
  try {
    if (DEPLOY_MODE === "local") {
      await stopDockerLocal(appId);
    } else {
      await deleteCloudRunService(appId);
    }
  } catch (err) {
    logger.warn({ err, appId }, "teardownApp: harness teardown failed (continuing)");
  }

  // 3. Deactivate DB records
  try {
    await deactivateAppInfrastructure(appId);
  } catch (err) {
    logger.warn({ err, appId }, "teardownApp: DB deactivation failed (continuing)");
  }

  logger.info({ appId }, "App teardown complete");
}

/**
 * Permanently deletes an app and all its associated resources:
 *   1. Unregisters Shopify webhooks
 *   2. Stops/deletes the harness (Cloud Run service or local Docker container)
 *   3. Deletes Docker images from the registry
 *   4. Drops tenant-scoped DB tables created by the app's migration
 *   5. Hard-deletes the app row (cascades clean all related records)
 *
 * Steps 1–4 are non-fatal — failures are logged and execution continues.
 * Step 5 (DB delete) is the authoritative cleanup and will throw on failure.
 */
export async function permanentDeleteApp(tenantId: string, appId: string): Promise<void> {
  // Tenant-scoped lookup: a mismatched (tenantId, appId) pair returns null
  // here instead of deleting another tenant's app.
  const app = await getAppById(tenantId, appId);
  if (!app) {
    logger.warn({ tenantId, appId }, "permanentDeleteApp: app not found for tenant, skipping");
    return;
  }

  const tenant = await getTenantById(app.tenantId);

  // 1. Unregister Shopify webhooks
  try {
    const webhooks = await getActiveWebhookSubscriptionsForApp(appId);
    if (webhooks.length > 0 && tenant) {
      await unregisterShopifyWebhooks({
        shop: app.shopDomain,
        accessTokenSecretName: tenant.shopifyAccessTokenSecretName,
        webhooks,
      });
    }
  } catch (err) {
    logger.warn({ err, appId }, "permanentDeleteApp: Shopify webhook unregistration failed (continuing)");
  }

  // 2. Stop/delete the harness
  try {
    if (DEPLOY_MODE === "local") {
      await stopDockerLocal(appId);
    } else {
      await deleteCloudRunService(appId);
    }
  } catch (err) {
    logger.warn({ err, appId }, "permanentDeleteApp: harness teardown failed (continuing)");
  }

  // 3. Delete Docker images from the registry
  try {
    const semvers = await getAppVersionSemvers(appId);
    for (const semver of semvers) {
      await deleteDockerImage(dockerImageName(appId, semver));
    }
  } catch (err) {
    logger.warn({ err, appId }, "permanentDeleteApp: image deletion failed (continuing)");
  }

  // 4. Drop tenant-scoped tables created by the app's bundle migration
  try {
    const migrationSql = await getLatestMigrationSqlForApp(app.tenantId, appId);
    if (migrationSql) {
      await rollbackTenantMigration(app.tenantId, migrationSql);
    }
  } catch (err) {
    logger.warn({ err, appId }, "permanentDeleteApp: tenant table drop failed (continuing)");
  }

  // 5. Hard delete — cascades remove all FK-linked rows
  await hardDeleteApp(appId);

  logger.info({ appId }, "App permanently deleted");
}
