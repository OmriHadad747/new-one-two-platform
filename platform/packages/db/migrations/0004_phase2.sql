-- ─── Migration 0004: Phase 2 — Execution Sandbox ─────────────────────────────

-- Track Shopify API calls made by tenant handlers (billing + rate limit monitoring)
ALTER TABLE execution_logs
  ADD COLUMN shopify_api_calls INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN execution_logs.shopify_api_calls IS
  'Number of Shopify API calls made by the tenant handler during this execution.';

-- Separate OAuth access token secret from the HMAC signing secret.
-- shopify_secret_name stores the webhook HMAC signing secret.
-- shopify_access_token_secret_name stores the OAuth access token for API calls.
ALTER TABLE apps
  ADD COLUMN shopify_access_token_secret_name TEXT;

COMMENT ON COLUMN apps.shopify_access_token_secret_name IS
  'GCP Secret Manager resource name for the Shopify OAuth access token.
   Format: projects/{project}/secrets/{name}/versions/latest
   Null until the app completes OAuth installation.';
