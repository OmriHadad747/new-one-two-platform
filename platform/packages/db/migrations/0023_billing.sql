-- ─── Billing & Usage Tracking ─────────────────────────────────────────────────
-- Extends the tenant model with subscription lifecycle, usage counters,
-- and revision classification for analytics.

-- ─── Plan enum ────────────────────────────────────────────────────────────────
-- Replaces the free-form TEXT plan column with a proper enum.
CREATE TYPE billing_plan AS ENUM ('free', 'starter', 'growth', 'pro');

-- ─── Subscription status ──────────────────────────────────────────────────────
CREATE TYPE subscription_status AS ENUM (
  'none',           -- no active subscription (free plan)
  'pending',        -- Shopify confirmation page shown, not yet approved
  'active',         -- approved and billing
  'frozen',         -- Shopify froze the subscription (payment failure)
  'cancelled'       -- merchant cancelled or uninstalled
);

-- ─── Revision classification ──────────────────────────────────────────────────
CREATE TYPE revision_type AS ENUM ('bug_report', 'feature_modification', 'new_capability');

-- ─── Extend tenants table ─────────────────────────────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS billing_plan billing_plan NOT NULL DEFAULT 'starter',
  ADD COLUMN IF NOT EXISTS subscription_status subscription_status NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS shopify_subscription_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS billing_cycle_anchor TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS plan_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMENT ON COLUMN tenants.billing_plan IS 'Current billing plan: free, starter, growth, pro';
COMMENT ON COLUMN tenants.subscription_status IS 'Shopify subscription lifecycle state';
COMMENT ON COLUMN tenants.shopify_subscription_id IS 'Shopify gid://shopify/AppSubscription/... ID';
COMMENT ON COLUMN tenants.trial_ends_at IS 'Trial expiry; NULL if no trial or trial ended';
COMMENT ON COLUMN tenants.billing_cycle_anchor IS 'Start of current billing period for usage counter resets';
COMMENT ON COLUMN tenants.plan_updated_at IS 'Last plan or subscription status change';

-- ─── Usage records (monthly counters) ─────────────────────────────────────────
-- One row per tenant per billing period. Counters are incremented atomically
-- via UPDATE ... SET col = col + 1. Reset by creating a new row each period.

CREATE TABLE usage_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start    DATE NOT NULL,            -- first day of billing period (e.g. 2026-04-01)
  generations     INTEGER NOT NULL DEFAULT 0,
  revisions       INTEGER NOT NULL DEFAULT 0,
  app_executions  INTEGER NOT NULL DEFAULT 0,
  emails_sent     INTEGER NOT NULL DEFAULT 0,
  sms_sent        INTEGER NOT NULL DEFAULT 0,
  files_uploaded  INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, period_start)
);

CREATE INDEX idx_usage_records_tenant_period ON usage_records (tenant_id, period_start);

COMMENT ON TABLE usage_records IS 'Monthly usage counters per tenant. One row per billing period.';

-- ─── Revision classifications (analytics) ─────────────────────────────────────
-- Tracks what type of revision each request represents. Used for analytics
-- and product improvement — NOT for billing enforcement.

CREATE TABLE revision_classifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id          UUID NOT NULL,
  session_id      UUID NULL,              -- generation session ID, if available
  job_id          TEXT NULL,              -- generation job ID
  classification  revision_type NOT NULL,
  confidence      TEXT NOT NULL DEFAULT 'high',  -- 'high' | 'medium' | 'low'
  merchant_prompt TEXT NOT NULL,          -- the revision feedback text
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_revision_classifications_tenant ON revision_classifications (tenant_id);
CREATE INDEX idx_revision_classifications_app ON revision_classifications (app_id);
CREATE INDEX idx_revision_classifications_type ON revision_classifications (classification);

COMMENT ON TABLE revision_classifications IS 'Tracks revision types for analytics and product improvement.';

-- ─── Billing events log (audit trail) ─────────────────────────────────────────
-- Immutable log of all billing state changes for debugging and reconciliation.

CREATE TABLE billing_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,           -- 'subscription_created', 'plan_upgraded', 'trial_started', etc.
  from_plan       billing_plan NULL,
  to_plan         billing_plan NULL,
  shopify_subscription_id TEXT NULL,
  metadata        JSONB NULL,              -- extra context (e.g. Shopify webhook payload)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_billing_events_tenant ON billing_events (tenant_id);

COMMENT ON TABLE billing_events IS 'Immutable audit trail of all billing state transitions.';
