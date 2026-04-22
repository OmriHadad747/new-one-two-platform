import { callPlatformService } from "./platform-call.js";

export class QuotaExceeded extends Error {
  constructor(
    public readonly limit: number,
    public readonly current: number,
    /** Non-null for email (resets each billing period); null for storage (permanent cap). */
    public readonly resetsAt: string | null,
    /** Distinguishes email (monthly counter) from storage (cumulative cap). */
    public readonly kind: "email" | "storage" = "email",
  ) {
    super(
      kind === "storage"
        ? `Storage quota exceeded (${limit} bytes)`
        : `Monthly quota exceeded (${limit})`,
    );
    this.name = "QuotaExceeded";
  }
}

export type EmailSendResult =
  | { ok: true; delivered: true; deliveryId: string }
  | { ok: true; delivered: false; reason: "suppressed" | "missing_config" }
  | { ok: true; delivered: false; reason: "provider_failed" };

export interface EmailSendInput {
  to: string;
  data: Record<string, unknown>;
}

async function emailSend(input: EmailSendInput): Promise<EmailSendResult> {
  const { status, body } = await callPlatformService<
    EmailSendResult | { error: "quota_exceeded"; limit: number; current: number; resetsAt: string | null }
  >({ path: "/services/email/send", body: input });

  if (status === 200) return body as EmailSendResult;
  if (status === 429) {
    const e = body as { limit: number; current: number; resetsAt: string | null };
    throw new QuotaExceeded(e.limit, e.current, e.resetsAt);
  }
  if (status >= 500) {
    return { ok: true, delivered: false, reason: "provider_failed" };
  }
  // 400/401/403 — programming error
  throw new Error(`platform.email.send: unexpected status ${status} (${JSON.stringify(body)})`);
}

export type EmailBatchItemResult =
  | { index: number; status: 200; result: EmailSendResult }
  | { index: number; status: 429; error: "quota_exceeded"; limit: number; current: number }
  | { index: number; status: 500; error: "send_failed" };

async function emailSendBatch(items: EmailSendInput[]): Promise<{ items: EmailBatchItemResult[] }> {
  const { status, body } = await callPlatformService<{ items: EmailBatchItemResult[] }>({
    path: "/services/email/send-batch",
    body: { items },
  });
  if (status === 207) return body;
  throw new Error(`platform.email.sendBatch: unexpected status ${status} (${JSON.stringify(body)})`);
}

// ─── Files service ───────────────────────────────────────────────────────────

/**
 * Thrown when the handler tries to upload a file that exceeds the
 * platform's single-file size cap. Catch and abort the operation —
 * retrying with the same bytes will fail identically. See
 * docs/FILES_INTEGRATION.md for the current cap.
 */
export class PayloadTooLarge extends Error {
  constructor(public readonly limitBytes: number) {
    super(`Payload too large (limit: ${limitBytes} bytes)`);
    this.name = "PayloadTooLarge";
  }
}

export interface FileUploadInput {
  /** Original filename — preserved for Content-Disposition on download. */
  name: string;
  /** Binary content. Buffer and Uint8Array both work. */
  contents: Buffer | Uint8Array;
  /** MIME type; must be in the platform's allowlist. */
  mimeType: string;
}

export interface FileUploadResult {
  fileId: string;
  /** Short-lived signed URL (~15 min). Use signReadUrl for longer TTLs. */
  url: string;
  expiresAt: string;
  sizeBytes: number;
}

// Hard caps the handler must respect. upload() is for typical app-generated
// artefacts (receipts, small CSVs, thumbnails); uploadLarge() is the escape
// hatch for bulk exports, archives, and image batches. Handlers pick
// explicitly — no auto-routing — so the choice shows up in generated code
// and prompt teaching can reason about it.
const INLINE_UPLOAD_CAP_BYTES = 25 * 1024 * 1024;
const RESUMABLE_UPLOAD_CAP_BYTES = 500 * 1024 * 1024;

/**
 * Upload a small file inline. Rejects anything >=25 MiB with
 * PayloadTooLarge — use uploadLarge() for those.
 *
 * Typical callers: generated PDF receipts, small CSV exports, thumbnails,
 * short JSON bundles. Bytes transit platform-back.
 */
async function filesUpload(input: FileUploadInput): Promise<FileUploadResult> {
  const buf = Buffer.isBuffer(input.contents)
    ? input.contents
    : Buffer.from(input.contents);
  if (buf.length >= INLINE_UPLOAD_CAP_BYTES) {
    // Client-side guard — surfaces as the same error the server would
    // return, but saves the round-trip and makes the "wrong method"
    // obvious in stack traces.
    throw new PayloadTooLarge(INLINE_UPLOAD_CAP_BYTES);
  }
  return uploadInline(input, buf);
}

/**
 * Upload a large file via the resumable path. Bytes are PUT directly to
 * GCS with a signed URL; platform-back never sees the payload. Cap is
 * 500 MiB per file.
 *
 * Use only when the file genuinely exceeds the 25 MiB inline cap —
 * whole-store CSV exports, theme archives, high-res image batches.
 * Small files should use upload() so the simpler control flow wins.
 */
async function filesUploadLarge(
  input: FileUploadInput,
): Promise<FileUploadResult> {
  const buf = Buffer.isBuffer(input.contents)
    ? input.contents
    : Buffer.from(input.contents);
  if (buf.length > RESUMABLE_UPLOAD_CAP_BYTES) {
    throw new PayloadTooLarge(RESUMABLE_UPLOAD_CAP_BYTES);
  }
  return uploadResumable(input, buf);
}

