-- =============================================================================
-- Migration: 0004_cost_visibility.sql
-- Description: TD-001 + TD-004 — persist generation meta and project the
--              per-agent trace into a queryable analytics table.
--
-- Without this, every generation silently burns Anthropic tokens with
-- zero audit trail: `bundleMsg.meta` arrives via Pub/Sub, fans out to the
-- SSE client, and is dropped before any DB write. There is no way to
-- answer "which agent is burning tokens," "what's the $/generation for
-- tenant X," or "did the architect prompt change regress token usage."
--
-- TD-001 adds the blob (source of truth).
-- TD-004 adds the projection table (queryable analytics).
--
-- Both land together: the write path in storeBundleInSession populates
-- the blob and fans meta.agentTrace[] into event rows inside the same
-- withTenantContext transaction. No split-writer race.
-- =============================================================================

-- ─── TD-001: meta blob on generation_sessions ──────────────────────────────

ALTER TABLE generation_sessions
  ADD COLUMN IF NOT EXISTS meta JSONB;

COMMENT ON COLUMN generation_sessions.meta IS
  'GenerationMeta blob from the completed Pub/Sub bundle: '
  '{ totalInputTokens, totalOutputTokens, generationMs, agentTrace[] }. '
  'Source of truth. The generation_events table below is a queryable '
  'projection of meta.agentTrace; both are written in the same transaction '
  'from storeBundleInSession.';

-- ─── TD-004: generation_events projection table ────────────────────────────
--
-- One row per agent invocation. Columns mirror exactly what the current
-- AgentTraceEntry shape publishes today (pubsub-client/schemas.ts:79). If
-- the generator ever starts emitting `model` / `attempt` / `status` /
-- `error` per entry (original TD-004 spec), add the columns here in a
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
-- ENABLE only, no FORCE, matching the pattern of the 14 other RLS tables
-- in the schema (see migration 0003 for the pattern rationale, and TD-014
-- for the full-FORCE sweep follow-up). The writer (storeBundleInSession)
-- runs under withTenantContext so the tenant isolation is enforced at the
-- policy layer for any future non-owner role even though the platform
-- owner currently bypasses it.

ALTER TABLE generation_events ENABLE ROW LEVEL SECURITY;

DO $migration$ BEGIN
  CREATE POLICY generation_events_isolation ON generation_events
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;
