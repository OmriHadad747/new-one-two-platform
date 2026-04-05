-- Widget and admin invocation logs
-- Separate from execution_logs (webhook-only) for clarity.

CREATE TABLE widget_invocation_logs (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id         UUID        NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  path           TEXT        NOT NULL,   -- e.g. "/subscribe", "/status"
  status         TEXT        NOT NULL,   -- "success" | "failed"
  duration_ms    INTEGER,
  error_message  TEXT,
  invoked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_widget_logs_app ON widget_invocation_logs (app_id, invoked_at DESC);
CREATE INDEX idx_widget_logs_tenant ON widget_invocation_logs (tenant_id, invoked_at DESC);

CREATE TABLE admin_invocation_logs (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id         UUID        NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  path           TEXT        NOT NULL,   -- e.g. "/subscribers", "/run"
  status         TEXT        NOT NULL,   -- "success" | "failed"
  duration_ms    INTEGER,
  error_message  TEXT,
  invoked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_admin_logs_app ON admin_invocation_logs (app_id, invoked_at DESC);
CREATE INDEX idx_admin_logs_tenant ON admin_invocation_logs (tenant_id, invoked_at DESC);
