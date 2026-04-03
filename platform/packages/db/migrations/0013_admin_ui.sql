-- Migration: 0013_admin_ui
-- 1. Rename app_archetype values to unified vocabulary matching the generator's appCategory.
--    Old: storefront_ui, backend_only
--    New: storefront_backend, backend, storefront_backend_admin
-- 2. Add admin_ui_js column for storefront_backend_admin apps.

-- Rename existing archetype values in-place (no enum change needed — stored as TEXT).
UPDATE apps
  SET app_archetype = CASE app_archetype
    WHEN 'storefront_ui'  THEN 'storefront_backend'
    WHEN 'backend_only'   THEN 'backend'
    ELSE app_archetype
  END
WHERE app_archetype IN ('storefront_ui', 'backend_only');

-- Add admin UI JS column (ES module string served to the Shopify admin).
ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS admin_ui_js TEXT;
