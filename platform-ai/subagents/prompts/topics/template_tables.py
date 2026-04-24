"""
Single source of truth for rules about template-owned tables.

`cron_queue` and `processed_webhooks` ship with every handler via the
template's bootstrap migrations under
platform-back/templates/handler/migrations/ (0001_processed_webhooks.sql,
0002_cron_dedup.sql, …). They are platform infrastructure — handler code
never touches them directly. Job scheduling goes through the `enqueueJob`
helper in src/lib/cron-enqueue.ts; webhook idempotency is handled by the
template router.

Views — imported by downstream prompt surfaces:
  HANDLER             — the "don't touch" rule + enqueueJob teaching,
                        injected into cron and webhook topic HANDLER
                        sections.
  VALIDATOR           — known tables + column sets + rule-violation
                        signal, prepended to validator Part A so Q1/Q7
                        don't produce false positives and still catch
                        real column bugs (e.g. a non-existent `run_at`
                        on cron_queue).
  TEMPLATE_OWNED_TABLES — frozenset of table names. Imported by
                        static_validation to build a regex that flags
                        direct DML against these tables in handler code.

KEEP IN SYNC with the template migrations if columns change.
"""

# Canonical schemas — fixed set. Update here + the corresponding template
# migration (0001_processed_webhooks.sql, 0002_cron_dedup.sql, …) together
# if the template tables ever change.
_TEMPLATE_TABLE_COLUMNS: dict[str, list[str]] = {
    "cron_queue": [
        "id",
        "job_name",
        "payload",
        "status",
        "created_at",
        "started_at",
        "finished_at",
        "attempts",
        "next_visible_at",
        "dedup_key",
    ],
    "processed_webhooks": ["webhook_id", "received_at"],
}

# Public alias for downstream consumers (e.g. static_validation builds a
# regex of forbidden table names from this set so the prompt + the
# enforcement layer stay in lockstep).
TEMPLATE_OWNED_TABLES: frozenset[str] = frozenset(_TEMPLATE_TABLE_COLUMNS.keys())


# ── Handler view ───────────────────────────────────────────────────────────────

HANDLER = """\
TEMPLATE-OWNED TABLES — NEVER touch directly:
  `cron_queue` and `processed_webhooks` are platform infrastructure.
  Their schemas are managed by the handler template and can change
  without notice. NEVER write `INSERT INTO cron_queue …`, `UPDATE
  cron_queue …`, `SELECT … FROM cron_queue`, or any equivalent against
  `processed_webhooks` inside handler code.
  • Webhook idempotency is owned by the template router — the
    `processed_webhooks` row is written before your handler ever runs.
    Do not INSERT / SELECT / read it yourself.
  • Scheduled cron runs are dispatched by pg_cron + the template
    cron-runner — they insert into `cron_queue` automatically for
    every tick of the architect-declared schedule.

AD-HOC JOB TRIGGERS — use enqueueJob, NOT a direct INSERT:
  When a handler needs to kick off a cron job outside its scheduled
  tick — an admin "Run now" button, a webhook spawning follow-up
  work — import and call the template helper:

    import { enqueueJob } from "../lib/cron-enqueue.js";

    await enqueueJob("main");                          // no payload
    await enqueueJob("reconcile", { orderId: "123" }); // with payload

  The helper inserts one row into `cron_queue` using the correct schema;
  the template cron-runner dispatches it on the next poll tick. `jobName`
  MUST match a key in the `jobs` map exported from src/routes/cron.ts.

  Pass `dedupKey` when the same trigger may fire twice (admin double-click,
  webhook retry storm) and you want at-most-one in-flight job:

    await enqueueJob("reconcile", { orderId },
      { dedupKey: `reconcile-${orderId}` });

  A second enqueue with the same (jobName, dedupKey) is a silent no-op
  while a prior identical row is still pending or processing; once that
  row finishes, fresh enqueues with the same key are allowed again.\
"""


# ── Validator view ─────────────────────────────────────────────────────────────

def _fmt(table: str) -> str:
    return f"  {table}: {', '.join(_TEMPLATE_TABLE_COLUMNS[table])}"


VALIDATOR = (
    "TEMPLATE-OWNED TABLES — required override for Q1/Q2/Q7:\n"
    "`cron_queue` and `processed_webhooks` ship with every handler via the\n"
    "template's bootstrap migration. They are NOT present in the per-app\n"
    "migration SQL shown to you, but they exist at runtime with fixed schemas:\n"
    f"{_fmt('cron_queue')}.\n"
    f"{_fmt('processed_webhooks')}.\n"
    "\n"
    "When answering Part A checks, apply these rules:\n"
    "  - Q1 (table names): TREAT both tables as valid table names. Do NOT\n"
    "    flag handler references to them as missing-table errors just because\n"
    "    they are absent from the per-app migration SQL.\n"
    "  - Q2 (column names): TREAT the fixed column sets above as the\n"
    "    authoritative schema for these two tables. A handler reference to a\n"
    "    column outside these sets IS a real column-name mismatch — flag it\n"
    "    under q2 with the specific table + column (example: `run_at` does\n"
    "    NOT exist on `cron_queue`).\n"
    "  - Q7 (schema completeness): same rule as Q2 for INSERT column lists.\n"
    "    Use the fixed sets above as the required-column reference.\n"
    "\n"
    "Separately: handler code should not touch these tables directly (the\n"
    "`enqueueJob` helper covers ad-hoc job dispatch; idempotency is template-\n"
    "owned). If the handler nonetheless reads or writes them at all, raise\n"
    "that as an open_finding — independent of q1/q2/q7."
)
