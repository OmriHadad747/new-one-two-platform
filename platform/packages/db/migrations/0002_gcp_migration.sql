-- =============================================================================
-- Migration: 0002_gcp_migration.sql
-- Description: Replace AWS-specific columns with GCP equivalents
-- =============================================================================

-- ─── tenants ──────────────────────────────────────────────────────────────────
-- webhook_signing_key_kms_arn (AWS ARN) → kms_key_name (GCP resource name)
-- GCP format: projects/{project}/locations/{location}/keyRings/{ring}/cryptoKeys/{key}

ALTER TABLE tenants
  RENAME COLUMN webhook_signing_key_kms_arn TO kms_key_name;

-- ─── app_versions ─────────────────────────────────────────────────────────────
-- s3_bundle_key → gcs_bundle_path (gs://bucket/...)

ALTER TABLE app_versions
  RENAME COLUMN s3_bundle_key TO gcs_bundle_path;

-- ─── deployed_functions ───────────────────────────────────────────────────────
-- lambda_arn → function_url (Cloud Run service URL)
-- Drop lambda_alias (Cloud Run uses traffic splits, not aliases)

ALTER TABLE deployed_functions
  RENAME COLUMN lambda_arn TO function_url;

ALTER TABLE deployed_functions
  DROP COLUMN lambda_alias;

-- Update runtime enum to GCP naming convention (nodejs20.x → nodejs20)
ALTER TYPE deployed_function_runtime RENAME VALUE 'nodejs20.x' TO 'nodejs20';
ALTER TYPE deployed_function_runtime RENAME VALUE 'nodejs18.x' TO 'nodejs18';

-- ─── execution_logs ───────────────────────────────────────────────────────────
-- lambda_request_id → invocation_id (Cloud Run trace/request ID)

ALTER TABLE execution_logs
  RENAME COLUMN lambda_request_id TO invocation_id;
