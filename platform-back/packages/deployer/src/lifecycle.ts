import {
  deactivateAppInfrastructure,
  getActiveWebhookSubscriptionsForApp,
  getAppById,
  getAppVersionSemvers,
  getGcsObjectsForApp,
  getLatestDeployedVersionForApp,
  getTenantById,
  hardDeleteApp,
} from "@platform-back/db";
import { deleteObjectsBatch } from "@platform-back/files";
import { logger } from "@platform-back/logger";
import { deployToCloudRun, deleteCloudRunService } from "./cloud-run-ops.js";
import { deleteServiceAccount } from "./iam-ops.js";
import { dockerImageName } from "./service-namer.js";
import { deleteDockerImage } from "./build-image.js";
import {
  registerWebhooks,
  unregisterShopifyWebhooks,
} from "./webhook-registrar.js";
import { unscheduleAppCron } from "./cron-scheduler.js";
import { dropAppTables } from "./migration-runner.js";

// App lifecycle — the teardown / reactivate / permanent-delete side of
// the deployer. The forward path (startDeploy in orchestrator.ts) builds
// an image + deploys + registers webhooks + schedules cron. These
// functions reverse those steps in the right order, non-fatally where
// possible so partial failures don't get an app stuck in a broken state.
//
// Scope note: all three functions are tenant-scoped — a mismatched
// (tenantId, appId) pair is logged and returned, never acts on another
// tenant's infra. Mirrors REFACTOR_GAPS §3 and the OLD
// platform/packages/deployer/src/index.ts shape.

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// ─── teardownApp ────────────────────────────────────────────────────────────
//
// Status transitions 'active' → 'inactive' (soft-delete stays in
// 'deleted'). Stops serving traffic and unbinds Shopify webhooks, but
// keeps the DB rows so reactivateApp can walk the history.

export interface TeardownAppInput {
  tenantId: string;
  appId: string;
}

export async function teardownApp(input: TeardownAppInput): Promise<void> {
  const { tenantId, appId } = input;
  const app = await getAppById(tenantId, appId);
  if (!app) {
    logger.warn({ tenantId, appId }, "teardownApp: app not found — skipping");
    return;
  }
  const tenant = await getTenantById(tenantId);

  // 1. Unregister Shopify webhooks.
  try {
    const webhooks = await getActiveWebhookSubscriptionsForApp(appId);
    if (webhooks.length > 0 && tenant) {
      await unregisterShopifyWebhooks({
        shopDomain: app.shopDomain,
        accessTokenSecretName: tenant.shopifyAccessTokenSecretName,
        webhooks,
      });
    }
  } catch (err) {
    logger.warn({ err, appId }, "teardownApp: webhook unregister failed");
  }

  // 2. Unschedule pg_cron tick (no-op when the app never had cron).
  try {
    await unscheduleAppCron({
      appId,
      databaseUrl: requireEnv("DATABASE_URL"),
    });
  } catch (err) {
    logger.warn({ err, appId }, "teardownApp: cron unschedule failed");
  }

  // 3. Stop the Cloud Run service (keeps the deployed_functions history).
  try {
    await deleteCloudRunService(appId);
  } catch (err) {
    logger.warn({ err, appId }, "teardownApp: Cloud Run delete failed");
  }

  // 4. Flip is_active=false on deployed_functions + webhook_subscriptions
  //    so resolveAppHandler immediately stops routing requests.
  try {
    await deactivateAppInfrastructure(appId);
  } catch (err) {
    logger.warn({ err, appId }, "teardownApp: DB deactivate failed");
  }

  logger.info({ tenantId, appId }, "teardownApp: complete");
}

// ─── reactivateApp ───────────────────────────────────────────────────────────
//
// Reverses teardownApp for a soft-deactivated app. Redeploys the existing
// image from the most-recent app_versions — does NOT rebuild, so turnaround
// is seconds not minutes. Re-registers Shopify webhooks and re-schedules
// pg_cron if the app had them.

export interface ReactivateAppInput {
  tenantId: string;
  appId: string;
}

