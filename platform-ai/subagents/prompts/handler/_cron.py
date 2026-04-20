"""
Cron jobs handler patterns.

Injected by handler_agent.py's JIT into the USER prompt when
``shopifyPlan.cronSchedule`` is non-null. Covers the src/routes/cron.ts
jobs-map contract, idempotency under retry, and how the template's cron
runner invokes the job function.

HOW CRON WORKS IN THIS PLATFORM
  pg_cron (scheduler in the shared Postgres) fires on the architect's
  declared schedule. Its SQL body inserts ONE row into the tenant's
  `cron_queue` table — a single `INSERT INTO cron_queue (job_name, payload)`.
  That's it. NO HTTP, no auth token, no Cloud Scheduler.

  The handler's template-owned `src/lib/cron-runner.ts` (always present,
  enabled when cronSchedule is declared) polls `cron_queue`, claims a row
  with `FOR UPDATE SKIP LOCKED`, looks up the job by `job_name` in the
  generator-authored jobs map, invokes it, and marks the row done/failed.
  N-instance safety comes from SKIP LOCKED; template handles retry
  (3 attempts, exponential backoff 30s/5min/30min) and stale-row sweeping.

  The generator's ONLY responsibility here is src/routes/cron.ts — the
  jobs map.
"""

HARNESS_SECTION_CRON = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRON JOBS — src/routes/cron.ts

Emit this file ONLY when the architect declared `cronSchedule`. If
`cronSchedule` is null, do NOT emit src/routes/cron.ts — the template's
cron runner stays disabled.

File skeleton:

  import { sql } from "../lib/db.js";
  import { callPlatformService } from "../lib/platform-call.js";

  type JobFn = (payload: unknown) => Promise<void>;

  export const jobs: Record<string, JobFn> = {
    main: async (payload) => {
      // ... scheduled work
    },
  };

Rules:
  - The file MUST export a named `jobs` constant of type
    `Record<string, JobFn>`. The template's cron runner imports it by
    that exact name.
  - For Phase 2, emit EXACTLY ONE job named `"main"`. Multi-job support
    is tech debt (TD-021); do not anticipate it.
  - `JobFn` takes a single `payload: unknown` argument. There is NO
    `req.platform` — cron runs outside any HTTP request. Tenant
    identity is implicit in the `sql` import (search_path pinned to
    this tenant's schema) and `callPlatformService` (the handler's
    Cloud Run SA identifies tenant + app to platform-back).
  - NEVER call setInterval inside a job. The schedule is external;
    the job body runs once per scheduled tick.

RETRY SEMANTICS — write your job IDEMPOTENT:
  The template's cron runner auto-retries on exception:
    attempt 1 → fails → wait 30s → attempt 2 → fails → wait 5min →
    attempt 3 → fails → status='failed' (no further retry).
  Your job function MAY therefore be invoked multiple times for the
  same scheduled tick. Guard all side effects:
    ✅ INSERT ... ON CONFLICT (<unique_key>) DO NOTHING
    ✅ Claim-then-act via UPDATE ... RETURNING (see _state_machine.py)
    ❌ Unguarded INSERT that duplicates on retry.
    ❌ External side effect (email send, Shopify mutation) without a
       DB-level "already done" check.

TYPICAL SHAPES:

  // Pure-DB aggregation (no Shopify, no email):
  jobs.main = async (_payload) => {
    const summary = await sql`
      SELECT count(*)::int AS total
      FROM <table_1>
      WHERE <created_at_col> >= NOW() - INTERVAL '1 day'
    `;
    console.log({ jobName: "main", totalToday: summary[0].total }, "cron main");
  };

  // Batch iteration over Shopify data — use the BATCHED SHOPIFY section
  // rules: prefetch in chunks, zero Shopify calls in the loop, String()
  // normalize Map keys.

  // Dispatching email via platform service:
  jobs.main = async (_payload) => {
    const recipients = await sql`
      SELECT <recipient_id_col>, <email_col> FROM <table_1>
      WHERE <sent_at_col> IS NULL
      LIMIT 200
    `;
    for (const r of recipients) {
      // Claim-then-send guards against retry double-send:
      const [claimed] = await sql`
        UPDATE <table_1>
        SET <sent_at_col> = NOW()
        WHERE <recipient_id_col> = ${r.<recipient_id_col>}
          AND <sent_at_col> IS NULL
        RETURNING <recipient_id_col>
      `;
      if (!claimed) continue;

      const { status } = await callPlatformService({
        path: "/services/email/send",
        body: { to: r.<email_col>, data: { /* template vars */ } },
      });
      if (status === 429 || status >= 400) {
        // Revert the claim so a retry tick can try again.
        await sql`
          UPDATE <table_1> SET <sent_at_col> = NULL
          WHERE <recipient_id_col> = ${r.<recipient_id_col>}
        `;
        break;   // stop this tick; backoff kicks in
      }
    }
  };

LOGGING — include the job name in every log line from inside a job:
  console.log({ jobName: "main", <context_field>: <value> }, "<short_message>");

The runner wraps your job invocation with a surrounding log context
(row id, attempt number, duration) — you don't need to log those.
"""
