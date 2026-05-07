"""
Single source of truth for every cron rule the agents see.

Views:
  ARCHITECT — plan rules: cronSchedule format + cronContract shape.
  HANDLER   — implementation rules: src/routes/cron.ts jobs-map contract,
              idempotency under retry, and how the template's cron runner
              invokes the job function. Template-owned table rules are
              imported from topics.template_tables.

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

from subagents.prompts.topics.template_tables import HANDLER as _TEMPLATE_TABLES_HANDLER

# ── Architect view ─────────────────────────────────────────────────────────────

# architect_agent.py splits ARCHITECT on this marker: everything before goes
# under shopifyPlan (field rules), everything after goes under CONTRACTS.
ARCHITECT_SPLIT = "##MASTER-SPLINTER##"

ARCHITECT = (
    "cronSchedule: null unless periodic polling is required. Use standard 5-field cron expression."
    + ARCHITECT_SPLIT
    + "\ncronContract: Required when cronSchedule is non-null. Declares what data each batch"
    "\n  iteration must have before processing."
    "\n  - handlerMustProduce: what the cron handler resolves per batch item before acting."
    "\n    MUST NOT describe per-item Shopify reads inside the loop. Every piece of"
    "\n    Shopify data the loop needs must come from the single bulk pre-fetch declared"
    "\n    in cronBatching; the loop body may only consult that pre-fetched data, the"
    '\n    DB, and local logic. If a "re-verify before acting" step sounds needed,'
    "\n    include the required field (e.g. completedAt / status) in the bulk pre-fetch"
    "\n    instead of re-querying per item."
)

# ── Handler view ───────────────────────────────────────────────────────────────

HANDLER = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRON JOBS — src/routes/cron.ts

Emit this file ONLY when the architect declared `cronSchedule`. If
`cronSchedule` is null, do NOT emit src/routes/cron.ts — the template's
cron runner stays disabled.

File skeleton:

  import { sql } from "../lib/db.js";
  import { platform, QuotaExceeded } from "../lib/platform.js";

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
  - The map must have at least one entry. Name jobs after their purpose
    (e.g. `"reconcile"`, `"cleanup"`, `"notify"`). Use `"main"` only
    when the app has a single undifferentiated scheduled task.
  - `JobFn` takes a single `payload: unknown` argument. There is NO
    `req.platform` — cron runs outside any HTTP request. Tenant
    identity is implicit in the `sql` import (search_path pinned to
    this tenant's schema) and `platform.*` (the handler's Cloud Run SA
    identifies tenant + app to platform-back).
  - NEVER call setInterval inside a job. The schedule is external;
    the job body runs once per scheduled tick.

%TEMPLATE_TABLES_HANDLER%

RETRY SEMANTICS — your job MUST be idempotent. The runner auto-retries 3× on
exception with backoff (30s / 5min / 30min) before flipping the row to
status='failed'. Apply Invariants 1 & 3 from HANDLER INVARIANTS (atomic claim,
ON CONFLICT DO NOTHING) to every side effect inside the job body.

LOGGING — include the job name in every log line from inside a job:
  console.log({ jobName: "main", <context_field>: <value> }, "<short_message>");

The runner wraps your job invocation with a surrounding log context
(row id, attempt number, duration) — you don't need to log those.
""".replace("%TEMPLATE_TABLES_HANDLER%", _TEMPLATE_TABLES_HANDLER)
