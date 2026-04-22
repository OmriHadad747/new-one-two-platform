import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  deleteFileRow,
  finalizeFile,
  getFileForApp,
  getFinalizableFileForApp,
  getTenantBillingPlan,
  getTenantStorageUsage,
  insertActiveFileAtomic,
  insertPendingFile,
} from "@platform-back/db";
import { getPlanLimits } from "@platform-back/types";
import {
  SKIP_GCS,
  buildObjectKey,
  createResumableUploadUrl,
  deleteObject,
  getObjectSize,
  signReadUrl,
  storeFile,
} from "@platform-back/files";
import { createRequestLogger } from "@platform-back/logger";
import { ErrorCode, errorResponse } from "../../lib/error-response.js";
import { resolveAppFromSaEmail } from "../../lib/sa-to-app.js";
import { verifyCallerIdToken } from "../../lib/verify-id-token.js";

// ─── Constants (env-tunable) ─────────────────────────────────────────────────

// Inline-path single-file cap applied AFTER base64 decode. Enforced
// belt-and-braces with Fastify's bodyLimit on the route (set below).
// Anything larger must come through the resumable path.
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MiB

// Resumable-path hard cap. GCS enforces via x-goog-content-length-range
// baked into the signed PUT URL — a handler cannot overrun this server-
// side. 500 MiB covers CSV exports / theme archives / high-res image
// batches without opening the door to video-scale uploads we don't
// want to host. Change with coordination — it affects per-tenant quota
// pre-reservations.
export const MAX_RESUMABLE_BYTES = 500 * 1024 * 1024; // 500 MiB

// Upload URL TTL: handler has one hour to complete the PUT after
// createUploadUrl returns. Any row still 'pending' past this gets
// swept by the orphan GC (see lib/files-orphan-gc.ts).
const UPLOAD_URL_TTL_SEC = 60 * 60;

// Default + hard-max TTL on signed read URLs. 15-min default keeps
// upload-returned URLs tight; 7-day cap prevents handlers from
// accidentally minting effectively-permanent links.
const DEFAULT_READ_URL_TTL_SEC = 15 * 60;
const MAX_READ_URL_TTL_SEC = 7 * 24 * 3600;

// Initial MIME allowlist — broad enough to cover typical Shopify-app
// artifacts, narrow enough to block obvious abuse. Extend via env
// (comma-separated) when a real app needs something new.
const DEFAULT_MIME_ALLOWLIST = [
  "application/pdf",
  "text/csv",
  "application/json",
  "application/zip",
  "image/png",
  "image/jpeg",
  "image/webp",
];
const MIME_ALLOWLIST = new Set(
  (process.env["FILES_MIME_ALLOWLIST"] || DEFAULT_MIME_ALLOWLIST.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// Route-level body cap. 40 MiB leaves headroom for base64 inflation
// (25 MiB binary → ~33 MiB base64 + JSON envelope). Fastify rejects
// oversize bodies with 413 before the Zod schema even sees them.
const UPLOAD_BODY_LIMIT = 40 * 1024 * 1024;

// ─── Body schemas ────────────────────────────────────────────────────────────

const UploadBodySchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(128),
  // Base64-encoded bytes. Post-parse we decode and enforce MAX_FILE_BYTES.
  // Schema cap is generous — the real guard is the decoded-size check.
  contents: z.string().min(1).max(UPLOAD_BODY_LIMIT),
});

const SignReadUrlBodySchema = z.object({
  fileId: z.string().uuid(),
  expiresInSec: z.number().int().positive().optional(),
});

const CreateUploadUrlBodySchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(128),
  expectedSizeBytes: z.number().int().positive().max(MAX_RESUMABLE_BYTES),
});

const FinalizeUploadBodySchema = z.object({
  fileId: z.string().uuid(),
});

// ─── Plugin ─────────────────────────────────────────────────────────────────

export async function filesServiceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/upload",
    { bodyLimit: UPLOAD_BODY_LIMIT },
    uploadHandler,
  );
  app.post("/sign-read-url", signReadUrlHandler);
  app.post("/create-upload-url", createUploadUrlHandler);
  app.post("/finalize-upload", finalizeUploadHandler);
}

// ─── Per-request auth ────────────────────────────────────────────────────────

interface ResolvedCaller {
  tenantId: string;
  appId: string;
}

