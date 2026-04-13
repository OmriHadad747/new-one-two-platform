-- Add email-related fields to apps table that were missing from initial production schema
ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS uses_email      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_variables JSONB   NOT NULL DEFAULT '[]'::jsonb;
