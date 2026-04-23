import type { GenerationStatus } from "@platform-back/types";
import { sql } from "./connection.js";

// Persistence for the Phase 2 `generations` table.
//
// Shape matches the migration in 0001_initial_schema.sql (see the
// GENERATIONS section). The subscriber writes here; the dashboard reads
// via getGenerationByJobId to reconstitute the deploy bundle when the
// merchant clicks Deploy.

export interface UpsertGenerationInput {
  jobId: string;
  tenantId: string;
  appId: string;
  status: GenerationStatus;
  error?: string | null;
  errorCode?: string | null;
  /** GCS path for the bundle JSON file. Null on failure. */
  bundleGcsPath?: string | null;
  /** GenerationMeta JSON. Null on failure. */
  meta?: unknown;
}

/**
 * Upsert a generation row. Pub/Sub can redeliver the same message; this
 * is idempotent on job_id so repeated deliveries produce at most one row
 * and refresh the contents only if the payload changed.
 *
 * On conflict we overwrite status / error / bundle / meta (but NOT
 * deployed / deployed_at — those are owned by the deploy flow and would
 * otherwise be nuked by a late redelivery). Conflict path also bumps
 * updated_at via the table's trigger.
 */
export async function upsertGeneration(
  input: UpsertGenerationInput,
): Promise<void> {
  // postgres.js auto-serializes JS objects to JSONB when the column type
  // is JSONB; no explicit sql.json() wrapper needed. Pre-stringify when
  // passing `unknown` values so the postgres.js parameter inference picks
  // the JSONB path regardless of the runtime shape.
  const metaJson =
    input.meta === undefined || input.meta === null
      ? null
      : JSON.stringify(input.meta);

  await sql`
    INSERT INTO generations (
      job_id, tenant_id, app_id, status, error, error_code, bundle_gcs_path, meta
    ) VALUES (
      ${input.jobId},
      ${input.tenantId},
      ${input.appId},
      ${input.status},
      ${input.error ?? null},
      ${input.errorCode ?? null},
      ${input.bundleGcsPath ?? null},
      ${metaJson}::jsonb
    )
    ON CONFLICT (job_id) DO UPDATE SET
      status          = EXCLUDED.status,
      error           = EXCLUDED.error,
      error_code      = EXCLUDED.error_code,
      bundle_gcs_path = EXCLUDED.bundle_gcs_path,
      meta            = EXCLUDED.meta
  `;
}

export interface GenerationRow {
  jobId: string;
  tenantId: string;
  appId: string;
  status: GenerationStatus;
  error: string | null;
  errorCode: string | null;
  bundleGcsPath: string | null;
  meta: unknown | null;
  deployed: boolean;
  deployedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Look up a single generation by jobId. Used by the dashboard deploy
 * button to fetch the persisted bundle before POST /apps/:appId/deploy.
 */
export async function getGenerationByJobId(
  jobId: string,
): Promise<GenerationRow | null> {
  const rows = await sql<Array<GenerationRow>>`
    SELECT
      job_id       AS "jobId",
      tenant_id    AS "tenantId",
      app_id       AS "appId",
      status,
      error,
      error_code   AS "errorCode",
      bundle_gcs_path AS "bundleGcsPath",
      meta,
      deployed,
      deployed_at  AS "deployedAt",
      created_at   AS "createdAt",
      updated_at   AS "updatedAt"
    FROM generations
    WHERE job_id = ${jobId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Flag a generation as deployed (and stamp when). Called after the
 * deploy job is successfully registered for this bundle. Cheap UI
 * bookkeeping — the source of truth for deploy history is app_versions.
 */
export async function markGenerationDeployed(jobId: string): Promise<void> {
  await sql`
    UPDATE generations
       SET deployed    = TRUE,
           deployed_at = NOW()
     WHERE job_id = ${jobId}
  `;
}

/**
 * Create a row in 'pending' status when a generation request is dispatched.
 * Updated to 'success' or 'failed' by the completed-subscriber later.
 */
export async function createPendingGeneration(input: {
  jobId: string;
  tenantId: string;
  appId: string;
}): Promise<void> {
  await sql`
    INSERT INTO generations (job_id, tenant_id, app_id, status)
    VALUES (${input.jobId}, ${input.tenantId}, ${input.appId}, 'pending')
    ON CONFLICT (job_id) DO NOTHING
  `;
}

/** Latest generation for an app (any status). */
export async function getLatestGenerationForApp(
  appId: string,
): Promise<GenerationRow | null> {
  const rows = await sql<Array<GenerationRow>>`
    SELECT
      job_id       AS "jobId",
      tenant_id    AS "tenantId",
      app_id       AS "appId",
      status,
      error,
      error_code   AS "errorCode",
      bundle_gcs_path AS "bundleGcsPath",
      meta,
      deployed,
      deployed_at  AS "deployedAt",
      created_at   AS "createdAt",
      updated_at   AS "updatedAt"
    FROM generations
    WHERE app_id = ${appId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Latest COMPLETED (status='success') generation for an app. */
export async function getLatestCompletedGenerationForApp(
  appId: string,
): Promise<GenerationRow | null> {
  const rows = await sql<Array<GenerationRow>>`
    SELECT
      job_id       AS "jobId",
      tenant_id    AS "tenantId",
      app_id       AS "appId",
      status,
      error,
      error_code   AS "errorCode",
      bundle_gcs_path AS "bundleGcsPath",
      meta,
      deployed,
      deployed_at  AS "deployedAt",
      created_at   AS "createdAt",
      updated_at   AS "updatedAt"
    FROM generations
    WHERE app_id = ${appId} AND status = 'success'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** List recent generations for an app (newest-first, limit 20). */
export async function listGenerationsForApp(
  appId: string,
  limit = 20,
): Promise<GenerationRow[]> {
  return sql<Array<GenerationRow>>`
    SELECT
      job_id       AS "jobId",
      tenant_id    AS "tenantId",
      app_id       AS "appId",
      status,
      error,
      error_code   AS "errorCode",
      bundle_gcs_path AS "bundleGcsPath",
      meta,
      deployed,
      deployed_at  AS "deployedAt",
      created_at   AS "createdAt",
      updated_at   AS "updatedAt"
    FROM generations
    WHERE app_id = ${appId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}
