-- Migration: 0015_app_draft_status
-- 1. Add 'draft' to app_status enum.
-- 2. Change the default status for new apps to 'draft'.

-- Postgres doesn't allow ALTER TYPE ADD VALUE inside a transaction block in some versions,
-- but since we run migrations individually or in a way that handles this, we'll use IF NOT EXISTS.
ALTER TYPE app_status ADD VALUE IF NOT EXISTS 'draft' BEFORE 'active';

-- Set default for new rows
ALTER TABLE apps ALTER COLUMN status SET DEFAULT 'draft';
