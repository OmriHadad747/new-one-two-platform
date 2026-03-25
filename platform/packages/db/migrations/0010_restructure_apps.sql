-- Migration 0010: Restructure apps/tenants for One Umbrella App model
--
-- Changes:
--   1. Move widget_js from tenants → apps  (one widget per platform app, not per tenant)
--   2. Move app_archetype from tenants → apps  (each platform app has its own archetype)
--   3. Add shop_domain + shopify_access_token_secret_name to tenants
--      (merchant-level Shopify credentials — populated on OAuth install)
--
-- The old model stored widget_js/app_archetype at the tenant level, which meant
-- all platform apps for a merchant shared one archetype and one widget. Under the
-- One Umbrella App strategy a merchant can have many independent platform apps
-- (notify-me, upsell, reviews…), each with its own archetype and widget JS.

-- ─── 1. Apps: add widget_js + app_archetype ───────────────────────────────────

ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS widget_js     TEXT,
  ADD COLUMN IF NOT EXISTS app_archetype TEXT NOT NULL DEFAULT 'backend_only'
    CHECK (app_archetype IN ('storefront_ui', 'backend_only'));

-- Migrate existing app_archetype data from tenants → apps
UPDATE apps a
SET app_archetype = t.app_archetype
FROM tenants t
WHERE a.tenant_id = t.id;

-- ─── 2. Tenants: add merchant-level Shopify fields ────────────────────────────
-- shop_domain: the merchant's myshopify.com domain — set on OAuth install.
-- shopify_access_token_secret_name: GCP Secret Manager path for the OAuth access
--   token. Separate from the per-app webhook HMAC secret (shopify_secret_name on apps).

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS shop_domain                       TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS shopify_access_token_secret_name  TEXT;

CREATE INDEX IF NOT EXISTS idx_tenants_shop_domain ON tenants (shop_domain);

-- ─── 3. Tenants: drop columns now owned by apps ──────────────────────────────

ALTER TABLE tenants
  DROP COLUMN IF EXISTS widget_js,
  DROP COLUMN IF EXISTS app_archetype;
