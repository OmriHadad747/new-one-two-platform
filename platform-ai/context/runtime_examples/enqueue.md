# Helper: `queue`

Use the `queue` helper (`enqueueJob`) to push work off the request path — any
HTTP route that would otherwise do more than ~2s of work (Shopify fan-out, bulk
writes, an email batch) enqueues a job and returns `202` immediately. Storage:
the template's `cron_queue` table and cron-runner are already provisioned — do
NOT add your own jobs table or polling loop.

```ts
import { enqueueJob } from "../lib/cron-enqueue.js";

// Push one row onto the tenant's `cron_queue`. The template's cron-runner
// picks it up on the next poll tick (FOR UPDATE SKIP LOCKED), dispatches
// to `jobs[jobName]` in src/routes/cron.ts, retries on failure with
// exponential backoff (3 attempts: 30s, 5min, 30min), and sweeps stale rows.
//
// `jobName` MUST be a key exported from src/routes/cron.ts; the LLD's
// enqueue cross-validator enforces that it matches a
// triggeredBy: "cron:<jobName>" recipe in the same plan.
//
// `payload` is arbitrary JSON-serialisable data; the cron JobFn receives
// it as its single argument.
//
// `dedupKey` (optional) collapses concurrent enqueues of the same logical
// job — a second enqueue with the same (jobName, dedupKey) while a prior
// row is still pending/processing is a silent no-op. Use the parent
// record's id as the dedupKey to make routes safe to retry.

await enqueueJob("process_run", { run_id: insertedRunId }, { dedupKey: insertedRunId });

// Pattern — HTTP route that spawns long work and returns 202:
//   1. await sql`INSERT INTO rule_runs (...) VALUES (...) RETURNING id` → runId
//   2. await enqueueJob("process_run", { run_id: runId }, { dedupKey: runId })
//   3. res.status(202).json({ run_id: runId, status: "pending" })
```

Rules:
- `jobName` must be a key in the `jobs` map exported from `src/routes/cron.ts`,
  and the plan must carry a matching `cron:<jobName>` recipe — never enqueue a
  job name that has no handler.
- Offload, don't block: the HTTP route enqueues and returns `202` with the new
  row id; it does NOT `await` the heavy work inline.
- Pass the parent record's id as `dedupKey` (a non-empty string) so a retried
  request is an at-most-once no-op, not a duplicate job.
- Don't hand-roll a queue: the `cron_queue` table, polling, backoff, and stale
  sweep already exist — reuse them.
