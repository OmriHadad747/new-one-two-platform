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
  status: "active" | "pending" | "failed";
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
 * Insert a new active file row. Caller (the upload route) has already
 * validated MIME, size cap, and storage quota. Throws on unique-key
 * collision — gcs_object is globally unique by construction
 * (tenants/<uuid>/apps/<uuid>/<file_id>).
 */
export async function insertActiveFile(
  input: InsertFileInput,
): Promise<FileRecord> {
  const rows = await sql<FileRecord[]>`
    INSERT INTO files (
      id, tenant_id, app_id, name, mime_type, size_bytes, gcs_object, status
    ) VALUES (
      ${input.id}, ${input.tenantId}, ${input.appId},
      ${input.name}, ${input.mimeType}, ${input.sizeBytes},
      ${input.gcsObject}, 'active'
    )
    RETURNING
      id, tenant_id AS "tenantId", app_id AS "appId",
      name, mime_type AS "mimeType", size_bytes AS "sizeBytes",
      gcs_object AS "gcsObject", status, created_at AS "createdAt"
  `;
  return rows[0]!;
}

/**
 * Look up a file by its id, scoped to (tenantId, appId) to prevent a
 * handler from signing a URL for another app's file even if it guesses
 * the id. Returns null when no match.
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
 * Sum of stored bytes for this tenant across all apps. Used by the
 * upload route to pre-check quota before calling GCS.
 */
export async function getTenantStorageUsage(
  tenantId: string,
): Promise<number> {
  const rows = await sql<Array<{ total: string | null }>>`
    SELECT COALESCE(SUM(size_bytes), 0)::text AS total
      FROM files
     WHERE tenant_id = ${tenantId}
       AND status = 'active'
  `;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Per-tenant storage cap, in bytes. Owned by the tenants row so it can
 * be tuned per plan without touching files-service code.
 */
export async function getTenantStorageLimit(
  tenantId: string,
): Promise<number> {
  const rows = await sql<Array<{ limit: string | null }>>`
    SELECT storage_limit_bytes::text AS "limit"
      FROM tenants
     WHERE id = ${tenantId}
  `;
  // Fail closed: if the tenant row somehow doesn't have a limit, treat
  // as zero (blocks uploads) rather than unlimited.
  return Number(rows[0]?.limit ?? 0);
}
