-- =============================================================================
-- Migration: 0025_email_integration.sql
-- Description: Platform-owned email service. Adds tenant-level brand storage,
--              per-app email configuration, delivery tracking, and per-tenant
--              suppression list. Also flags `apps.uses_email` so the dashboard
--              can conditionally show the Email tab and block deploy until the
--              merchant confirms email content.
--
-- See docs/EMAIL_INTEGRATION_PLAN.md for the full execution plan.
-- =============================================================================

-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE email_type AS ENUM ('transactional', 'marketing');

CREATE TYPE email_delivery_status AS ENUM (
  'queued',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed'
);

CREATE TYPE email_suppression_reason AS ENUM (
  'unsubscribed',
  'bounced',
  'complained',
  'manual'
);

-- =============================================================================
-- TENANT BRANDS
-- One row per tenant. Shared across all the tenant's email-using apps.
-- All fields nullable — service falls back to platform defaults if missing.
-- =============================================================================

CREATE TABLE tenant_brands (
  tenant_id     UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  logo_url      TEXT NULL,
  primary_color TEXT NULL,                      -- hex color, e.g. '#1a73e8'
  footer_text   TEXT NULL,                      -- business info shown in email footer
  support_email TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tenant_brands IS 'Tenant-level brand shared across all email-using apps. One row per tenant.';
COMMENT ON COLUMN tenant_brands.logo_url IS 'URL of merchant logo used in email header. NULL → platform default.';
COMMENT ON COLUMN tenant_brands.primary_color IS 'Hex brand color for CTA buttons and accents. NULL → platform default.';
COMMENT ON COLUMN tenant_brands.footer_text IS 'Business info shown in email footer (address, phone, etc).';

ALTER TABLE tenant_brands ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_brands_isolation ON tenant_brands
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- APP EMAIL CONFIGS
-- One row per email-using app. Auto-created on deploy with AI-generated
-- starter content; merchant edits in the Ton dashboard Email tab.
-- Deploy is blocked until configured_by_merchant = TRUE.
-- =============================================================================

CREATE TABLE app_email_configs (
  app_id                 UUID PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_template       TEXT NOT NULL,
  heading_template       TEXT NULL,
  body_template          TEXT NOT NULL,
  cta_label              TEXT NULL,
  cta_url_template       TEXT NULL,
  email_type             email_type NOT NULL DEFAULT 'transactional',
  configured_by_merchant BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_app_email_configs_tenant ON app_email_configs (tenant_id);

COMMENT ON TABLE app_email_configs IS 'Per-app email template. Platform-owned, not per-app DB table. Auto-created on deploy with AI starter content.';
COMMENT ON COLUMN app_email_configs.subject_template IS 'Email subject. Supports {{variable}} placeholders resolved at send time.';
COMMENT ON COLUMN app_email_configs.body_template IS 'Email body. Line breaks become paragraphs. Supports {{variable}} placeholders.';
COMMENT ON COLUMN app_email_configs.cta_url_template IS 'Optional CTA button URL. Supports {{variable}} placeholders.';
COMMENT ON COLUMN app_email_configs.email_type IS 'Informational in MVP — architect-suggested, merchant can override. No behavioral difference yet.';
COMMENT ON COLUMN app_email_configs.configured_by_merchant IS 'TRUE once merchant has saved the Email tab. Deploy is blocked until TRUE.';

ALTER TABLE app_email_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_email_configs_isolation ON app_email_configs
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- EMAIL DELIVERIES
-- One row per send attempt. Populated pre-send with status='queued'; updated
-- via Resend webhooks to 'delivered' / 'bounced' / 'complained' / 'failed'.
-- =============================================================================

CREATE TABLE email_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id          UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  recipient       TEXT NOT NULL,                 -- lowercased, normalized
  subject         TEXT NOT NULL,                 -- resolved subject at send time
  provider        TEXT NOT NULL DEFAULT 'resend',
  provider_msg_id TEXT NULL,                     -- Resend message ID
  status          email_delivery_status NOT NULL DEFAULT 'queued',
  failure_reason  TEXT NULL,
  is_test         BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ NULL,
  bounced_at      TIMESTAMPTZ NULL
);

CREATE INDEX idx_email_deliveries_tenant_sent ON email_deliveries (tenant_id, sent_at DESC);
CREATE INDEX idx_email_deliveries_app_sent ON email_deliveries (app_id, sent_at DESC);
CREATE INDEX idx_email_deliveries_provider_msg_id ON email_deliveries (provider_msg_id)
  WHERE provider_msg_id IS NOT NULL;

COMMENT ON TABLE email_deliveries IS 'One row per email send attempt. Status updated via Resend webhooks.';
COMMENT ON COLUMN email_deliveries.subject IS 'Resolved subject at send time (post-variable substitution), not the template.';
COMMENT ON COLUMN email_deliveries.is_test IS 'TRUE for Send Test previews. Excluded from merchant analytics. Purged after 7 days.';

ALTER TABLE email_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_deliveries_isolation ON email_deliveries
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- EMAIL SUPPRESSIONS
-- Per-tenant block list checked before every send. Populated by merchant-
-- customer unsubscribes, hard bounces, and spam complaints. Tenant-scoped so
-- a customer who unsubscribes from Acme Coffee still receives from Widget Co.
-- =============================================================================

CREATE TABLE email_suppressions (
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email              TEXT NOT NULL,              -- lowercased
  reason             email_suppression_reason NOT NULL,
  source_delivery_id UUID NULL REFERENCES email_deliveries(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, email)
);

CREATE INDEX idx_email_suppressions_tenant ON email_suppressions (tenant_id);

COMMENT ON TABLE email_suppressions IS 'Per-tenant suppression list. Checked before every send in the email service.';
COMMENT ON COLUMN email_suppressions.source_delivery_id IS 'Reference to the delivery that caused this suppression (bounce/complaint). NULL for unsubscribe or manual.';

ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_suppressions_isolation ON email_suppressions
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- APPS: uses_email + email_variables
-- Set when the generator's bundle completion handler stores the bundle,
-- before deploy. Drives Email tab visibility in the dashboard and deploy
-- blocking, and powers the variable-token palette in the Email tab UI.
-- =============================================================================

ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS uses_email BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_variables JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN apps.uses_email IS 'TRUE when the generated handler calls ctx.email.send(). Set when bundle lands in the session. Drives Email tab visibility and deploy blocking.';
COMMENT ON COLUMN apps.email_variables IS 'JSON array of variable names the handler passes in ctx.email.send({data:...}). Powers the token palette in the Email tab UI.';
