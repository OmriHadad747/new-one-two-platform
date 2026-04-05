-- The shopify_access_token_secret_name column on apps is unused.
-- The OAuth access token is a tenant-level secret; all apps under a tenant
-- share the same Shopify installation and therefore the same token.
-- The authoritative value lives on tenants.shopify_access_token_secret_name.

ALTER TABLE apps DROP COLUMN IF EXISTS shopify_access_token_secret_name;