async function uploadInline(
  input: FileUploadInput,
  buf: Buffer,
): Promise<FileUploadResult> {
  const body = {
    name: input.name,
    mimeType: input.mimeType,
    contents: buf.toString("base64"),
  };
  const { status, body: resp } = await callPlatformService<
    | FileUploadResult
    | { error: "payload_too_large"; limitBytes: number }
    | { error: "quota_exceeded"; usedBytes: number; limitBytes: number }
    | { error: "unsupported_mime_type"; allowed: string[] }
  >({ path: "/services/files/upload", body });

  if (status === 200) return resp as FileUploadResult;
  if (status === 413) {
    const e = resp as { limitBytes: number };
    throw new PayloadTooLarge(e.limitBytes);
  }
  if (status === 429) {
    const e = resp as { usedBytes: number; limitBytes: number };
    throw new QuotaExceeded(e.limitBytes, e.usedBytes, null, "storage");
  }
  if (status >= 500) {
    // Platform / GCS transient. Surface as a thrown error; callers that
    // want to continue without the file must catch and log.
    throw new Error(
      `platform.files.upload: transient platform error (status ${status})`,
    );
  }
  // 400 / 415 / other 4xx — programming errors (bad MIME, empty body, etc.)
  throw new Error(
    `platform.files.upload: unexpected status ${status} (${JSON.stringify(resp)})`,
  );
}

async function uploadResumable(
  input: FileUploadInput,
  buf: Buffer,
): Promise<FileUploadResult> {
  // 1. Reserve quota + get a signed PUT URL.
  const create = await callPlatformService<
    | {
        fileId: string;
        uploadUrl: string;
        requiredHeaders: Record<string, string>;
        expiresAt: string;
      }
    | { error: "payload_too_large"; limitBytes: number }
    | { error: "quota_exceeded"; usedBytes: number; limitBytes: number }
    | { error: "unsupported_mime_type"; allowed: string[] }
  >({
    path: "/services/files/create-upload-url",
    body: {
      name: input.name,
      mimeType: input.mimeType,
      expectedSizeBytes: buf.length,
    },
  });

  if (create.status === 429) {
    const e = create.body as { usedBytes: number; limitBytes: number };
    throw new QuotaExceeded(e.limitBytes, e.usedBytes, null);
  }
  // Zod schema on the backend rejects oversize with 400, not 413, but
  // surface both as PayloadTooLarge for caller simplicity.
  if (create.status === 400 || create.status === 413) {
    throw new PayloadTooLarge(
      (create.body as { limitBytes?: number }).limitBytes ??
        RESUMABLE_UPLOAD_CAP_BYTES,
    );
  }
  if (create.status !== 200) {
    throw new Error(
      `platform.files.upload (resumable create): unexpected status ${create.status} (${JSON.stringify(create.body)})`,
    );
  }

  const { fileId, uploadUrl, requiredHeaders } = create.body as {
    fileId: string;
    uploadUrl: string;
    requiredHeaders: Record<string, string>;
  };

  // Steps 2+3 are wrapped in a try/finally so a PUT or finalize failure
  // immediately releases the quota reservation via cancel-upload instead
  // of leaving the pending row for the 2-hour orphan-GC window.
  try {
    // 2. PUT bytes straight to GCS. requiredHeaders MUST be echoed —
    //    the signed URL was minted with x-goog-content-length-range, and
    //    GCS rejects the PUT without the matching header.
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: requiredHeaders,
      body: buf,
    });
    if (!putRes.ok) {
      throw new Error(
        `platform.files.upload (resumable PUT): GCS returned ${putRes.status}`,
      );
    }

    // 3. Finalize — reconciles actual size, flips row to 'active',
    //    returns the same shape as the inline path.
    const finalize = await callPlatformService<
      FileUploadResult | { error: string }
    >({
      path: "/services/files/finalize-upload",
      body: { fileId },
    });
    if (finalize.status === 200) return finalize.body as FileUploadResult;
    throw new Error(
      `platform.files.upload (resumable finalize): unexpected status ${finalize.status} (${JSON.stringify(finalize.body)})`,
    );
  } catch (err) {
    // Best-effort cancel: releases quota reservation immediately.
    // Ignore cancel errors — the upload already failed; caller gets the
    // original error regardless.
    await callPlatformService({
      path: "/services/files/cancel-upload",
      body: { fileId },
    }).catch(() => undefined);
    throw err;
  }
}

export interface FileSignReadUrlInput {
  fileId: string;
  /** Default 900 (15 min). Max 604800 (7 days). */
  expiresInSec?: number;
}

export interface FileSignReadUrlResult {
  url: string;
  expiresAt: string;
}

async function filesSignReadUrl(
  input: FileSignReadUrlInput,
): Promise<FileSignReadUrlResult> {
  const { status, body } = await callPlatformService<
    | FileSignReadUrlResult
    | { error: "not_found" }
    | { error: "invalid_expires_in"; maxSec: number }
  >({ path: "/services/files/sign-read-url", body: input });

  if (status === 200) return body as FileSignReadUrlResult;
  if (status === 404) {
    throw new Error(`platform.files.signReadUrl: file not found (${input.fileId})`);
  }
  throw new Error(
    `platform.files.signReadUrl: unexpected status ${status} (${JSON.stringify(body)})`,
  );
}

// ─── Public SDK ──────────────────────────────────────────────────────────────

export const platform = {
  email: { send: emailSend, sendBatch: emailSendBatch },
  files: {
    upload: filesUpload,
    uploadLarge: filesUploadLarge,
    signReadUrl: filesSignReadUrl,
  },
  QuotaExceeded,
  PayloadTooLarge,
};
