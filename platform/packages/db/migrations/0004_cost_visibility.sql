-- =============================================================================
-- Migration: 0004_cost_visibility.sql
-- Description: Persist generation meta and project the
--              per-agent trace into a queryable analytics table.
--
-- Without this, every generation silently burns Anthropic tokens with
-- zero audit trail: `bundleMsg.meta` arrives via Pub/Sub, fans out to the
-- SSE client, and is dropped before any DB write. There is no way to
-- answer "which agent is burning tokens," "what's the $/generation for
-- tenant X," or "did the architect prompt change regress token usage."
--
--  adds the blob (source of truth).
--  adds the projection table (queryable analytics).
--
-- Both land together: the write path in storeBundleInSession populates
-- the blob and fans meta.agentTrace[] into event rows inside the same
-- withTenantContext transaction. No split-writer race.
-- =============================================================================

-- ─── : meta blob on generation_sessions ──────────────────────────────

ALTER TABLE generation_sessions
  ADD COLUMN IF NOT EXISTS meta JSONB;

COMMENT ON COLUMN generation_sessions.meta IS
  'GenerationMeta blob from the completed Pub/Sub bundle: '
  '{ totalInputTokens, totalOutputTokens, generationMs, agentTrace[] }. '
  'Source of truth. The generation_events table below is a queryable '
  'projection of meta.agentTrace; both are written in the same transaction '
  'from storeBundleInSession.';

-- ───────── generation_events projection table ────────────────────────────
--
-- One row per agent invocation. Columns mirror exactly what the current
-- AgentTraceEntry shape publishes today (pubsub-client/schemas.ts:79). If
-- the generator ever starts emitting `model` / `attempt` / `status` /
-- `error` per entry, add the columns here in a
-- follow-up migration and update the fan-out loop in storeBundleInSession.

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

-- Queries we want to support in O(index-scan):
--
--   "all events for session X"                 → idx_generation_events_session
--   "cost per agent for tenant X this month"   → idx_generation_events_tenant_agent
--   "recent events feed for the dashboard"     → idx_generation_events_created_at
--
-- Intentionally no composite index on (tenant_id, created_at) alone —
-- the tenant_agent index already serves that via index-only scan when
-- agent_name is filtered or aggregated.

CREATE INDEX idx_generation_events_session       ON generation_events (session_id);
CREATE INDEX idx_generation_events_tenant_agent  ON generation_events (tenant_id, agent_name, created_at);
CREATE INDEX idx_generation_events_created_at    ON generation_events (created_at DESC);

-- ─── RLS ───────────────────────────────────────────────────────────────────
--
-- ENABLE + FORCE — same treatment as generation_sessions (migration 0003).
-- generation_events is a projection of meta.agentTrace[] and is just as
-- cross-tenant-sensitive as the session it projects: it records per-agent
-- cost / latency data, which is both PII-adjacent (reveals which generation
-- a tenant ran) and commercially sensitive (cost-per-feature for that
-- tenant).
--
-- FORCE means the owner role (`app_owner` in production / the Cloud SQL
-- default role) is subject to the policy — a caller that forgets to wrap
-- reads in withTenantContext returns zero rows instead of silently leaking
-- events across tenants. The writer (storeBundleInSession) already runs
-- under withTenantContext so no code change needed.
--
-- ⚠ Same dev-mode caveat as migration 0003: docker-compose Postgres creates
-- POSTGRES_USER as a superuser which bypasses RLS regardless of FORCE. The
-- RLS invariant test (rls-generation.integration.test.ts) hands ownership
-- to a dedicated non-superuser role before asserting isolation, matching
-- how Cloud SQL actually boots.

ALTER TABLE generation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_events FORCE  ROW LEVEL SECURITY;

DO $migration$ BEGIN
  CREATE POLICY generation_events_isolation ON generation_events
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;
