-- Phase 0: Add app_archetype + widget_config to tenants table
-- app_archetype: 'storefront_ui' (has App Block) or 'backend_only' (pure backend)
-- widget_config: JSONB config served to the App Block renderer at runtime (null for backend_only)
-- Existing tenants default to backend_only (safe — no storefront UI was previously generated)

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS app_archetype TEXT NOT NULL
    DEFAULT 'backend_only'
    CHECK (app_archetype IN ('storefront_ui', 'backend_only')),
  ADD COLUMN IF NOT EXISTS widget_config JSONB;
