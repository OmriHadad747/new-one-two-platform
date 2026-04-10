-- ─── Annual Billing + Dashboard Support ───────────────────────────────────────
-- Adds billing_interval column to tenants for annual vs monthly subscriptions.

-- ─── Billing interval enum ───────────────────────────────────────────────────
CREATE TYPE billing_interval AS ENUM ('monthly', 'annual');

-- ─── Extend tenants table ─────────────────────────────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS billing_interval billing_interval NOT NULL DEFAULT 'monthly';

COMMENT ON COLUMN tenants.billing_interval IS 'Subscription billing interval: monthly or annual';
