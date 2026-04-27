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

# Files the handler template ships that neither the static validator nor
# the tsc gate should treat as generator output. Both layers import from
# here — a single addition covers both enforcement points.
#
# Rules:
#   - The static validator rejects any bundle that tries to overwrite these
#     paths (the deployer would silently replace hand-written code).
#   - The tsc gate filters errors in these paths as "template bugs" so they
#     never enter the retry-feedback loop (the generator can't fix them).
#
# KEEP IN SYNC with platform-back/templates/handler when adding or removing
# template source files.
TEMPLATE_OWNED_FILES: frozenset[str] = frozenset(
    {
        # TypeScript source files — generator must not overwrite
        "src/server.ts",
        "src/middleware/verify-platform.ts",
        "src/lib/db.ts",
        "src/lib/platform-call.ts",
        "src/lib/platform.ts",
        "src/lib/shopify.ts",
        "src/lib/cron-runner.ts",
        "src/lib/cron-enqueue.ts",
        "src/routes/webhook.ts",
        "src/migrate.ts",
        # Infrastructure files — generator must not overwrite
        "package.json",
        "tsconfig.json",
        "Dockerfile",
    }
)


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
