-- =============================================================================
-- Migration: 0003_secret_manager.sql
-- Description: Replace KMS-encrypted BYTEA column with a GCP Secret Manager
--              resource name reference.
--
-- Before: shopify_api_secret_encrypted BYTEA  — envelope-encrypted blob in DB
-- After:  shopify_secret_name TEXT            — Secret Manager resource name
--
-- Secret Manager resource name format:
--   projects/{project}/secrets/{name}/versions/{version}
-- e.g.: projects/my-project/secrets/shopify-webhook-app-{appId}/versions/latest
--
-- NOTE: Existing rows will have an empty shopify_secret_name. Re-provision
--       secrets in Secret Manager and update rows before marking apps active.
-- =============================================================================

ALTER TABLE apps
  DROP COLUMN shopify_api_secret_encrypted;

ALTER TABLE apps
  ADD COLUMN shopify_secret_name TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN apps.shopify_secret_name IS
  'GCP Secret Manager resource name for the Shopify webhook signing secret. '
  'Format: projects/{project}/secrets/{name}/versions/latest';
