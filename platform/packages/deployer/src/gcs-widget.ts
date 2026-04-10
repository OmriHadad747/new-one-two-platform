/**
 * Upload widget / admin-ui JS to GCS for production serving.
 *
 * In production, widgets are served via GCS (302 redirect from the API) instead
 * of reading from Postgres on every request. GCS handles caching and global
 * distribution via Google's edge infrastructure.
 *
 * In local dev (DEPLOY_MODE=local), uploads are skipped — the existing Postgres
 * fallback in the API route continues to work.
 */

import { Storage } from "@google-cloud/storage";
import { logger } from "@new-one-two/logger";

const DEPLOY_MODE = process.env["DEPLOY_MODE"] ?? "cloudrun";
const GCS_BUNDLES_BUCKET =
  process.env["GCS_BUNDLES_BUCKET"] ?? "new-one-two-bundles";
const STORAGE_EMULATOR_HOST = process.env["STORAGE_EMULATOR_HOST"];

let _storage: Storage | null = null;

function getStorage(): Storage {
  if (!_storage) {
    _storage = STORAGE_EMULATOR_HOST
      ? new Storage({ apiEndpoint: STORAGE_EMULATOR_HOST })
      : new Storage();
  }
  return _storage;
}

/**
 * Upload widget JS to GCS. Returns the public URL.
 * Skips upload in local dev mode (returns null).
 */
export async function uploadWidgetJs(
  appId: string,
  js: string
): Promise<string | null> {
  if (DEPLOY_MODE === "local") {
    logger.debug({ appId }, "Skipping GCS widget upload (local mode)");
    return null;
  }

  const storage = getStorage();
  const bucket = storage.bucket(GCS_BUNDLES_BUCKET);
  const objectPath = `widgets/${appId}/widget.js`;

  await bucket.file(objectPath).save(js, {
    contentType: "application/javascript; charset=utf-8",
    metadata: {
      cacheControl: "public, max-age=3600",
    },
    resumable: false,
  });

  const gcsUrl = `https://storage.googleapis.com/${GCS_BUNDLES_BUCKET}/${objectPath}`;
  logger.info({ appId, gcsUrl }, "Widget JS uploaded to GCS");
  return gcsUrl;
}

/**
 * Upload admin UI JS to GCS. Returns the public URL.
 * Skips upload in local dev mode (returns null).
 */
export async function uploadAdminUiJs(
  appId: string,
  js: string
): Promise<string | null> {
  if (DEPLOY_MODE === "local") {
    logger.debug({ appId }, "Skipping GCS admin UI upload (local mode)");
    return null;
  }

  const storage = getStorage();
  const bucket = storage.bucket(GCS_BUNDLES_BUCKET);
  const objectPath = `widgets/${appId}/admin-ui.js`;

  await bucket.file(objectPath).save(js, {
    contentType: "application/javascript; charset=utf-8",
    metadata: {
      cacheControl: "public, max-age=3600",
    },
    resumable: false,
  });

  const gcsUrl = `https://storage.googleapis.com/${GCS_BUNDLES_BUCKET}/${objectPath}`;
  logger.info({ appId, gcsUrl }, "Admin UI JS uploaded to GCS");
  return gcsUrl;
}
