-- Add backend_admin to the app_archetype check constraint

ALTER TABLE apps
  DROP CONSTRAINT IF EXISTS apps_app_archetype_check;

ALTER TABLE apps
  ADD CONSTRAINT apps_app_archetype_check
  CHECK (app_archetype IN ('storefront_backend', 'storefront_backend_admin', 'backend', 'backend_admin'));
