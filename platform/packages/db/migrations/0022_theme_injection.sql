-- Theme injection state on apps.
-- theme_injection_status: 'none' | 'injected'
-- theme_injection_theme_id: the Shopify theme ID of the duplicated+injected theme (numeric string)

ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS theme_injection_status TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS theme_injection_theme_id TEXT NULL;