async function resolveCaller(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ResolvedCaller | null> {
  const verified = await verifyCallerIdToken(request.headers.authorization);
  if (!verified.ok) {
    const status = verified.reason === "missing_token" ? 401 : 403;
    void reply
      .code(status)
      .send(errorResponse(ErrorCode.Unauthorized, verified.reason));
    return null;
  }
  const identity = await resolveAppFromSaEmail(verified.caller.email);
  if (!identity) {
    request.log.warn(
      { saEmail: verified.caller.email },
      "/services/files: SA email not bound to any active app",
    );
    void reply
      .code(403)
      .send(
        errorResponse(
          ErrorCode.Forbidden,
          "Caller service account is not bound to an active app",
        ),
      );
    return null;
  }
  return { tenantId: identity.tenantId, appId: identity.appId };
}

// ─── POST /services/files/upload ─────────────────────────────────────────────

async function uploadHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (SKIP_GCS) {
    return reply
      .code(501)
      .send(
        errorResponse(
          ErrorCode.Internal,
          "Files service is in skip mode (FILES_BUCKET=__skip__)",
        ),
      );
  }

  const caller = await resolveCaller(request, reply);
  if (!caller) return;

  const log = createRequestLogger({ requestId: request.id });

  const parsed = UploadBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply
      .code(400)
      .send(
        errorResponse(
          ErrorCode.InvalidRequest,
          "Invalid upload body",
          parsed.error.flatten(),
        ),
      );
  }
  const body = parsed.data;

  // 1. MIME allowlist.
  if (!MIME_ALLOWLIST.has(body.mimeType)) {
    return reply.code(415).send({
      error: "unsupported_mime_type",
      allowed: Array.from(MIME_ALLOWLIST),
    });
  }

  // 2. Decode + size check. Base64 decode failures throw — catch and 400.
  let buffer: Buffer;
  try {
    buffer = Buffer.from(body.contents, "base64");
  } catch {
    return reply
      .code(400)
      .send(errorResponse(ErrorCode.InvalidRequest, "contents is not valid base64"));
  }
  if (buffer.length === 0) {
    return reply
      .code(400)
      .send(errorResponse(ErrorCode.InvalidRequest, "contents decoded to zero bytes"));
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return reply.code(413).send({
      error: "payload_too_large",
      limitBytes: MAX_FILE_BYTES,
    });
  }

  // 3. Fast pre-check: plan-derived cap resolved per request. This catches
  //    obvious over-quota cases before the GCS put. The definitive atomic
  //    check happens in step 5 — the pre-check is a cheap optimistic guard.
  const [usage, plan] = await Promise.all([
    getTenantStorageUsage(caller.tenantId),
    getTenantBillingPlan(caller.tenantId),
  ]);
  const limit = getPlanLimits(plan).maxStorageBytes;
  if (usage + buffer.length > limit) {
    return reply.code(429).send({
      error: "quota_exceeded",
      usedBytes: usage,
      limitBytes: limit,
    });
  }

  // 4. Write to GCS. Bytes are already validated — doing this before the
  //    atomic quota check so the lock window in step 5 is as short as
  //    possible (no network I/O while holding the advisory lock).
  const fileId = randomUUID();
  const gcsObject = buildObjectKey(caller.tenantId, caller.appId, fileId);

  try {
    await storeFile({
      gcsObject,
      mimeType: body.mimeType,
      buffer,
    });
  } catch (err) {
    log.error({ err, gcsObject }, "GCS storeFile failed");
    return reply
      .code(502)
      .send(errorResponse(ErrorCode.BadGateway, "Object store write failed"));
  }

  // 5. Atomic quota check + DB insert. Uses a per-tenant advisory lock so
  //    two concurrent uploads cannot both pass the quota check. Returns null
  //    when the upload would push the tenant over the cap (race was lost).
  let record;
  try {
    record = await insertActiveFileAtomic(
      {
        id: fileId,
        tenantId: caller.tenantId,
        appId: caller.appId,
        name: body.name,
        mimeType: body.mimeType,
        sizeBytes: buffer.length,
        gcsObject,
      },
      limit,
    );
  } catch (err) {
    log.error({ err, gcsObject, fileId }, "insertActiveFileAtomic failed — deleting GCS object");
    await deleteObject(gcsObject).catch((e) =>
      log.warn({ err: e, gcsObject }, "compensating GCS delete failed"),
    );
    return reply
      .code(500)
      .send(errorResponse(ErrorCode.Internal, "Failed to record file"));
  }

  if (!record) {
    // Concurrent upload consumed the remaining quota between the pre-check
    // and the advisory lock. Compensate by deleting the GCS object we
    // already wrote.
    log.info({ gcsObject, fileId }, "quota exceeded after GCS write — compensating delete");
    await deleteObject(gcsObject).catch((e) =>
      log.warn({ err: e, gcsObject }, "compensating GCS delete failed"),
    );
    return reply.code(429).send({
      error: "quota_exceeded",
      usedBytes: limit,
      limitBytes: limit,
    });
  }

  // 5. Mint a short read URL so the caller can hand it straight to a
  //    browser. For longer-lived use (email links, archives), the
  //    handler calls /sign-read-url with a higher TTL.
  const expiresAt = new Date(Date.now() + DEFAULT_READ_URL_TTL_SEC * 1000);
  const { url } = await signReadUrl({
    gcsObject,
    name: record.name,
    mimeType: record.mimeType,
    expiresAt,
  });

  log.info(
    {
      fileId: record.id,
      tenantId: caller.tenantId,
      appId: caller.appId,
      sizeBytes: record.sizeBytes,
    },
    "file uploaded",
  );

  return reply.code(200).send({
    fileId: record.id,
    url,
    expiresAt: expiresAt.toISOString(),
    sizeBytes: record.sizeBytes,
  });
}

