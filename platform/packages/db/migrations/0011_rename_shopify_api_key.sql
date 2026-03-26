-- Migration 0011: Rename apps.shopify_api_key → apps.shopify_client_id
--
-- "API key" is Shopify's legacy naming. Under the One Umbrella App model this
-- column stores the OAuth client_id shared across all platform apps, so the
-- new name better reflects its purpose.

ALTER TABLE apps RENAME COLUMN shopify_api_key TO shopify_client_id;
