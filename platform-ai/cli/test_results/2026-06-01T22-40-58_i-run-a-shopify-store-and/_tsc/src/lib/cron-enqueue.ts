import { sql } from "./db.js";

const MAX_NAME_LEN = 256;

export interface EnqueueOptions {
  /**
   * Optional idempotency key. When set, a second enqueue of the same
   * (jobName, dedupKey) is a silent no-op IF a prior row with that
   * pair is still pending or processing. Once the prior row finishes
   * ('done' or 'failed'), a fresh enqueue with the same dedupKey is
   * allowed again — the dedup is "in-flight only", not "one-shot
   * forever". Rows without a dedupKey are never deduplicated.
   */
  dedupKey?: string;
}

/**
 * Enqueue a cron job for immediate execution.
 *
 * Inserts one row into the template-owned `cron_queue` table. The
 * template's cron-runner picks it up on the next poll tick (FOR UPDATE
 * SKIP LOCKED), dispatches to `jobs[jobName]` in src/routes/cron.ts,
 * and handles retries.
 *
 * Use this from admin routes or webhook handlers to trigger an ad-hoc
 * run of a cron job — e.g. a "Run now" button, or a webhook spawning a
 * follow-up scheduled job. Scheduled pg_cron runs are handled
 * automatically and do NOT go through this helper.
 *
 * @param jobName  Must match a key in the `jobs` map exported from
 *                 src/routes/cron.ts. The DB doesn't validate this —
 *                 the cron-runner logs and marks the row 'failed' if
 *                 the name is unknown at dispatch time.
 * @param payload  Arbitrary JSON-serializable data passed to the JobFn
 *                 as its single argument. Defaults to {}.
 * @param opts     Optional config. Pass `dedupKey` for at-most-once
 *                 enqueue while a prior identical job is in flight.
 */
export async function enqueueJob(
  jobName: string,
  payload: Record<string, unknown> = {},
  opts: EnqueueOptions = {},
): Promise<void> {
  if (typeof jobName !== "string" || jobName.trim() === "") {
    throw new TypeError(
      `enqueueJob: jobName must be a non-empty string (got ${JSON.stringify(jobName)})`,
    );
  }
  if (jobName.length > MAX_NAME_LEN) {
    throw new TypeError(
      `enqueueJob: jobName must be ≤${MAX_NAME_LEN} chars (got ${jobName.length})`,
    );
  }

  const dedupKey = opts.dedupKey;
  if (dedupKey !== undefined) {
    if (typeof dedupKey !== "string" || dedupKey === "") {
      throw new TypeError(
        `enqueueJob: dedupKey must be a non-empty string when provided (got ${JSON.stringify(dedupKey)})`,
      );
    }
    if (dedupKey.length > MAX_NAME_LEN) {
      throw new TypeError(
        `enqueueJob: dedupKey must be ≤${MAX_NAME_LEN} chars (got ${dedupKey.length})`,
      );
    }
  }

  // ON CONFLICT DO NOTHING covers the partial unique index on
  // (job_name, dedup_key) WHERE dedup_key IS NOT NULL AND status IN
  // ('pending','processing'). Rows without a dedupKey have nothing to
  // collide with and are always inserted.
  await sql`
    INSERT INTO cron_queue (job_name, payload, dedup_key)
    VALUES (
      ${jobName},
      ${JSON.stringify(payload)}::jsonb,
      ${dedupKey ?? null}
    )
    ON CONFLICT DO NOTHING
  `;
}
