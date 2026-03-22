-- Migration 0008: Replace widget_config JSONB with widget_js TEXT
--
-- The platform has moved from a static renderer (widget_config JSON interpreted
-- by a predefined App Block renderer) to a generated JS model (AI-produced ES
-- module loaded by a thin runtime at storefront page load time).
--
-- widget_js stores the raw JavaScript source for the tenant's active widget.
-- The old widget_config column is kept for now but will be removed in a future
-- cleanup migration (see TECH_DEBT.md TD-006).

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS widget_js TEXT;
