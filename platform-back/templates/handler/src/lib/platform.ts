import { callPlatformService } from "./platform-call.js";

export class QuotaExceeded extends Error {
  constructor(
    public readonly limit: number,
    public readonly current: number,
    public readonly resetsAt: string | null,
  ) {
    super(`Monthly quota exceeded (${limit})`);
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

async function filesUpload(input: FileUploadInput): Promise<FileUploadResult> {
  // Buffer and Uint8Array both serialize via base64; Node's Buffer handles both.
  const buf = Buffer.isBuffer(input.contents)
    ? input.contents
    : Buffer.from(input.contents);
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
    // Storage quota is long-lived (monthly-ish), not hourly like email —
    // reuse the same QuotaExceeded class with resetsAt=null.
    throw new QuotaExceeded(e.limitBytes, e.usedBytes, null);
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
  files: { upload: filesUpload, signReadUrl: filesSignReadUrl },
  QuotaExceeded,
  PayloadTooLarge,
};
