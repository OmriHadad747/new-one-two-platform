import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  getFileForApp,
  getTenantStorageLimit,
  getTenantStorageUsage,
  insertActiveFile,
} from "@platform-back/db";
import {
  SKIP_GCS,
  buildObjectKey,
  signReadUrl,
  storeFile,
} from "@platform-back/files";
import { createRequestLogger } from "@platform-back/logger";
import { ErrorCode, errorResponse } from "../../lib/error-response.js";
import { resolveAppFromSaEmail } from "../../lib/sa-to-app.js";
import { verifyCallerIdToken } from "../../lib/verify-id-token.js";

// ─── Constants (env-tunable) ─────────────────────────────────────────────────

// Single-file cap applied AFTER base64 decode. Enforced belt-and-braces
// with Fastify's bodyLimit on the route (set below — ~1.4x bigger to
// absorb base64 expansion + envelope).
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MiB

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

// ─── Plugin ─────────────────────────────────────────────────────────────────

export async function filesServiceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/upload",
    { bodyLimit: UPLOAD_BODY_LIMIT },
    uploadHandler,
  );
  app.post("/sign-read-url", signReadUrlHandler);
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

  // 3. Tenant storage quota. Pre-check before the GCS hop so we don't
  //    store + roll back on overage.
  const [usage, limit] = await Promise.all([
    getTenantStorageUsage(caller.tenantId),
    getTenantStorageLimit(caller.tenantId),
  ]);
  if (usage + buffer.length > limit) {
    return reply.code(429).send({
      error: "quota_exceeded",
      usedBytes: usage,
      limitBytes: limit,
    });
  }

  // 4. Write to GCS, then record in DB. If the DB insert fails after
  //    the GCS put, we have an orphan object. Rare; resolved by the
  //    future orphan-GC sweeper (see FILES_INTEGRATION.md Future work).
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

  let record;
  try {
    record = await insertActiveFile({
      id: fileId,
      tenantId: caller.tenantId,
      appId: caller.appId,
      name: body.name,
      mimeType: body.mimeType,
      sizeBytes: buffer.length,
      gcsObject,
    });
  } catch (err) {
    log.error(
      { err, gcsObject, fileId },
      "insertActiveFile failed after GCS write — object now orphaned",
    );
    return reply
      .code(500)
      .send(errorResponse(ErrorCode.Internal, "Failed to record file"));
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
