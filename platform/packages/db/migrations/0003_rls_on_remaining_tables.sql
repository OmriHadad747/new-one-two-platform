-- =============================================================================
-- Migration: 0003_rls_on_remaining_tables.sql
-- Description: Closes the RLS gap on the six tables that shipped without it.
--              generation_sessions gets ENABLE + FORCE (real enforcement, even
--              against the DATABASE_URL role that owns the tables); the other
--              five get ENABLE only, matching the pattern the rest of the
--              schema already uses.
--
-- Why only generation_sessions gets FORCE:
--   Audit finding H6 + user direction: prompts/bundles/chat-history are the
--   juiciest cross-tenant-leak target, so we apply real RLS there. The
--   harness + deployer already drive those reads through withTenantContext.
--   Turning FORCE on here requires the API service to wrap every
--   generation_sessions read in withTenantContext too — see the matching
--   TypeScript refactor in this same PR.
--
-- Why the other five get ENABLE without FORCE:
--   That's the pattern the 10 existing RLS tables use today. The platform
--   runs as the table owner, so ENABLE-without-FORCE makes the policies
--   inert for the owner connection and active for any future non-owner
--   role. It's "paper RLS" until we do the full A-full-sweep (docs/
--   TECH_DEBT.md but keeps the schema consistent in the meantime.
--   Extending FORCE to these tables would require touching ~30 db
--   functions across tenants.ts and is out of scope for this batch.
--
-- ⚠ Dev-mode caveat: the docker-compose Postgres creates POSTGRES_USER as
--   a superuser by default. Superusers bypass RLS regardless of FORCE.
--   That means a "forgot withTenantContext" bug against generation_sessions
--   won't surface against the dev database — it will only show up in
--   production (Cloud SQL / managed Postgres uses a non-superuser role).
--   Verified locally by running the migration + a seed script as a
--   dedicated non-superuser owner role; context-scoped reads returned the
--   right row, unscoped reads returned zero. Keep this caveat in mind when
--   debugging "RLS isn't catching my bug" locally.
-- =============================================================================

-- ─── generation_sessions: ENABLE + FORCE ────────────────────────────────────

ALTER TABLE generation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_sessions FORCE  ROW LEVEL SECURITY;

DO $migration$ BEGIN
  CREATE POLICY generation_sessions_isolation ON generation_sessions
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;

-- ─── widget_invocation_logs: ENABLE only (mirrors existing pattern) ─────────

ALTER TABLE widget_invocation_logs ENABLE ROW LEVEL SECURITY;

DO $migration$ BEGIN
  CREATE POLICY widget_invocation_logs_isolation ON widget_invocation_logs
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;

-- ─── admin_invocation_logs: ENABLE only ────────────────────────────────────

ALTER TABLE admin_invocation_logs ENABLE ROW LEVEL SECURITY;

DO $migration$ BEGIN
  CREATE POLICY admin_invocation_logs_isolation ON admin_invocation_logs
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;

-- ─── usage_records: ENABLE only ────────────────────────────────────────────

ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;

DO $migration$ BEGIN
  CREATE POLICY usage_records_isolation ON usage_records
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;

-- ─── revision_classifications: ENABLE only ────────────────────────────────

ALTER TABLE revision_classifications ENABLE ROW LEVEL SECURITY;

DO $migration$ BEGIN
  CREATE POLICY revision_classifications_isolation ON revision_classifications
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;

-- ─── billing_events: ENABLE only ──────────────────────────────────────────

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

DO $migration$ BEGIN
  CREATE POLICY billing_events_isolation ON billing_events
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;