export async function reactivateApp(
  input: ReactivateAppInput,
): Promise<{ functionUrl: string } | null> {
  const { tenantId, appId } = input;
  const app = await getAppById(tenantId, appId);
  if (!app) throw new Error(`reactivateApp: app ${appId} not found for tenant ${tenantId}`);

  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error(`reactivateApp: tenant ${tenantId} not found`);

  const latest = await getLatestDeployedVersionForApp(appId);
  if (!latest) throw new Error(`reactivateApp: no prior deploy for ${appId}`);

  const imageName = dockerImageName(appId, latest.semver);
  if (!app.handlerSaEmail) {
    throw new Error(
      `reactivateApp: app ${appId} has no handler_sa_email — provision one before reactivating`,
    );
  }

  // 1. Redeploy the existing image. Cloud Run update-or-create handles both
  //    "service still exists and paused" and "service was deleted in teardown".
  const { functionUrl } = await deployToCloudRun({
    appId,
    imageName,
    serviceAccountEmail: app.handlerSaEmail,
    envVars: buildBaselineEnv({
      tenantId,
      appId,
      shopDomain: app.shopDomain,
    }),
  });
  logger.info({ appId, functionUrl }, "reactivateApp: Cloud Run up");

  // 2. Re-register Shopify webhooks (if any). Uses the existing
  //    deployed_functions id — reactivation doesn't create a new row;
  //    the teardown only flipped is_active.
  if (latest.webhookTopics.length > 0) {
    try {
      await registerWebhooks({
        appId,
        appSlug: app.slug,
        tenantId,
        tenantSlug: tenant.slug,
        shopDomain: app.shopDomain,
        deployedFunctionId: latest.deployedFunctionId,
        webhookTopics: latest.webhookTopics,
      });
    } catch (err) {
      logger.warn({ err, appId }, "reactivateApp: webhook re-register failed");
    }
  }

  // 3. Re-schedule pg_cron if this app has a schedule. We don't have the
  //    cron expression on latest — scheduleAppCron is idempotent against
  //    the job name, so a redeploy of startDeploy would re-assert it.
  //    For reactivation of a cron app without redeploying: caller needs
  //    the expression. Left as a follow-up; for MVP, cron apps should
  //    rely on a full redeploy rather than reactivate. Logged so the
  //    gap is discoverable.
  logger.info(
    { appId },
    "reactivateApp: cron schedule NOT re-asserted — redeploy the app to restore cron",
  );

  return { functionUrl };
}

// ─── permanentDeleteApp ──────────────────────────────────────────────────────
//
// The full tear-down sequence for a DELETE /tenants/:tenantId/apps/:appId.
// Runs best-effort across every side-effectful step so a single failure
// doesn't leave the app half-deleted. The DB hard-delete at the end is
// authoritative: whatever made it to that point is gone from the source
// of truth, and the orphan side-effects are cost-only.

export interface PermanentDeleteAppInput {
  tenantId: string;
  appId: string;
}

