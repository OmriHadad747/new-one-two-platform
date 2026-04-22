import type { BillingPlan, FileStatus } from "@platform-back/types";
import { sql } from "./connection.js";

// Files-service DB helpers. See docs/FILES_INTEGRATION.md and
// migrations/0001 "FILES" section for the table shape.
//
// All helpers are narrow on purpose — the service layer
// (@platform-back/files in apps/api/src/routes/services/files.ts) owns the
// business rules (size caps, quota, MIME allowlist). This module is
// plumbing only.

export interface FileRecord {
  id: string;
  tenantId: string;
  appId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  gcsObject: string;
  status: FileStatus;
  createdAt: string;
}

export interface InsertFileInput {
  id: string; // passed in so the gcs_object key matches before insert
  tenantId: string;
  appId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  gcsObject: string;
}

/**
 * Atomically check tenant storage quota and insert an active file row
 * in a single serialized transaction.
 *
 * Uses a per-tenant advisory lock so concurrent uploads are serialized
 * for the quota-check + insert window, preventing two requests from
 * both reading usage=X and collectively exceeding the cap.
 *
 * Returns null when the upload would push the tenant over limitBytes.
 * The caller must handle null by deleting the GCS object already written
 * (compensating delete) and returning 429.
 *
 * The lock is transaction-scoped (pg_advisory_xact_lock) and releases
 * automatically on commit — no explicit unlock needed.
 */
export async function insertActiveFileAtomic(
  input: InsertFileInput,
  limitBytes: number,
): Promise<FileRecord | null> {
  const rows = await sql.begin(async (tx) => {
    // Acquire a per-tenant serialization lock. hashtext() maps the UUID
    // string to an int4; abs() keeps it positive for readability in
    // pg_locks. Two requests for the same tenant will queue here.
    await tx`SELECT pg_advisory_xact_lock(abs(hashtext(${input.tenantId})))`;

    // Conditional INSERT: only writes the row if quota allows it.
    // Counts both 'active' and 'pending' (in-flight resumable uploads
    // that have reserved quota but not yet finalized).
    return tx<FileRecord[]>`
      INSERT INTO files (
        id, tenant_id, app_id, name, mime_type, size_bytes, gcs_object, status
      )
      SELECT
        ${input.id}, ${input.tenantId}, ${input.appId},
        ${input.name}, ${input.mimeType}, ${input.sizeBytes},
        ${input.gcsObject}, 'active'
      FROM (
        SELECT COALESCE(SUM(size_bytes), 0) AS used
          FROM files
         WHERE tenant_id = ${input.tenantId}
           AND status IN ('active', 'pending')
      ) _usage
      WHERE _usage.used + ${input.sizeBytes}::bigint <= ${limitBytes}::bigint
      RETURNING
        id, tenant_id AS "tenantId", app_id AS "appId",
        name, mime_type AS "mimeType", size_bytes AS "sizeBytes",
        gcs_object AS "gcsObject", status, created_at AS "createdAt"
    `;
  });
  return rows[0] ?? null;
}

/**
 * Insert a pending file row for the resumable-upload flow. size_bytes
 * holds the *expected* size at this point (what the handler claimed);
 * finalizeFile replaces it with the actual size GCS reports.
 */
export async function insertPendingFile(
  input: InsertFileInput,
): Promise<FileRecord> {
  const rows = await sql<FileRecord[]>`
    INSERT INTO files (
      id, tenant_id, app_id, name, mime_type, size_bytes, gcs_object, status
    ) VALUES (
      ${input.id}, ${input.tenantId}, ${input.appId},
      ${input.name}, ${input.mimeType}, ${input.sizeBytes},
      ${input.gcsObject}, 'pending'
    )
    RETURNING
      id, tenant_id AS "tenantId", app_id AS "appId",
      name, mime_type AS "mimeType", size_bytes AS "sizeBytes",
      gcs_object AS "gcsObject", status, created_at AS "createdAt"
  `;
  return rows[0]!;
}

/**
 * Transition a pending row to active after the PUT completed. Updates
 * size_bytes to match what GCS actually received. Idempotent on the
 * id; a second finalize after the row has already flipped is a no-op
 * returning the current row.
 *
 * Scoped to (fileId, tenantId, appId) so a handler can't finalize a
 * file it doesn't own even if the id is somehow exposed.
 *
 * Uses a per-file advisory lock so two concurrent finalize calls
 * (e.g. a retry race) are serialized — only one runs the UPDATE
 * at a time, and the second becomes an idempotent re-flip.
 */
export async function finalizeFile(
  fileId: string,
  tenantId: string,
  appId: string,
  actualSizeBytes: number,
): Promise<FileRecord | null> {
  const rows = await sql.begin(async (tx) => {
    // Per-file lock — serializes concurrent finalize calls for the same
    // upload. hashtext maps the UUID string to an int4; abs keeps it
    // positive. Transaction-scoped, auto-released on commit.
    await tx`SELECT pg_advisory_xact_lock(abs(hashtext(${fileId})))`;
    return tx<FileRecord[]>`
      UPDATE files
         SET status = 'active',
             size_bytes = ${actualSizeBytes}
       WHERE id = ${fileId}
         AND tenant_id = ${tenantId}
         AND app_id = ${appId}
         AND status IN ('pending', 'active')
      RETURNING
        id, tenant_id AS "tenantId", app_id AS "appId",
        name, mime_type AS "mimeType", size_bytes AS "sizeBytes",
        gcs_object AS "gcsObject", status, created_at AS "createdAt"
    `;
  });
  return rows[0] ?? null;
}

