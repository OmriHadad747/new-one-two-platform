import { logger } from "@new-one-two/logger";
import { fetchDeploymentContext, parseMetadata } from "./build-context.js";
import { createBuildContext, removeBuildContext } from "./fs-builder.js";
import { dockerBuild, dockerPush } from "./docker-ops.js";
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
  getAppByIdOnly,
} from "@new-one-two/db";
import type { FeatureBundle } from "@new-one-two/types";

const DEPLOY_MODE = process.env["DEPLOY_MODE"] ?? "cloudrun";

function buildHarnessEnvVars(params: {
  tenantId: string;
  appId: string;
  shopDomain: string;
  clientId: string;
  clientSecretName: string;
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
    SHOPIFY_CLIENT_ID: params.clientId,
    SHOPIFY_CLIENT_SECRET_NAME: params.clientSecretName,
    DATABASE_URL: databaseUrl,
    NODE_ENV: "production",
    LOG_LEVEL: process.env["LOG_LEVEL"] ?? "info",
    SERVICE_NAME: `harness-${params.appId}`,
  };

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
      clientId: app.shopifyClientId,
      clientSecretName: app.shopifySecretName,
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
 *   6. Update generation_session status to completed
 *
 * This function reads the app and tenant context from the DB using appId.
 * The sessionId is used to update the generation_sessions row on success.
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
    }
    if (bundle.adminUiModule !== null) {
      await updateAppAdminUiJs(appId, bundle.adminUiModule);
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
    await updateGenerationSession(sessionId, {
      appVersionId,
      status: "completed",
    });

    logger.info({ sessionId, appId, appVersionId }, "FeatureBundle deployed");
    return result;
  } catch (err) {
    logger.error({ err, sessionId, appId }, "FeatureBundle deployment failed");

    // Roll back DB migration if it ran but subsequent steps failed
    if (migrationRan) {
      await rollbackTenantMigration(tenantId, migrationSql);
    }

    await updateGenerationSession(sessionId, {
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    });

    throw err;
  }
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
export async function teardownApp(appId: string): Promise<void> {
  const app = await getAppByIdOnly(appId);
  if (!app) {
    logger.warn({ appId }, "teardownApp: app not found, skipping");
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
