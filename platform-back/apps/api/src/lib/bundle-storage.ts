/**
 * Bundle storage — persists and retrieves widget.js / admin.js bundles.
 *
 * Development (NODE_ENV != "production"):
 *   Reads and writes apps.widget_js / apps.admin_ui_js columns directly.
 *   No GCS dependency; fast for local iteration.
 *
 * Production:
 *   Uploads to GCS at deterministic paths:
 *     <GCS_BUCKET>/<appId>/widget.js
 *     <GCS_BUCKET>/<appId>/admin.js
 *   Files are stored as text/javascript with public-read ACL so they can
 *   be served directly from GCS or via the serving endpoints below.
 *   DB columns are NOT used in production.
 */

import { Storage } from "@google-cloud/storage";
import { getAppBundles, updateAppBundles } from "@platform-back/db";
import { logger as baseLogger } from "@platform-back/logger";

const log = baseLogger.child({ service: "bundle-storage" });

const IS_PROD = process.env["NODE_ENV"] === "production";

// ── GCS client (initialised lazily, only in production) ───────────────────────

let _storage: Storage | null = null;

function getStorage(): Storage {
  if (!_storage) {
    _storage = new Storage();
  }
  return _storage;
}

function gcsBucket(): string {
  const bucket = process.env["GCS_BUCKET"];
  if (!bucket) throw new Error("GCS_BUCKET must be set in production");
  return bucket;
}

function widgetPath(appId: string): string {
  return `${appId}/widget.js`;
}

function adminPath(appId: string): string {
  return `${appId}/admin.js`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface BundlePayload {
  widgetJs?: string | null;
  adminUiJs?: string | null;
}

/**
 * Persist widget/admin bundles for an app.
 * Skips keys that are null/undefined — partial updates are safe.
 */
export async function saveBundles(
  appId: string,
  bundles: BundlePayload,
): Promise<void> {
  const { widgetJs, adminUiJs } = bundles;
  if (!widgetJs && !adminUiJs) return;

  if (IS_PROD) {
    const bucket = getStorage().bucket(gcsBucket());
    const uploads: Promise<void>[] = [];
    if (widgetJs) {
      uploads.push(
        bucket
          .file(widgetPath(appId))
          .save(widgetJs, { contentType: "application/javascript", resumable: false })
          .then(() => {
            log.info({ appId }, "bundle-storage: widget.js uploaded to GCS");
          }),
      );
    }
    if (adminUiJs) {
      uploads.push(
        bucket
          .file(adminPath(appId))
          .save(adminUiJs, { contentType: "application/javascript", resumable: false })
          .then(() => {
            log.info({ appId }, "bundle-storage: admin.js uploaded to GCS");
          }),
      );
    }
    await Promise.all(uploads);
  } else {
    await updateAppBundles(appId, {
      ...(widgetJs != null ? { widgetJs } : {}),
      ...(adminUiJs != null ? { adminUiJs } : {}),
    });
    log.info(
      { appId, hasWidget: Boolean(widgetJs), hasAdmin: Boolean(adminUiJs) },
      "bundle-storage: bundles written to DB",
    );
  }
}

/**
 * Retrieve the widget bundle for an app.
 * Returns null when no bundle has been stored yet.
 */
export async function getWidgetBundle(appId: string): Promise<string | null> {
  if (IS_PROD) {
    return downloadGcs(appId, widgetPath(appId));
  }
  const row = await getAppBundles(appId);
  return row?.widgetJs ?? null;
}

/**
 * Retrieve the admin UI bundle for an app.
 * Returns null when no bundle has been stored yet.
 */
export async function getAdminBundle(appId: string): Promise<string | null> {
  if (IS_PROD) {
    return downloadGcs(appId, adminPath(appId));
  }
  const row = await getAppBundles(appId);
  return row?.adminUiJs ?? null;
}

// ── GCS helpers ───────────────────────────────────────────────────────────────

async function downloadGcs(appId: string, gcsPath: string): Promise<string | null> {
  try {
    const [contents] = await getStorage()
      .bucket(gcsBucket())
      .file(gcsPath)
      .download();
    return contents.toString("utf-8");
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code === 404) {
      log.info({ appId, gcsPath }, "bundle-storage: GCS object not found");
      return null;
    }
    throw err;
  }
}