// ─── POST /services/files/sign-read-url ──────────────────────────────────────

async function signReadUrlHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (SKIP_GCS) {
    return reply
      .code(501)
      .send(
        errorResponse(
          ErrorCode.Internal,
          "Files service is in skip mode (FILES_BUCKET=__skip__)",
        ),
      );
  }

  const caller = await resolveCaller(request, reply);
  if (!caller) return;

  const parsed = SignReadUrlBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply
      .code(400)
      .send(
        errorResponse(
          ErrorCode.InvalidRequest,
          "Invalid sign-read-url body",
          parsed.error.flatten(),
        ),
      );
  }
  const body = parsed.data;

  const ttlSec = body.expiresInSec ?? DEFAULT_READ_URL_TTL_SEC;
  if (ttlSec > MAX_READ_URL_TTL_SEC) {
    return reply.code(400).send({
      error: "invalid_expires_in",
      maxSec: MAX_READ_URL_TTL_SEC,
    });
  }

  const record = await getFileForApp(body.fileId, caller.tenantId, caller.appId);
  if (!record) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "File not found"));
  }

  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  const { url } = await signReadUrl({
    gcsObject: record.gcsObject,
    name: record.name,
    mimeType: record.mimeType,
    expiresAt,
  });

  return reply.code(200).send({
    url,
    expiresAt: expiresAt.toISOString(),
  });
}

// ─── POST /services/files/create-upload-url ──────────────────────────────────
//
// Resumable-path entry point. Pre-reserves a files row (status='pending'),
// reserves quota against expectedSizeBytes, and hands the handler a signed
// PUT URL. Handler then PUTs directly to GCS — bytes never flow through
// platform-back.

async function createUploadUrlHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (SKIP_GCS) {
    return reply
      .code(501)
      .send(
        errorResponse(
          ErrorCode.Internal,
          "Files service is in skip mode (FILES_BUCKET=__skip__)",
        ),
      );
  }

  const caller = await resolveCaller(request, reply);
  if (!caller) return;

  const log = createRequestLogger({ requestId: request.id });

  const parsed = CreateUploadUrlBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply
      .code(400)
      .send(
        errorResponse(
          ErrorCode.InvalidRequest,
          "Invalid create-upload-url body",
          parsed.error.flatten(),
        ),
      );
  }
  const body = parsed.data;

  if (!MIME_ALLOWLIST.has(body.mimeType)) {
    return reply.code(415).send({
      error: "unsupported_mime_type",
      allowed: Array.from(MIME_ALLOWLIST),
    });
  }

  // Pre-reserve quota. Actual size may be smaller (finalize reconciles),
  // but it cannot be larger — GCS rejects over-size PUTs server-side via
  // x-goog-content-length-range.
  const [usage, plan] = await Promise.all([
    getTenantStorageUsage(caller.tenantId),
    getTenantBillingPlan(caller.tenantId),
  ]);
  const limit = getPlanLimits(plan).maxStorageBytes;
  if (usage + body.expectedSizeBytes > limit) {
    return reply.code(429).send({
      error: "quota_exceeded",
      usedBytes: usage,
      limitBytes: limit,
    });
  }

  const fileId = randomUUID();
  const gcsObject = buildObjectKey(caller.tenantId, caller.appId, fileId);

  // Insert the pending row FIRST. If the signed-URL call fails we roll
  // back the row to avoid an orphan quota reservation.
  let record;
  try {
    record = await insertPendingFile({
      id: fileId,
      tenantId: caller.tenantId,
      appId: caller.appId,
      name: body.name,
      mimeType: body.mimeType,
      sizeBytes: body.expectedSizeBytes,
      gcsObject,
    });
  } catch (err) {
    log.error({ err, gcsObject, fileId }, "insertPendingFile failed");
    return reply
      .code(500)
      .send(errorResponse(ErrorCode.Internal, "Failed to reserve file slot"));
  }

  const uploadExpiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SEC * 1000);
  try {
    const { url } = await createResumableUploadUrl({
      gcsObject,
      mimeType: body.mimeType,
      maxSizeBytes: body.expectedSizeBytes,
      expiresAt: uploadExpiresAt,
    });
    log.info(
      {
        fileId: record.id,
        tenantId: caller.tenantId,
        appId: caller.appId,
        expectedSizeBytes: body.expectedSizeBytes,
      },
      "upload URL issued",
    );
    return reply.code(200).send({
      fileId: record.id,
      uploadUrl: url,
      // The handler must echo these headers on the PUT — GCS rejects
      // otherwise. Documented so the SDK / generator can't get it wrong.
      requiredHeaders: {
        "Content-Type": body.mimeType,
        "x-goog-content-length-range": `0,${body.expectedSizeBytes}`,
      },
      expiresAt: uploadExpiresAt.toISOString(),
    });
  } catch (err) {
    // Roll the pending row back — the handler can never complete without
    // a URL, and leaving a pending row consumes quota for no reason.
    log.error({ err, gcsObject }, "createResumableUploadUrl failed; rolling back row");
    await deleteFileRow(fileId).catch((e) =>
      log.warn({ err: e, fileId }, "pending row rollback failed"),
    );
    return reply
      .code(502)
      .send(errorResponse(ErrorCode.BadGateway, "Could not mint upload URL"));
  }
}