/**
 * Hard-delete a file row. Used by the orphan GC sweep and by the
 * uninstall flow. Does NOT touch GCS — caller handles that separately.
 */
export async function deleteFileRow(fileId: string): Promise<void> {
  await sql`DELETE FROM files WHERE id = ${fileId}`;
}

/**
 * Every file row (any status) for this (tenant, app) pair, returning only
 * gcs_object. Feeds the eager GCS-cleanup step of permanentDeleteApp —
 * the DB rows themselves cascade away when the apps row is deleted, so
 * this query captures the object keys BEFORE the cascade makes them
 * unreadable.
 */
export async function getGcsObjectsForApp(
  tenantId: string,
  appId: string,
): Promise<string[]> {
  const rows = await sql<Array<{ gcsObject: string }>>`
    SELECT gcs_object AS "gcsObject"
      FROM files
     WHERE tenant_id = ${tenantId}
       AND app_id = ${appId}
  `;
  return rows.map((r) => r.gcsObject);
}

/**
 * Stale pending rows for the orphan GC sweep. A row is stale when it
 * was created more than `olderThanSec` seconds ago and never flipped
 * to 'active' — handler crashed between createUploadUrl and finalize,
 * upload URL expired, etc. Returned tuples feed the sweeper: it
 * deletes the GCS object (if any) and the row.
 */
export async function getStalePendingFiles(
  olderThanSec: number,
  limit: number = 500,
): Promise<Array<{ id: string; gcsObject: string }>> {
  const rows = await sql<Array<{ id: string; gcsObject: string }>>`
    SELECT id, gcs_object AS "gcsObject"
      FROM files
     WHERE status = 'pending'
       AND created_at < NOW() - make_interval(secs => ${olderThanSec})
     ORDER BY created_at
     LIMIT ${limit}
  `;
  return rows;
}

/**
 * Look up an active file by its id, scoped to (tenantId, appId) to
 * prevent a handler from signing a URL for another app's file even if
 * it guesses the id. Returns null when no match. Pending files are
 * intentionally excluded — don't hand out read URLs for bytes that
 * haven't arrived yet.
 */
export async function getFileForApp(
  fileId: string,
  tenantId: string,
  appId: string,
): Promise<FileRecord | null> {
  const rows = await sql<FileRecord[]>`
    SELECT
      id, tenant_id AS "tenantId", app_id AS "appId",
      name, mime_type AS "mimeType", size_bytes AS "sizeBytes",
      gcs_object AS "gcsObject", status, created_at AS "createdAt"
    FROM files
    WHERE id = ${fileId}
      AND tenant_id = ${tenantId}
      AND app_id = ${appId}
      AND status = 'active'
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Look up a file for the finalize-upload path. Accepts both 'pending'
 * (first finalize) and 'active' (idempotent re-finalize after retry).
 * Rejects 'failed' rows — those need an explicit cleanup, not a
 * re-finalize.
 */
export async function getFinalizableFileForApp(
  fileId: string,
  tenantId: string,
  appId: string,
): Promise<FileRecord | null> {
  const rows = await sql<FileRecord[]>`
    SELECT
      id, tenant_id AS "tenantId", app_id AS "appId",
      name, mime_type AS "mimeType", size_bytes AS "sizeBytes",
      gcs_object AS "gcsObject", status, created_at AS "createdAt"
    FROM files
    WHERE id = ${fileId}
      AND tenant_id = ${tenantId}
      AND app_id = ${appId}
      AND status IN ('pending', 'active')
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Sum of stored bytes for this tenant across all apps. Includes both
 * 'active' rows and 'pending' rows (in-flight resumable uploads that
 * have reserved quota via create-upload-url but haven't finalized yet).
 * Including pending prevents concurrent create-upload-url calls from
 * each reading usage=X and collectively blowing past the cap.
 */
export async function getTenantStorageUsage(
  tenantId: string,
): Promise<number> {
  const rows = await sql<Array<{ total: string | null }>>`
    SELECT COALESCE(SUM(size_bytes), 0)::text AS total
      FROM files
     WHERE tenant_id = ${tenantId}
       AND status IN ('active', 'pending')
  `;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Resolve this tenant's billing plan for quota checks. Returns 'free'
 * when the tenant row is missing a plan so the caller's plan-limit
 * lookup fails closed to the lowest cap rather than unlimited.
 *
 * Mirrors the plan-lookup pattern used for email/executions quotas —
 * plan → PLANS[plan].limits.*, no per-tenant limit columns on the DB.
 */
export async function getTenantBillingPlan(
  tenantId: string,
): Promise<BillingPlan> {
  const rows = await sql<Array<{ plan: BillingPlan | null }>>`
    SELECT billing_plan AS "plan"
      FROM tenants
     WHERE id = ${tenantId}
     LIMIT 1
  `;
  return rows[0]?.plan ?? "free";
}
