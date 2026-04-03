-- Migration: 0012_storefront_token
-- Stores the GCP Secret Manager path for the Shopify Storefront API token.
-- Created at OAuth install time via POST /admin/api/.../storefront_access_tokens.json.
-- The harness resolves the actual token from Secret Manager at runtime — no plaintext
-- in the DB and no env var needed.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS storefront_access_token_secret_name TEXT;
