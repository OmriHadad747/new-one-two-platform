/**
 * Bundle storage — persists and retrieves widget.js / admin.js bundles
 * and full generation bundle JSON.
 *
 * Always uses GCS. For local dev, set STORAGE_EMULATOR_HOST=localhost:4443
 * and GCS_BUCKET=new-one-two-bundles-dev — the SDK routes to fake-gcs
 * automatically and skips Google auth.
 *
 * GCS layout:
 *   <appId>/widget.js            — served widget bundle (latest, overwritten)
 *   <appId>/admin.js             — served admin UI bundle (latest, overwritten)
 *   <jobId>/bundle.json          — full generation output (versioned by jobId)
 */

import { Storage } from "@google-cloud/storage";
import { logger as baseLogger } from "@platform-back/logger";

const log = baseLogger.child({ service: "bundle-storage" });

let _storage: Storage | null = null;

function getStorage(): Storage {
  if (!_storage) _storage = new Storage();
  return _storage;
}

function gcsBucket(): string {
  const bucket = process.env["GCS_BUCKET"];
  if (!bucket) throw new Error("GCS_BUCKET must be set");
  return bucket;
}

// ── Widget / admin bundles ────────────────────────────────────────────────────

export interface CatalogEntry {
  path: string;
  method: "GET" | "POST";
}

export interface BundlePayload {
  widgetJs?: string | null;
  adminUiJs?: string | null;
  // Slim manifests prepended to the served bundle as
  // `window.__PLATFORM_CATALOG__ = [...]`. The widget host SDK and the
  // admin bridge SDK look up `path → method` at call time so the same
  // `host.call(path, args)` signature dispatches GET-with-querystring or
  // POST-with-body automatically based on the architect's catalog
  // declaration. Empty array (or absent) ⇒ all-POST default — matches the
  // pre-method-aware-SDK behaviour for back-compat.
  widgetCatalog?: CatalogEntry[];
  adminCatalog?: CatalogEntry[];
}

function catalogPrelude(catalog: CatalogEntry[] | undefined): string {
  // Inline JSON so the bundle is self-contained — no extra GCS round-trip
  // at serve time. Prelude assigns to `window` (widget runs in the
  // storefront page; admin runs in the embedded App Bridge iframe — both
  // have a window). The SDKs check for the global at call time and fall
  // back to POST when unset.
  const slim = catalog ?? [];
  return `window.__PLATFORM_CATALOG__ = ${JSON.stringify(slim)};\n`;
}

export async function saveBundles(appId: string, bundles: BundlePayload): Promise<void> {
  const { widgetJs, adminUiJs, widgetCatalog, adminCatalog } = bundles;
  if (!widgetJs && !adminUiJs) return;

  const bucket = getStorage().bucket(gcsBucket());
  const uploads: Promise<void>[] = [];

  if (widgetJs) {
    const withPrelude = catalogPrelude(widgetCatalog) + widgetJs;
    uploads.push(
      bucket
        .file(`${appId}/widget.js`)
        .save(withPrelude, { contentType: "application/javascript", resumable: false })
        .then(() =>
          log.info(
            { appId, catalogEntries: widgetCatalog?.length ?? 0 },
            "bundle-storage: widget.js saved",
          ),
        ),
    );
  }
  if (adminUiJs) {
    const withPrelude = catalogPrelude(adminCatalog) + adminUiJs;
    uploads.push(
      bucket
        .file(`${appId}/admin.js`)
        .save(withPrelude, { contentType: "application/javascript", resumable: false })
        .then(() =>
          log.info(
            { appId, catalogEntries: adminCatalog?.length ?? 0 },
            "bundle-storage: admin.js saved",
          ),
        ),
    );
  }
  await Promise.all(uploads);
}

export async function getWidgetBundle(appId: string): Promise<string | null> {
  return downloadText(`${appId}/widget.js`);
}

export async function getAdminBundle(appId: string): Promise<string | null> {
  return downloadText(`${appId}/admin.js`);
}

// ── Generation bundles ────────────────────────────────────────────────────────

/**
 * Saves the full generation bundle JSON to GCS.
 * Returns the GCS path to store in the generations table.
 */
export async function saveGenerationBundle(jobId: string, bundle: unknown): Promise<string> {
  const gcsPath = `${jobId}/bundle.json`;
  await getStorage()
    .bucket(gcsBucket())
    .file(gcsPath)
    .save(JSON.stringify(bundle), { contentType: "application/json", resumable: false });
  log.info({ jobId }, "bundle-storage: generation bundle saved");
  return gcsPath;
}

/**
 * Downloads and parses a generation bundle from GCS.
 * Returns null when the object does not exist.
 */
export async function getGenerationBundle(gcsPath: string): Promise<unknown> {
  const text = await downloadText(gcsPath);
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

// ── Shared GCS helper ─────────────────────────────────────────────────────────

async function downloadText(gcsPath: string): Promise<string | null> {
  try {
    const [contents] = await getStorage().bucket(gcsBucket()).file(gcsPath).download();
    return contents.toString("utf-8");
  } catch (err: unknown) {
    if ((err as { code?: number }).code === 404) return null;
    throw err;
  }
}