// ─── POST /services/files/finalize-upload ────────────────────────────────────
//
// Called by the handler after the PUT succeeds. Verifies the object
// actually arrived in GCS, reconciles actual-vs-reserved size, and
// flips the row to 'active'. Returns a read URL the same shape as the
// inline /upload endpoint — the SDK hides the two-step flow.

async function finalizeUploadHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (SKIP_GCS) {
    return reply
      .code(501)
      .send(
        errorResponse(
          ErrorCode.Internal,
          "Files service is in skip mode (FILES_BUCKET=__skip__)",
        ),
      );
  }

  const caller = await resolveCaller(request, reply);
  if (!caller) return;

  const log = createRequestLogger({ requestId: request.id });

  const parsed = FinalizeUploadBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply
      .code(400)
      .send(
        errorResponse(
          ErrorCode.InvalidRequest,
          "Invalid finalize-upload body",
          parsed.error.flatten(),
        ),
      );
  }
  const { fileId } = parsed.data;

  // Accepts both 'pending' (first finalize) and 'active' (idempotent
  // re-finalize after a retry). Scoped to this caller's (tenant, app).
  const row = await getFinalizableFileForApp(
    fileId,
    caller.tenantId,
    caller.appId,
  );
  if (!row) {
    return reply
      .code(404)
      .send(errorResponse(ErrorCode.NotFound, "File not found or not finalizable"));
  }

  // Verify the object is actually in GCS. Null = handler never PUT (or
  // it failed). Treat as a client-retryable error — the row stays
  // 'pending' and the orphan GC will sweep it if finalize is never
  // called again.
  const actualSize = await getObjectSize(row.gcsObject);
  if (actualSize === null) {
    return reply.code(409).send({
      error: "upload_not_completed",
      hint: "PUT the bytes to uploadUrl before calling finalize-upload",
    });
  }

  const finalized = await finalizeFile(
    fileId,
    caller.tenantId,
    caller.appId,
    actualSize,
  );
  if (!finalized) {
    // Should be impossible — the row existed in the SELECT above.
    return reply
      .code(500)
      .send(errorResponse(ErrorCode.Internal, "Failed to finalize file"));
  }

  const expiresAt = new Date(Date.now() + DEFAULT_READ_URL_TTL_SEC * 1000);
  const { url } = await signReadUrl({
    gcsObject: finalized.gcsObject,
    name: finalized.name,
    mimeType: finalized.mimeType,
    expiresAt,
  });

  log.info(
    {
      fileId: finalized.id,
      tenantId: caller.tenantId,
      appId: caller.appId,
      sizeBytes: finalized.sizeBytes,
    },
    "file finalized",
  );

  return reply.code(200).send({
    fileId: finalized.id,
    url,
    expiresAt: expiresAt.toISOString(),
    sizeBytes: finalized.sizeBytes,
  });
}
