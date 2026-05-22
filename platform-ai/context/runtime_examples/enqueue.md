# Runtime example: `enqueue`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

```ts
import { enqueueJob } from "../lib/cron-enqueue.js";

// Push one row onto the tenant's `cron_queue`. The template's cron-runner
// picks it up on the next poll tick (FOR UPDATE SKIP LOCKED), dispatches
// to `jobs[jobName]` in src/routes/cron.ts, retries on failure with
// exponential backoff (3 attempts: 30s, 5min, 30min), and sweeps stale
// rows. Use this from an HTTP route to break the request → background-work
// boundary so the route responds in <2s.
//
// `jobName` MUST be a key exported from src/routes/cron.ts; the LLD's
// enqueue cross-validator already enforced that this matches a
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
