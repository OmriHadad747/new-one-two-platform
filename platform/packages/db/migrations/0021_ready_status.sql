-- Migration 0021: Add 'ready' to app_status enum
--
-- 'ready' means generation completed and a bundle is stored, but the merchant
-- has not yet clicked "Deploy". It sits between 'draft' (no bundle) and 'active'
-- (deployed and live).
--
-- Transition map:
--   draft   → ready    — when generation.completed arrives with status=success
--   ready   → active   — when merchant clicks Deploy (approve endpoint)
--   ready   → draft    — if merchant discards the build (not yet implemented)
--   active  → inactive — merchant deactivates
--   *       → deleted  — soft-delete

ALTER TYPE app_status ADD VALUE IF NOT EXISTS 'ready' BEFORE 'active';

COMMENT ON TYPE app_status IS
  'draft    = created, no generation run yet
   ready    = generation succeeded, bundle stored, awaiting merchant deploy
   active   = deployed and live on the Shopify store
   inactive = manually deactivated by merchant
   deleted  = soft-deleted';
