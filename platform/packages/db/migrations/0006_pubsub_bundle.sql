-- Migration 0006: Pub/Sub FeatureBundle correlation
--
-- Adds two columns to generation_sessions to support the async Pub/Sub pipeline:
--   job_id  — correlation UUID published in GenerationRequest and returned in FeatureBundle
--   bundle  — full FeatureBundle JSONB stored when generation.completed arrives
--
-- Additive-only (ADD COLUMN IF NOT EXISTS, no NOT NULL constraint).
-- Existing rows get NULL for both columns and continue to use the legacy deploy path.

ALTER TABLE generation_sessions
  ADD COLUMN IF NOT EXISTS job_id UUID,
  ADD COLUMN IF NOT EXISTS bundle JSONB;

-- Fast lookup when the platform receives generation.completed from Pub/Sub
CREATE INDEX IF NOT EXISTS idx_gen_sessions_job_id
  ON generation_sessions (job_id)
  WHERE job_id IS NOT NULL;

COMMENT ON COLUMN generation_sessions.job_id IS
  'Pub/Sub correlation UUID. Set when GenerationRequest is published to generation.requested topic. '
  'Matches jobId field in ProgressEvent and FeatureBundleMessage.';

COMMENT ON COLUMN generation_sessions.bundle IS
  'Full FeatureBundle JSONB received from Python generator via generation.completed topic. '
  'NULL until bundle arrives. Deployment pipeline reads handlerModule.code, dbMigration.sql, '
  'and appBlock from this column. Sessions with NULL bundle use the legacy deploy path.';
