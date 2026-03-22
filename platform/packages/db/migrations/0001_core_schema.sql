-- =============================================================================
-- Migration: 0001_core_schema.sql
-- Description: Core data model for Shopify PaaS Platform
-- RLS is enabled on all tables; service_role bypasses, tenant_role filters by tenant_id
-- =============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE tenant_status AS ENUM ('active', 'suspended', 'pending');
CREATE TYPE app_status AS ENUM ('active', 'inactive', 'deleted');
CREATE TYPE version_status AS ENUM ('draft', 'building', 'ready', 'failed', 'archived');
CREATE TYPE execution_status AS ENUM ('queued', 'running', 'success', 'failed', 'timeout');
CREATE TYPE deployed_function_runtime AS ENUM ('nodejs20.x', 'nodejs18.x');

-- =============================================================================
-- TENANTS
-- =============================================================================

CREATE TABLE tenants (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug                        TEXT NOT NULL UNIQUE,
  name                        TEXT NOT NULL,
  status                      tenant_status NOT NULL DEFAULT 'pending',
  plan                        TEXT NOT NULL DEFAULT 'starter',
  webhook_signing_key_kms_arn TEXT NOT NULL,       -- ARN of per-tenant KMS CMK
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9-]+$')
);

CREATE INDEX idx_tenants_slug ON tenants (slug);
CREATE INDEX idx_tenants_status ON tenants (status);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

-- Tenants can read their own row; writes are service-role only
CREATE POLICY tenants_isolation ON tenants
  USING (id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- APPS
-- =============================================================================

CREATE TABLE apps (
  id                              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug                            TEXT NOT NULL,
  name                            TEXT NOT NULL,
  status                          app_status NOT NULL DEFAULT 'active',
  shopify_api_key                 TEXT NOT NULL,
  shopify_api_secret_encrypted    BYTEA NOT NULL,  -- KMS ciphertext
  shop_domain                     TEXT NOT NULL,   -- mystore.myshopify.com
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, slug),
  CONSTRAINT apps_shop_domain_format CHECK (shop_domain ~ '^[a-zA-Z0-9-]+\.myshopify\.com$')
);

CREATE INDEX idx_apps_tenant_id ON apps (tenant_id);
CREATE INDEX idx_apps_tenant_slug ON apps (tenant_id, slug);
CREATE INDEX idx_apps_shop_domain ON apps (shop_domain);

ALTER TABLE apps ENABLE ROW LEVEL SECURITY;

CREATE POLICY apps_tenant_isolation ON apps
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- APP VERSIONS
-- =============================================================================

CREATE TABLE app_versions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id           UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  semver           TEXT NOT NULL,
  status           version_status NOT NULL DEFAULT 'draft',
  generated_code   JSONB NOT NULL DEFAULT '{}',  -- { "handler.ts": "...", ... }
  build_logs       TEXT,
  s3_bundle_key    TEXT,                          -- s3://bucket/tenants/.../v.zip
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

-- =============================================================================
-- DEPLOYED FUNCTIONS
-- =============================================================================

CREATE TABLE deployed_functions (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_version_id       UUID NOT NULL REFERENCES app_versions(id) ON DELETE RESTRICT,
  app_id               UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lambda_arn           TEXT NOT NULL,             -- arn:aws:lambda:...:function:name:alias
  lambda_alias         TEXT NOT NULL DEFAULT 'live',
  runtime              deployed_function_runtime NOT NULL DEFAULT 'nodejs20.x',
  memory_mb            INTEGER NOT NULL DEFAULT 256,
  timeout_sec          INTEGER NOT NULL DEFAULT 30,
  env_vars_encrypted   BYTEA NOT NULL DEFAULT '',  -- KMS-encrypted JSON
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
  topic                 TEXT NOT NULL,             -- "orders/create"
  shopify_webhook_id    TEXT NOT NULL,             -- ID from Shopify API
  callback_url          TEXT NOT NULL,
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, topic)                           -- one handler per topic per app
);

CREATE INDEX idx_webhook_subs_app_id ON webhook_subscriptions (app_id);
CREATE INDEX idx_webhook_subs_tenant_id ON webhook_subscriptions (tenant_id);
CREATE INDEX idx_webhook_subs_topic ON webhook_subscriptions (app_id, topic, active);

ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY webhook_subs_tenant_isolation ON webhook_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- EXECUTION LOGS
-- =============================================================================

CREATE TABLE execution_logs (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  webhook_subscription_id   UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  deployed_function_id      UUID NOT NULL REFERENCES deployed_functions(id),
  app_id                    UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  topic                     TEXT NOT NULL,
  shopify_webhook_id        TEXT NOT NULL,       -- X-Shopify-Webhook-Id — idempotency key
  status                    execution_status NOT NULL DEFAULT 'queued',
  duration_ms               INTEGER,
  request_payload_hash      TEXT NOT NULL,       -- SHA-256 of raw body
  response_status_code      INTEGER,
  error_message             TEXT,
  lambda_request_id         TEXT,
  queued_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at                TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ
);

-- Idempotency: prevent duplicate processing of the same Shopify webhook event
CREATE UNIQUE INDEX idx_exec_logs_idempotency
  ON execution_logs (app_id, shopify_webhook_id);

CREATE INDEX idx_exec_logs_tenant_app ON execution_logs (tenant_id, app_id);
CREATE INDEX idx_exec_logs_status ON execution_logs (status);
CREATE INDEX idx_exec_logs_queued_at ON execution_logs (queued_at DESC);

ALTER TABLE execution_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY exec_logs_tenant_isolation ON execution_logs
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- UPDATED_AT TRIGGER (applied to all tables with that column)
-- =============================================================================

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON apps
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON app_versions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON webhook_subscriptions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
