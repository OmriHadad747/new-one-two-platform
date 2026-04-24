import { sql } from "./db.js";

/**
 * Enqueue a cron job for immediate execution.
 *
 * Inserts one row into the template-owned `cron_queue` table. The template's
 * cron-runner picks it up on the next poll tick (FOR UPDATE SKIP LOCKED),
 * dispatches to `jobs[jobName]` in src/routes/cron.ts, and handles retries.
 *
 * Use this from admin routes or webhook handlers to trigger an ad-hoc run
 * of a cron job — e.g. a "Run now" button, or a webhook that wants to
 * spawn a follow-up scheduled job. Scheduled pg_cron runs are handled
 * automatically and do NOT go through this helper.
 *
 * @param jobName Must match a key in the `jobs` map exported from
 *                src/routes/cron.ts (the template dispatcher looks it up
 *                by that exact string).
 * @param payload Arbitrary JSON-serializable data passed to the JobFn as
 *                its single argument. Defaults to {}.
 */
export async function enqueueJob(
  jobName: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await sql`
    INSERT INTO cron_queue (job_name, payload)
    VALUES (${jobName}, ${JSON.stringify(payload)}::jsonb)
  `;
}
