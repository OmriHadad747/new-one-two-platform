# component_rules/cron.md

Conventions for cron jobs. Read before writing any cron code.

## File and shape

One file: `scaffold/src/routes/cron.ts`.

Export shape:

```ts
export const jobs = {
  process_run:        async (payload) => { ... },
  sweep_rule_runs:    async (payload) => { ... },
  // one key per job — bare identifier (snake_case, NO quotes)
};
```

- Job names are bare identifier keys — `snake_case`, no quotes. The
  static validator's regex requires the identifier form.
- Job names come from `enqueueJob(name, ...)` callers and from any
  cron schedules in `app.json`'s `shopifyIntegration.cronSchedule`
  (currently a single global string; per-job scheduling is
  deployer-managed).

## Handler signature

```ts
async (payload: JobPayloadType) => Promise<void>
```

`payload` is whatever was passed to `enqueueJob(name, payload, ...)`.
Type it against the matching payload shape in `contracts.ts`.

NO Express `req` parameter. NO `req.platform`. For Shopify access,
call `shopifyClientFor()` with no argument — the zero-arg overload
reads shop identity from the job context.

## How jobs get invoked

The template ships a cron-runner that polls `cron_queue` (with `FOR
UPDATE SKIP LOCKED`), dispatches matched rows to `jobs[name]`, and
retries failures with exponential backoff (3 attempts: 30s, 5min,
30min). You do NOT write the runner — it's template-owned.

## Enqueueing from a route

HTTP routes that need long work return fast and enqueue:

```ts
import { enqueueJob } from "../lib/cron-enqueue.js";

// In a /widget or /admin route handler:
const [{ id: runId }] = await sql<{ id: string }[]>`
  INSERT INTO rule_runs (status) VALUES ('pending') RETURNING id
`;
await enqueueJob("process_run", { run_id: runId }, { dedupKey: runId });
res.status(202).json({ run_id: runId, status: "pending" });
```

`dedupKey` collapses concurrent enqueues of the same logical job — a
second enqueue with the same `(jobName, dedupKey)` while a prior row is
still pending/processing is a silent no-op. Use the parent record's id
as the dedupKey to make routes safe to retry.

NEVER write directly to `cron_queue` — always go through `enqueueJob`.

## Workflow lifecycles

For jobs that drive a row through `pending → running → completed/failed`,
use the `workflow` helper instead of hand-rolling claim + try/catch +
update:

```ts
import { workflow } from "../lib/workflow.js";

async (payload) => {
  const result = await workflow.attempt(
    "rule_runs",
    payload.run_id,
    { from: "pending" },
    async (row) => {
      // Side effects here. On throw, helper persists failure_reason
      // (truncated) and re-throws so the cron-runner sees the error.
      await processRow(row);
    },
  );
  if (!result) return; // someone else claimed it / wrong state
}
```

See [platform_helpers.md](../platform_helpers.md) for the full workflow
API and `runtime_examples/compute_workflow.md` for a working snippet.

## Stale sweepers — REQUIRED for workflow tables

Any table with a `workflow` kind state machine MUST have a stale-row
sweeper job:

```ts
sweep_rule_runs: async () => {
  await workflow.sweepStale("rule_runs", { ttlMinutes: 30 });
}
```

Schedule it via cron every ~10 minutes. Without it, rows that crash
mid-execution stay in `running` forever.

## Idempotency

Jobs can be invoked twice for the same logical row (retries, dedup
races). Make them safe:

- `workflow.attempt(...)` returns `null` if the row is already claimed —
  exit cleanly.
- For non-workflow side effects, use `INSERT ... ON CONFLICT (key) DO
  NOTHING` patterns to make writes idempotent.

## Logging

```ts
console.log({ jobName: "process_run", dedup_key: payload.run_id, ...fields }, "msg");
console.warn({ jobName, reason }, "skipped");
console.error({ jobName, err: String(err) }, "failed");
```

NO `req.platform` — undefined in cron context.

## Allowed imports

Same as backend (see [backend.md](backend.md)).