export async function permanentDeleteApp(
  input: PermanentDeleteAppInput,
): Promise<void> {
  const { tenantId, appId } = input;
  const app = await getAppById(tenantId, appId);
  if (!app) {
    logger.warn({ tenantId, appId }, "permanentDeleteApp: app not found — skipping");
    return;
  }
  const tenant = await getTenantById(tenantId);

  // 1. Unregister Shopify webhooks. Skip cleanly when the tenant has no
  //    admin token (uninstalled app) — Shopify drops its own side anyway.
  try {
    const webhooks = await getActiveWebhookSubscriptionsForApp(appId);
    if (webhooks.length > 0 && tenant) {
      await unregisterShopifyWebhooks({
        shopDomain: app.shopDomain,
        accessTokenSecretName: tenant.shopifyAccessTokenSecretName,
        webhooks,
      });
    }
  } catch (err) {
    logger.warn({ err, appId }, "permanentDeleteApp: webhook unregister failed");
  }

  // 2. Unschedule cron.
  try {
    await unscheduleAppCron({
      appId,
      databaseUrl: requireEnv("DATABASE_URL"),
    });
  } catch (err) {
    logger.warn({ err, appId }, "permanentDeleteApp: cron unschedule failed");
  }

  // 3. Delete Cloud Run service.
  try {
    await deleteCloudRunService(appId);
  } catch (err) {
    logger.warn({ err, appId }, "permanentDeleteApp: Cloud Run delete failed");
  }

  // 4. Delete per-app service account (ok if it never existed).
  if (app.handlerSaEmail) {
    try {
      const accountId = app.handlerSaEmail.split("@")[0];
      if (accountId) await deleteServiceAccount(accountId);
    } catch (err) {
      logger.warn({ err, appId }, "permanentDeleteApp: SA delete failed");
    }
  }

  // 5. Purge Artifact Registry images for every historical version.
  try {
    const semvers = await getAppVersionSemvers(appId);
    for (const semver of semvers) {
      await deleteDockerImage(dockerImageName(appId, semver));
    }
  } catch (err) {
    logger.warn({ err, appId }, "permanentDeleteApp: image purge failed");
  }

  // 6. Batched GCS delete for every file this (tenant, app) stored. Must
  //    precede the DB hard-delete — the apps row cascade drops files rows
  //    and we'd lose gcs_object keys. See REFACTOR_GAPS §4.
  try {
    const keys = await getGcsObjectsForApp(tenantId, appId);
    if (keys.length > 0) {
      const result = await deleteObjectsBatch(keys);
      logger.info(
        { tenantId, appId, total: keys.length, ...result },
        "permanentDeleteApp: GCS batch delete",
      );
    }
  } catch (err) {
    logger.warn({ err, appId }, "permanentDeleteApp: GCS batch delete failed");
  }

  // 7. Drop every tenant-schema object this app created. Path C
  //    (REFACTOR_GAPS §6): the generator prefixes every table / view /
  //    sequence with `app_<appIdNoHyphens>_`, and dropAppTables walks
  //    pg_class for matches and drops them CASCADE. Sibling apps under
  //    the same tenant schema are untouched by construction — their
  //    prefix hashes differently. Non-fatal: a failure here leaves
  //    orphan tables but doesn't block the row delete.
  try {
    const tenantSchema = `tenant_${tenantId.replace(/-/g, "_")}`;
    const { droppedTables } = await dropAppTables({
      tenantSchema,
      appId,
      databaseUrl: requireEnv("DATABASE_URL"),
    });
    logger.info(
      { tenantId, appId, count: droppedTables.length },
      "permanentDeleteApp: per-app tables dropped",
    );
  } catch (err) {
    logger.warn({ err, appId }, "permanentDeleteApp: dropAppTables failed");
  }

  // 8. Hard-delete the apps row. FK-cascades handle files, invocation
  //    logs, generations, email_deliveries, app_versions; the helper
  //    sequences the two RESTRICT FKs (webhook_subscriptions,
  //    deployed_functions) manually.
  await hardDeleteApp(appId);

  logger.info({ tenantId, appId }, "permanentDeleteApp: complete");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Env vars every handler container needs. Scoped here (rather than reused
 * from orchestrator.ts's buildHandlerEnv) so reactivation doesn't depend
 * on the full deploy context — we only need tenant/app identity and the
 * DB URL; the rest of the handler's env comes from the SA + container
 * defaults.
 */
function buildBaselineEnv(params: {
  tenantId: string;
  appId: string;
  shopDomain: string;
}): Record<string, string> {
  return {
    NODE_ENV: "production",
    PORT: "8080",
    TENANT_ID: params.tenantId,
    APP_ID: params.appId,
    SHOP_DOMAIN: params.shopDomain,
    TENANT_SCHEMA: `tenant_${params.tenantId.replace(/-/g, "_")}`,
    DATABASE_URL: requireEnv("DATABASE_URL"),
    PLATFORM_URL: requireEnv("PLATFORM_URL"),
    EXPECTED_AUDIENCE: requireEnv("PLATFORM_URL"),
    PLATFORM_SA_EMAIL: process.env["PLATFORM_SA_EMAIL"] ?? "",
  };
}
