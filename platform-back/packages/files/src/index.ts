import { Storage } from "@google-cloud/storage";
import { logger as baseLogger } from "@platform-back/logger";

// Thin GCS wrapper for the files service.
//
// Operations:
//   storeFile       — write bytes to $FILES_BUCKET under a given key
//   signReadUrl     — produce a v4-signed read URL for an existing object
//   deleteObject    — used by the uninstall flow (not the handler-facing service)
//   buildObjectKey  — canonical key format: tenants/<t>/apps/<a>/<fileId>
//
// All operations fail loudly. The bucket name is required at module
// load — a misconfigured files package should not silently no-op in
// production. Dev bypass: set FILES_BUCKET=__skip__ and the module
// becomes a stub that throws on any call. Routes check this and return
// 501 when called in skip mode.

const logger = baseLogger.child({ service: "files" });

const BUCKET_NAME = process.env["FILES_BUCKET"] ?? "";
if (!BUCKET_NAME) {
  throw new Error("FATAL: FILES_BUCKET env var must be set (or __skip__ for local dev)");
}

export const SKIP_GCS = BUCKET_NAME === "__skip__";

// Instantiate the client lazily so tests that set FILES_BUCKET=__skip__
// don't try to pick up ADC credentials they don't have.
let _storage: Storage | null = null;
function getStorage(): Storage {
  if (SKIP_GCS) {
    throw new Error(
      "files package is in skip mode (FILES_BUCKET=__skip__); refusing GCS operation",
    );
  }
  if (!_storage) _storage = new Storage();
  return _storage;
}

/**
 * Canonical key format. Never embed filename or user-controlled data in
 * the key — only platform-assigned UUIDs. Name is preserved in the DB
 * row for Content-Disposition on download.
 */
export function buildObjectKey(tenantId: string, appId: string, fileId: string): string {
  return `tenants/${tenantId}/apps/${appId}/${fileId}`;
}

export interface StoreFileInput {
  gcsObject: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * Write bytes to GCS. Overwrites any existing object at the key — the
 * caller (upload route) uses a fresh UUID per call, so collisions are
 * structurally impossible. `contentType` must be set here rather than at
 * sign time — browsers rely on it for the download behaviour.
 */
export async function storeFile(input: StoreFileInput): Promise<void> {
  const bucket = getStorage().bucket(BUCKET_NAME);
  const file = bucket.file(input.gcsObject);
  await file.save(input.buffer, {
    contentType: input.mimeType,
    resumable: false, // inline path only; see FILES_INTEGRATION.md Future work
    validation: "md5",
  });
  logger.info({ gcsObject: input.gcsObject, sizeBytes: input.buffer.length }, "GCS object stored");
}

const INLINE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

export interface SignReadUrlInput {
  gcsObject: string;
  /** Preserved on download via Content-Disposition filename=... */
  name: string;
  mimeType: string;
  /** Absolute Date when the URL expires. */
  expiresAt: Date;
  /**
   * Override the Content-Disposition disposition token.
   * Defaults to "inline" for image MIME types (admin UIs rendering
   * previews), "attachment" for everything else (forced download).
   */
  disposition?: "inline" | "attachment";
}

/**
 * Produce a v4-signed read URL. Signer identity is platform-back's own
 * service account; the signed URL carries that identity so GCS will
 * honour it regardless of the caller. Handlers never see SA credentials.
 */
export async function signReadUrl(input: SignReadUrlInput): Promise<{ url: string }> {
  const bucket = getStorage().bucket(BUCKET_NAME);
  const file = bucket.file(input.gcsObject);
  const disp =
    input.disposition ?? (INLINE_MIME_TYPES.has(input.mimeType) ? "inline" : "attachment");
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: input.expiresAt,
    responseDisposition: `${disp}; filename="${sanitizeFilename(input.name)}"`,
    responseType: input.mimeType,
  });
  return { url };
}

/**
 * Remove many objects with bounded concurrency. Used by the permanent-
 * delete flow where a single app can have hundreds of files. Best-effort:
 * individual failures are logged and swallowed, so one stuck delete
 * can't stall the whole teardown. Returns the count of successful deletes
 * so callers can log a summary.
 */
