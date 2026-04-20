-- =============================================================================
-- platform-back — Initial schema (consolidated)
--
-- Equivalent to platform/packages/db/migrations/0001..0004 unioned, plus the
-- one platform-back-specific addition: apps.handler_sa_email (used by
-- /services/* routes to map a verified Cloud Run ID token's `email` claim
-- back to (tenantId, appId)).
--
-- Run on a clean DB. There is no chained migration history yet — we'll
-- introduce 0002+ when platform-back makes its own schema additions.
-- =============================================================================

-- ── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Enums ────────────────────────────────────────────────────────────────────
CREATE TYPE tenant_status AS ENUM ('active', 'suspended', 'pending');
CREATE TYPE app_status AS ENUM ('draft', 'ready', 'active', 'inactive', 'deleted');
CREATE TYPE version_status AS ENUM ('draft', 'building', 'ready', 'failed', 'archived');
CREATE TYPE execution_status AS ENUM ('queued', 'running', 'success', 'failed', 'timeout');
CREATE TYPE deployed_function_runtime AS ENUM ('nodejs20', 'nodejs18');
CREATE TYPE billing_plan AS ENUM ('free', 'starter', 'growth', 'pro', 'internal');
CREATE TYPE subscription_status AS ENUM ('none', 'pending', 'active', 'frozen', 'cancelled');
CREATE TYPE revision_type AS ENUM ('bug_report', 'feature_modification', 'new_capability');
CREATE TYPE billing_interval AS ENUM ('monthly', 'annual');
CREATE TYPE email_type AS ENUM ('transactional', 'marketing');
CREATE TYPE email_delivery_status AS ENUM ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed');
CREATE TYPE email_suppression_reason AS ENUM ('unsubscribed', 'bounced', 'complained', 'manual');

-- ── updated_at trigger helper ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- TENANTS
-- =============================================================================

CREATE TABLE tenants (
  id                                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug                                 TEXT NOT NULL UNIQUE,
  name                                 TEXT NOT NULL,
  status                               tenant_status NOT NULL DEFAULT 'pending',
  kms_key_name                         TEXT NOT NULL,
  shop_domain                          TEXT UNIQUE,
  shopify_access_token_secret_name     TEXT,
  storefront_access_token_secret_name  TEXT,
  billing_plan                         billing_plan NOT NULL DEFAULT 'free',
  billing_interval                     billing_interval NOT NULL DEFAULT 'monthly',
  subscription_status                  subscription_status NOT NULL DEFAULT 'none',
  shopify_subscription_id              TEXT,
  trial_ends_at                        TIMESTAMPTZ,
  billing_cycle_anchor                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  plan_updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9-]+$')
);

CREATE INDEX idx_tenants_slug ON tenants (slug);
CREATE INDEX idx_tenants_status ON tenants (status);
CREATE INDEX idx_tenants_shop_domain ON tenants (shop_domain);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_isolation ON tenants
  USING (id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- APPS
-- =============================================================================
--
-- handler_sa_email (platform-back addition): the per-handler Cloud Run
-- service account email used as the lookup key for inbound /services/*
-- requests. Format produced by the provisioner:
--   h-<sanitizedShopPrefix>-<n>@<project>.iam.gserviceaccount.com
-- Unique-when-set so unbound rows (created before deploy) don't collide.

CREATE TABLE apps (
  id                         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug                       TEXT NOT NULL,
  name                       TEXT NOT NULL,
  status                     app_status NOT NULL DEFAULT 'draft',
  shopify_client_id          TEXT NOT NULL,
  shopify_secret_name        TEXT NOT NULL DEFAULT '',
  shop_domain                TEXT NOT NULL,
  widget_js                  TEXT,
  admin_ui_js                TEXT,
  app_archetype              TEXT NOT NULL DEFAULT 'backend'
                               CHECK (app_archetype IN ('storefront_backend', 'storefront_backend_admin', 'backend', 'backend_admin')),
  theme_injection_status     TEXT NOT NULL DEFAULT 'none',
  theme_injection_theme_id   TEXT,
  uses_email                 BOOLEAN NOT NULL DEFAULT FALSE,
  email_variables            JSONB NOT NULL DEFAULT '[]'::jsonb,
  handler_sa_email           TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, slug),
  CONSTRAINT apps_shop_domain_format CHECK (shop_domain ~ '^[a-zA-Z0-9-]+\.myshopify\.com$')
);

CREATE INDEX idx_apps_tenant_id ON apps (tenant_id);
CREATE INDEX idx_apps_tenant_slug ON apps (tenant_id, slug);
CREATE INDEX idx_apps_shop_domain ON apps (shop_domain);
CREATE UNIQUE INDEX idx_apps_handler_sa_email
  ON apps (handler_sa_email)
  WHERE handler_sa_email IS NOT NULL;

ALTER TABLE apps ENABLE ROW LEVEL SECURITY;
CREATE POLICY apps_tenant_isolation ON apps
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON apps
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- APP VERSIONS
-- =============================================================================

CREATE TABLE app_versions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id           UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  semver           TEXT NOT NULL,
  status           version_status NOT NULL DEFAULT 'draft',
  generated_code   JSONB NOT NULL DEFAULT '{}',
  build_logs       TEXT,
  gcs_bundle_path  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, semver),
  CONSTRAINT semver_format CHECK (semver ~ '^\d+\.\d+\.\d+$')
);

CREATE INDEX idx_app_versions_app_id ON app_versions (app_id);
CREATE INDEX idx_app_versions_tenant_id ON app_versions (tenant_id);
CREATE INDEX idx_app_versions_status ON app_versions (status);

ALTER TABLE app_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_versions_tenant_isolation ON app_versions
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON app_versions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- DEPLOYED FUNCTIONS
-- =============================================================================

CREATE TABLE deployed_functions (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_version_id       UUID NOT NULL REFERENCES app_versions(id) ON DELETE RESTRICT,
  app_id               UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  function_url         TEXT NOT NULL,
  runtime              deployed_function_runtime NOT NULL DEFAULT 'nodejs20',
  memory_mb            INTEGER NOT NULL DEFAULT 256,
  timeout_sec          INTEGER NOT NULL DEFAULT 30,
  env_vars_encrypted   BYTEA NOT NULL DEFAULT '',
  deployed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT memory_range CHECK (memory_mb BETWEEN 128 AND 3008),
  CONSTRAINT timeout_range CHECK (timeout_sec BETWEEN 1 AND 900)
);

CREATE INDEX idx_deployed_functions_app_id ON deployed_functions (app_id);
CREATE INDEX idx_deployed_functions_tenant_id ON deployed_functions (tenant_id);
CREATE INDEX idx_deployed_functions_active ON deployed_functions (app_id, is_active);

ALTER TABLE deployed_functions ENABLE ROW LEVEL SECURITY;
CREATE POLICY deployed_functions_tenant_isolation ON deployed_functions
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- WEBHOOK SUBSCRIPTIONS
-- =============================================================================

CREATE TABLE webhook_subscriptions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id                UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deployed_function_id  UUID NOT NULL REFERENCES deployed_functions(id) ON DELETE RESTRICT,
  topic                 TEXT NOT NULL,
  shopify_webhook_id    TEXT NOT NULL,
  callback_url          TEXT NOT NULL,
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, topic)
);

CREATE INDEX idx_webhook_subs_app_id ON webhook_subscriptions (app_id);
CREATE INDEX idx_webhook_subs_tenant_id ON webhook_subscriptions (tenant_id);
CREATE INDEX idx_webhook_subs_topic ON webhook_subscriptions (app_id, topic, active);

ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_subs_tenant_isolation ON webhook_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON webhook_subscriptions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- WEBHOOK INVOCATION LOGS
-- =============================================================================

CREATE TABLE webhook_invocation_logs (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  webhook_subscription_id   UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  deployed_function_id      UUID NOT NULL REFERENCES deployed_functions(id),
  app_id                    UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  topic                     TEXT NOT NULL,
  shopify_webhook_id        TEXT NOT NULL,
  status                    execution_status NOT NULL DEFAULT 'queued',
  duration_ms               INTEGER,
  request_payload_hash      TEXT NOT NULL,
  response_status_code      INTEGER,
  error_message             TEXT,
  invocation_id             TEXT,
  shopify_api_calls         INTEGER NOT NULL DEFAULT 0,
  queued_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at                TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_webhook_inv_logs_idempotency
  ON webhook_invocation_logs (app_id, shopify_webhook_id);
CREATE INDEX idx_webhook_inv_logs_tenant_app ON webhook_invocation_logs (tenant_id, app_id);
CREATE INDEX idx_webhook_inv_logs_status ON webhook_invocation_logs (status);
CREATE INDEX idx_webhook_inv_logs_queued_at ON webhook_invocation_logs (queued_at DESC);

ALTER TABLE webhook_invocation_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_inv_logs_tenant_isolation ON webhook_invocation_logs
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- GENERATION SESSIONS
--
-- ENABLE + FORCE (real RLS): prompts/bundles/chat history are the
-- highest-cross-tenant-leak target, so the policy applies even to the
-- table-owner role. All readers MUST wrap queries in withTenantContext.
-- =============================================================================

CREATE TABLE generation_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id          UUID REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE,
  prompt          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  intent          JSONB,
  api_plan        JSONB,
  generated_code  TEXT,
  explanation     TEXT,
  webhook_topics  TEXT[] NOT NULL DEFAULT '{}',
  cron_schedule   TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  app_version_id  UUID REFERENCES app_versions(id),
  error_message   TEXT,
  job_id          UUID,
  bundle          JSONB,
  chat_messages   JSONB,
  meta            JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gen_sessions_app_id ON generation_sessions (app_id);
CREATE INDEX idx_gen_sessions_tenant_id ON generation_sessions (tenant_id);
CREATE INDEX idx_gen_sessions_status ON generation_sessions (status);
CREATE INDEX idx_gen_sessions_job_id ON generation_sessions (job_id) WHERE job_id IS NOT NULL;

ALTER TABLE generation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_sessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY generation_sessions_isolation ON generation_sessions
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON generation_sessions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMENT ON COLUMN generation_sessions.meta IS
  'GenerationMeta blob from the completed Pub/Sub bundle: '
  '{ totalInputTokens, totalOutputTokens, generationMs, agentTrace[] }. '
  'Source of truth. The generation_events table is a queryable projection '
  'of meta.agentTrace; both are written in the same transaction.';

-- =============================================================================
-- WIDGET INVOCATION LOGS
-- =============================================================================

CREATE TABLE widget_invocation_logs (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id         UUID        NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  path           TEXT        NOT NULL,
  status         TEXT        NOT NULL,
  duration_ms    INTEGER,
  error_message  TEXT,
  invoked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_widget_logs_app ON widget_invocation_logs (app_id, invoked_at DESC);
CREATE INDEX idx_widget_logs_tenant ON widget_invocation_logs (tenant_id, invoked_at DESC);

ALTER TABLE widget_invocation_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY widget_invocation_logs_isolation ON widget_invocation_logs
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- ADMIN INVOCATION LOGS
-- =============================================================================

CREATE TABLE admin_invocation_logs (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id         UUID        NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  path           TEXT        NOT NULL,
  status         TEXT        NOT NULL,
  duration_ms    INTEGER,
  error_message  TEXT,
  invoked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_admin_logs_app ON admin_invocation_logs (app_id, invoked_at DESC);
CREATE INDEX idx_admin_logs_tenant ON admin_invocation_logs (tenant_id, invoked_at DESC);

ALTER TABLE admin_invocation_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_invocation_logs_isolation ON admin_invocation_logs
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- USAGE RECORDS (monthly counters per tenant)
-- =============================================================================

CREATE TABLE usage_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start    DATE NOT NULL,
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

ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_records_isolation ON usage_records
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- REVISION CLASSIFICATIONS (analytics)
-- =============================================================================

CREATE TABLE revision_classifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id          UUID NOT NULL,
  session_id      UUID,
  job_id          TEXT,
  classification  revision_type NOT NULL,
  confidence      TEXT NOT NULL DEFAULT 'high',
  merchant_prompt TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_revision_classifications_tenant ON revision_classifications (tenant_id);
CREATE INDEX idx_revision_classifications_app ON revision_classifications (app_id);
CREATE INDEX idx_revision_classifications_type ON revision_classifications (classification);

ALTER TABLE revision_classifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY revision_classifications_isolation ON revision_classifications
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- BILLING EVENTS (audit trail)
-- =============================================================================

CREATE TABLE billing_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type              TEXT NOT NULL,
  from_plan               billing_plan,
  to_plan                 billing_plan,
  shopify_subscription_id TEXT,
  metadata                JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_billing_events_tenant ON billing_events (tenant_id);

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_events_isolation ON billing_events
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- TENANT BRANDS (email branding)
-- =============================================================================

CREATE TABLE tenant_brands (
  tenant_id     UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  logo_url      TEXT,
  primary_color TEXT,
  footer_text   TEXT,
  support_email TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tenant_brands ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_brands_isolation ON tenant_brands
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- APP EMAIL CONFIGS
-- =============================================================================

CREATE TABLE app_email_configs (
  app_id                 UUID PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_template       TEXT NOT NULL,
  heading_template       TEXT,
  body_template          TEXT NOT NULL,
  cta_label              TEXT,
  cta_url_template       TEXT,
  email_type             email_type NOT NULL DEFAULT 'transactional',
  configured_by_merchant BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_app_email_configs_tenant ON app_email_configs (tenant_id);

ALTER TABLE app_email_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_email_configs_isolation ON app_email_configs
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- EMAIL DELIVERIES
-- =============================================================================

CREATE TABLE email_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id          UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  recipient       TEXT NOT NULL,
  subject         TEXT NOT NULL,
  provider        TEXT NOT NULL DEFAULT 'resend',
  provider_msg_id TEXT,
  status          email_delivery_status NOT NULL DEFAULT 'queued',
  failure_reason  TEXT,
  is_test         BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,
  bounced_at      TIMESTAMPTZ
);

CREATE INDEX idx_email_deliveries_tenant_sent ON email_deliveries (tenant_id, sent_at DESC);
CREATE INDEX idx_email_deliveries_app_sent ON email_deliveries (app_id, sent_at DESC);
CREATE INDEX idx_email_deliveries_provider_msg_id ON email_deliveries (provider_msg_id)
  WHERE provider_msg_id IS NOT NULL;

ALTER TABLE email_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_deliveries_isolation ON email_deliveries
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- EMAIL SUPPRESSIONS
-- =============================================================================

CREATE TABLE email_suppressions (
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email              TEXT NOT NULL,
  reason             email_suppression_reason NOT NULL,
  source_delivery_id UUID REFERENCES email_deliveries(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, email)
);

CREATE INDEX idx_email_suppressions_tenant ON email_suppressions (tenant_id);

ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_suppressions_isolation ON email_suppressions
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- GENERATION EVENTS (per-agent cost / latency projection of meta.agentTrace[])
--
-- ENABLE + FORCE (real RLS): same treatment as generation_sessions, since
-- this is a row-per-agent projection of the same data.
-- =============================================================================

CREATE TABLE generation_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID        NOT NULL REFERENCES generation_sessions(id) ON DELETE CASCADE,
  tenant_id     UUID        NOT NULL REFERENCES tenants(id)             ON DELETE CASCADE,
  job_id        UUID        NOT NULL,
  agent_name    TEXT        NOT NULL,
  input_tokens  INTEGER     NOT NULL DEFAULT 0,
  output_tokens INTEGER     NOT NULL DEFAULT 0,
  latency_ms    INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_generation_events_session       ON generation_events (session_id);
CREATE INDEX idx_generation_events_tenant_agent  ON generation_events (tenant_id, agent_name, created_at);
CREATE INDEX idx_generation_events_created_at    ON generation_events (created_at DESC);

ALTER TABLE generation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY generation_events_isolation ON generation_events
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);
