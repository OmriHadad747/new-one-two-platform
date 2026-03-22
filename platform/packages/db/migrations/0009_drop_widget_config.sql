-- Migration 0009: Drop orphaned widget_config column from tenants
--
-- widget_config JSONB was added in 0007_app_archetype.sql. It was superseded
-- by widget_js TEXT (added in 0008_widget_js.sql) and is no longer read or
-- written by any service. See TD-006 in TECH_DEBT.md.

ALTER TABLE tenants DROP COLUMN IF EXISTS widget_config;