export async function deleteObjectsBatch(
  gcsObjects: readonly string[],
  { concurrency = 50 }: { concurrency?: number } = {},
): Promise<{ deleted: number; failed: number }> {
  if (SKIP_GCS || gcsObjects.length === 0) {
    return { deleted: 0, failed: 0 };
  }
  let deleted = 0;
  let failed = 0;
  const queue = [...gcsObjects];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) return;
      try {
        await deleteObject(next);
        deleted += 1;
      } catch {
        // deleteObject already warn-logged; just count.
        failed += 1;
      }
    }
  }

  const width = Math.min(concurrency, gcsObjects.length);
  await Promise.all(Array.from({ length: width }, () => worker()));
  logger.info({ total: gcsObjects.length, deleted, failed }, "batch delete done");
  return { deleted, failed };
}

/**
 * Remove a single object. Used by the uninstall flow. Ignores
 * NOT_FOUND so a second-invocation cleanup is idempotent; any other
 * error is surfaced for the caller to decide on.
 */
export async function deleteObject(gcsObject: string): Promise<void> {
  if (SKIP_GCS) return;
  const bucket = getStorage().bucket(BUCKET_NAME);
  try {
    await bucket.file(gcsObject).delete({ ignoreNotFound: true });
  } catch (err) {
    logger.warn({ err, gcsObject }, "GCS object delete failed");
    throw err;
  }
}

// ─── Resumable upload (handler → GCS direct) ─────────────────────────────────

export interface CreateResumableUploadUrlInput {
  gcsObject: string;
  mimeType: string;
  /**
   * Hard cap on the uploaded bytes. GCS enforces via the
   * `x-goog-content-length-range` extension header baked into the
   * signed URL — a PUT that sends more gets rejected server-side,
   * so a malicious handler cannot overrun the cap we reserved quota for.
   */
  maxSizeBytes: number;
  /** URL expiry. Fixed TTL from the caller; finalize must happen before this. */
  expiresAt: Date;
}

/**
 * Produce a v4-signed PUT URL for a resumable-style single-shot upload.
 *
 * We intentionally use the "signed URL PUT" flow rather than GCS's
 * multi-part resumable protocol — for files up to the 500 MiB cap
 * (the ceiling we set), a single PUT is simpler on both sides and
 * still avoids sending bytes through platform-back.
 *
 * Caller sequence:
 *   1. createResumableUploadUrl → gets uploadUrl
 *   2. handler PUTs bytes to uploadUrl with
 *         Content-Type: <mimeType>
 *         x-goog-content-length-range: 0,<maxSizeBytes>
 *   3. finalize endpoint reads actual size via getObjectSize + flips row.
 */
export async function createResumableUploadUrl(
  input: CreateResumableUploadUrlInput,
): Promise<{ url: string }> {
  const bucket = getStorage().bucket(BUCKET_NAME);
  const file = bucket.file(input.gcsObject);
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    contentType: input.mimeType,
    expires: input.expiresAt,
    // Requires the PUT to declare a Content-Length inside this range;
    // anything larger gets a 400 from GCS. Handler MUST send the
    // matching `x-goog-content-length-range: 0,<maxSizeBytes>` header.
    extensionHeaders: {
      "x-goog-content-length-range": `0,${input.maxSizeBytes}`,
    },
  });
  return { url };
}

/**
 * Read the actual byte count of an uploaded object. Used by the
 * finalize endpoint to reconcile declared vs actual size and to gate
 * the 'pending' → 'active' transition.
 *
 * Returns null when the object doesn't exist — handler never PUT the
 * bytes (crashed mid-upload, user cancelled). Finalize maps null to a
 * retry error so the handler can react.
 */
export async function getObjectSize(gcsObject: string): Promise<number | null> {
  if (SKIP_GCS) return null;
  const bucket = getStorage().bucket(BUCKET_NAME);
  const file = bucket.file(gcsObject);
  try {
    const [metadata] = await file.getMetadata();
    // GCS returns size as a string; coerce to number.
    return Number(metadata.size ?? 0);
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 404) return null;
    throw err;
  }
}

// ─── Internals ────────────────────────────────────────────────────────────────

/**
 * Filenames flow into Content-Disposition which most browsers parse
 * loosely — quotes and backslashes would break the header. Strip the
 * few characters that can unambiguously escape and trust the rest.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, "").slice(0, 255);
}
