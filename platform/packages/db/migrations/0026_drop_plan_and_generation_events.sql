-- Remove legacy `plan` TEXT column (superseded by billing_plan enum).
-- Remove `generation_events` table (never called in production).
ALTER TABLE tenants DROP COLUMN plan;
DROP TABLE generation_events;
