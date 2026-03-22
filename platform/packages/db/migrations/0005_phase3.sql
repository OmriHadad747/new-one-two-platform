-- ─── Migration 0005: Phase 3 — AI Code Generator ─────────────────────────────

-- generation_sessions: full lifecycle of one code generation request
-- Service-level table — no RLS (accessed only by the generator service)
CREATE TABLE generation_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id          UUID REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE,
  prompt          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending|running|completed|failed
  intent          JSONB,                            -- Agent 1 structured output
  api_plan        JSONB,                            -- Agent 2 structured output
  generated_code  TEXT,                             -- Agent 3 raw JS output
  explanation     TEXT,                             -- Agent 5 merchant-readable summary
  webhook_topics  TEXT[] NOT NULL DEFAULT '{}',     -- extracted from validated code
  cron_schedule   TEXT,                             -- extracted from validated code
  attempt_count   INTEGER NOT NULL DEFAULT 0,       -- how many code-gen loops ran
  app_version_id  UUID REFERENCES app_versions(id), -- set after successful generation
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gen_sessions_app_id ON generation_sessions (app_id);
CREATE INDEX idx_gen_sessions_tenant_id ON generation_sessions (tenant_id);
CREATE INDEX idx_gen_sessions_status ON generation_sessions (status);

COMMENT ON TABLE generation_sessions IS
  'Tracks one end-to-end AI code generation request. Status moves: pending→running→completed|failed.
   A completed session has a linked app_version_id ready for deployment.';

-- generation_events: per-agent LLM call for cost monitoring
-- One row per agent call. Agent 4 (Validation) never writes here — it has no LLM.
CREATE TABLE generation_events (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id    UUID NOT NULL REFERENCES generation_sessions(id) ON DELETE CASCADE,
  agent_name    TEXT NOT NULL,        -- intent|schema|code|explanation
  provider      TEXT NOT NULL DEFAULT 'anthropic',
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'success',  -- success|failed
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gen_events_session_id ON generation_events (session_id);
CREATE INDEX idx_gen_events_created_at ON generation_events (created_at DESC);

COMMENT ON TABLE generation_events IS
  'Per-LLM-call audit log. Use to compute Claude API costs per agent, model, and session.';

-- updated_at trigger for generation_sessions
CREATE TRIGGER set_updated_at BEFORE UPDATE ON generation_sessions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
