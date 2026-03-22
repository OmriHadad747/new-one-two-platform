import { logger } from "@new-one-two/logger";
import { fetchDeploymentContext, parseMetadata } from "./build-context.js";
import { createBuildContext, removeBuildContext } from "./fs-builder.js";
import { dockerBuild, dockerPush } from "./docker-ops.js";
import { deployToDockerLocal } from "./cloud-run-dev.js";
import { deployToCloudRun } from "./cloud-run-ops.js";
import {
  writeDeployedFunction,
  writeWebhookSubscriptions,
  setVersionStatus,
} from "./db-writer.js";
import { dockerImageName, callbackUrl } from "./service-namer.js";
import { runTenantMigration, rollbackTenantMigration } from "./migration-runner.js";
import { createDraftAppVersion, updateGenerationSession, updateTenantWidgetConfig } from "@new-one-two/db";
import type { FeatureBundle } from "@new-one-two/types";

const DEPLOY_MODE = process.env["DEPLOY_MODE"] ?? "cloudrun";

function buildHarnessEnvVars(params: {
  tenantId: string;
  appId: string;
  shopDomain: string;
  accessTokenSecretName: string | null;
}): Record<string, string> {
  const envVars: Record<string, string> = {
    TENANT_ID: params.tenantId,
    APP_ID: params.appId,
    SHOP_DOMAIN: params.shopDomain,
    DATABASE_URL: process.env["DATABASE_URL"] ?? "",
    REDIS_HOST: process.env["REDIS_HOST"] ?? "redis",
    REDIS_PORT: process.env["REDIS_PORT"] ?? "6379",
    NODE_ENV: process.env["NODE_ENV"] ?? "production",
    LOG_LEVEL: process.env["LOG_LEVEL"] ?? "info",
    SERVICE_NAME: `harness-${params.appId}`,
  };

  if (params.accessTokenSecretName) {
    envVars["SHOPIFY_ACCESS_TOKEN_SECRET_NAME"] = params.accessTokenSecretName;
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
  const { webhookTopics } = parseMetadata(version.generatedCode);
  const imageName = dockerImageName(app.id, version.semver);

  await setVersionStatus(appVersionId, "building");

  let buildDir: string | null = null;
  let buildOutput = "";

  try {
    // 1. Create temp build directory with harness + tenant code
    buildDir = await createBuildContext(app.id, version.semver, version.generatedCode);
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
      accessTokenSecretName: app.shopifyAccessTokenSecretName,
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

    // 6. Wire webhook subscriptions
    if (webhookTopics.length > 0) {
      await writeWebhookSubscriptions({
        appId: app.id,
        tenantId: tenant.id,
        deployedFunctionId,
        topics: webhookTopics,
        callbackUrl: callbackUrl(tenant.slug, app.slug),
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
 *   2. Deploy App Block to Shopify Partners API
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
      shopifyApiKey: string;
      shopDomain: string;
      tenantSlug: string;
      appSlug: string;
      shopifyAccessTokenSecretName: string | null;
    }>
  >`
    SELECT
      a.shopify_api_key                  AS "shopifyApiKey",
      a.shop_domain                      AS "shopDomain",
      a.shopify_access_token_secret_name AS "shopifyAccessTokenSecretName",
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

  const app = appRows[0]!;
  let migrationRan = false;

  try {
    // Step 1: Apply DB migration (skipped if sql is empty)
    if (bundle.dbMigration.sql.trim()) {
      await runTenantMigration(tenantId, bundle.dbMigration.sql);
      migrationRan = true;
    }

    // Step 2: Store widget_config in tenant record (storefront_ui apps only).
    // The App Block is maintained separately by the platform developer and reads
    // widget_config from this endpoint at runtime via GET /widget-config.
    if (bundle.widgetConfig !== null) {
      await updateTenantWidgetConfig(tenantId, bundle.widgetConfig);
    }

    // Step 3: Create draft AppVersion from handler code
    const { id: appVersionId } = await createDraftAppVersion({
      appId,
      tenantId,
      generatedCode: { "handler.js": bundle.handlerModule.code },
    });

    // Steps 4-6: reuse existing deployAppVersion pipeline
    const result = await deployAppVersion(appVersionId);

    // Step 7: Link session to the deployed version
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
      await rollbackTenantMigration(tenantId, bundle.dbMigration.sql);
    }

    await updateGenerationSession(sessionId, {
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    });

    throw err;
  }
}
