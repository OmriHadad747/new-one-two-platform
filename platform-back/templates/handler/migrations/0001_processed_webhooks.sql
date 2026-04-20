-- Template-owned baseline — every handler ships with these tables,
-- whether or not the architect declared any webhooks or cron schedule.
-- Apps that don't use a table never get rows inserted; empty tables
-- cost nothing.

-- ─── processed_webhooks ─────────────────────────────────────────────────────
-- Webhook idempotency table. Locked decision 8: every webhook route
-- starts with INSERT … ON CONFLICT DO NOTHING and returns early on
-- conflict, so duplicate webhook deliveries (Shopify retries, BullMQ
-- retries) become no-ops downstream of the DB.
CREATE TABLE IF NOT EXISTS processed_webhooks (
  webhook_id  TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- TTL index — webhooks older than 30 days can be safely pruned (Shopify
-- retries cap out long before then). The deployer can opt to schedule
-- a periodic DELETE; the index is here so that delete is cheap.
CREATE INDEX IF NOT EXISTS processed_webhooks_received_at_idx
  ON processed_webhooks (received_at);

-- ─── cron_queue ─────────────────────────────────────────────────────────────
-- Cron runner dispatch queue. Phase 2 decision D: pg_cron (running in
-- the shared `postgres` database) INSERTs one row here per scheduled
-- tick. The handler's cron runner (src/lib/cron-runner.ts) claims rows
-- with FOR UPDATE SKIP LOCKED so N Cloud Run instances never double-
-- dispatch. Retry schedule and stale-row sweeping are owned by the
-- runner; this table just persists the work-to-do state.
CREATE TABLE IF NOT EXISTS cron_queue (
  id              BIGSERIAL PRIMARY KEY,
  job_name        TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  attempts        INTEGER NOT NULL DEFAULT 0,
  -- Set when a retry is scheduled for the future (exponential backoff).
  -- NULL means the row is eligible for immediate claim.
  next_visible_at TIMESTAMPTZ
);

-- The runner's claim query filters on (status, next_visible_at) and
-- orders by created_at; this partial index covers the hot path without
-- wasting space on already-finished rows.
CREATE INDEX IF NOT EXISTS cron_queue_pending_idx
  ON cron_queue (created_at)
  WHERE status IN ('pending', 'processing');
