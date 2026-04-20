import postgres from "postgres";
import { sql } from "./db.js";

// Cron runner.
//
// Design — "Option D" from the Phase 2 planning: pg_cron runs in the
// shared Postgres; each scheduled tick executes a single INSERT INTO
// cron_queue against this tenant's schema. The handler polls that queue
// with FOR UPDATE SKIP LOCKED so N container instances never dispatch the
// same row twice. A LISTEN/NOTIFY channel lets pg_cron's INSERT wake the
// handler near-instantly; a periodic safety-poll catches ticks that fire
// during a handler restart, and a sweeper reclaims rows stuck in
// 'processing' past the lease window.
//
// The generator's src/routes/cron.ts exports a `jobs` map keyed by job
// name. server.ts imports that map and passes it to startCronRunner when
// ENABLE_CRON_RUNNER=true.

// Lifecycle of a row:
//   pending   → claimed via UPDATE ... RETURNING ... FOR UPDATE SKIP LOCKED
//   processing → job body runs
//                ├─ success     → status='done', finished_at set
//                └─ exception   → attempts++; if attempts<MAX_ATTEMPTS,
//                                 requeue as pending with next_visible_at
//                                 set to NOW() + backoff; else status='failed'
//
// An instance that crashes mid-job leaves its row in 'processing'. The
// sweeper runs every SAFETY_POLL_MS and reverts rows whose started_at is
// older than LEASE_MS back to 'pending' (attempts unchanged — the lost
// attempt was a platform failure, not a job failure, and retrying once
// more is the right call).

export type JobFn = (payload: unknown) => Promise<void>;
export type JobsMap = Record<string, JobFn>;

const MAX_ATTEMPTS = 3;
const BACKOFF_SCHEDULE_MS = [30_000, 5 * 60_000, 30 * 60_000]; // 30s, 5m, 30m
const LEASE_MS = 10 * 60_000; // job must finish within 10 minutes
const SAFETY_POLL_MS = 5 * 60_000; // backup poll cadence when LISTEN silent
const SHUTDOWN_DRAIN_MS = 10_000; // how long stop() waits for in-flight jobs
const BATCH_SIZE = 10; // max rows claimed per poll tick

interface CronQueueRow {
  id: string;
  job_name: string;
  payload: unknown;
  attempts: number;
}

export interface CronRunnerHandle {
  stop(): Promise<void>;
}

export function startCronRunner(jobs: JobsMap): CronRunnerHandle {
  const channel = process.env["CRON_NOTIFY_CHANNEL"] ?? "cron_queue_tick";
  let stopping = false;
  let inFlight = 0;
  let safetyPoll: NodeJS.Timeout | null = null;
  let listenHandle: { unlisten: () => Promise<void> } | null = null;

  const awaken = (): void => {
    if (stopping) return;
    // Fire-and-forget — if a drainOnce is already mid-flight, we don't
    // pile up a second one; the next LISTEN or safety-poll will pick up
    // whatever's left.
    void drainOnce().catch((err) => {
      console.error({ err: String(err) }, "[cron-runner] drain error");
    });
  };

  async function drainOnce(): Promise<void> {
    for (;;) {
      if (stopping) return;
      const claimed = await claimBatch();
      if (claimed.length === 0) return;
      // Process sequentially within a tick — job concurrency inside one
      // instance isn't a Phase-2 goal, and sequential keeps postgres pool
      // pressure bounded.
      for (const row of claimed) {
        await runJob(row);
      }
    }
  }

  async function claimBatch(): Promise<CronQueueRow[]> {
    return sql<CronQueueRow[]>`
      UPDATE cron_queue
         SET status      = 'processing',
             started_at  = NOW(),
             attempts    = attempts + 1
       WHERE id IN (
         SELECT id
           FROM cron_queue
          WHERE status = 'pending'
            AND (next_visible_at IS NULL OR next_visible_at <= NOW())
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${BATCH_SIZE}
       )
      RETURNING id, job_name, payload, attempts
    `;
  }

  async function runJob(row: CronQueueRow): Promise<void> {
    inFlight += 1;
    const started = Date.now();
    try {
      const job = jobs[row.job_name];
      if (!job) {
        console.error(
          { jobId: row.id, jobName: row.job_name },
          "[cron-runner] no handler registered for job",
        );
        await sql`
          UPDATE cron_queue
             SET status = 'failed', finished_at = NOW()
           WHERE id = ${row.id}
        `;
        return;
      }
      await job(row.payload);
      await sql`
        UPDATE cron_queue
           SET status = 'done', finished_at = NOW()
         WHERE id = ${row.id}
      `;
      console.log(
        {
          jobId: row.id,
          jobName: row.job_name,
          attempt: row.attempts,
          durationMs: Date.now() - started,
        },
        "[cron-runner] job done",
      );
    } catch (err) {
      const attempt = row.attempts;
      if (attempt < MAX_ATTEMPTS) {
        const backoff = BACKOFF_SCHEDULE_MS[attempt - 1] ?? BACKOFF_SCHEDULE_MS.at(-1)!;
        await sql`
          UPDATE cron_queue
             SET status          = 'pending',
                 started_at      = NULL,
                 next_visible_at = NOW() + (${backoff} * INTERVAL '1 millisecond')
           WHERE id = ${row.id}
        `;
        console.warn(
          {
            jobId: row.id,
            jobName: row.job_name,
            attempt,
            nextAttemptIn: backoff,
            err: String(err),
          },
          "[cron-runner] job failed, will retry",
        );
      } else {
        await sql`
          UPDATE cron_queue
             SET status = 'failed', finished_at = NOW()
           WHERE id = ${row.id}
        `;
        console.error(
          {
            jobId: row.id,
            jobName: row.job_name,
            attempt,
            err: String(err),
          },
          "[cron-runner] job failed after max attempts",
        );
      }
    } finally {
      inFlight -= 1;
    }
  }

  async function sweepStale(): Promise<void> {
    if (stopping) return;
    try {
      const reclaimed = await sql<Array<{ id: string; job_name: string }>>`
        UPDATE cron_queue
           SET status          = 'pending',
               started_at      = NULL,
               next_visible_at = NULL
         WHERE status = 'processing'
           AND started_at < NOW() - (${LEASE_MS} * INTERVAL '1 millisecond')
        RETURNING id, job_name
      `;
      if (reclaimed.length > 0) {
        console.warn(
          { reclaimedCount: reclaimed.length },
          "[cron-runner] reclaimed stale processing rows",
        );
      }
    } catch (err) {
      console.error(
        { err: String(err) },
        "[cron-runner] sweepStale error",
      );
    }
  }

  async function startListening(): Promise<void> {
    try {
      listenHandle = await sql.listen(channel, () => awaken());
      console.log({ channel }, "[cron-runner] listening on notify channel");
    } catch (err) {
      // Degrades gracefully: safety-poll still fires every SAFETY_POLL_MS,
      // so the handler keeps making forward progress even without LISTEN
      // (just with more latency).
      console.error(
        { channel, err: String(err) },
        "[cron-runner] LISTEN setup failed — running poll-only",
      );
    }
  }

  // Boot sequence: one drain for catch-up, start LISTEN, start safety poll.
  void (async () => {
    console.log({ jobNames: Object.keys(jobs) }, "[cron-runner] starting");
    await sweepStale();
    await drainOnce();
    await startListening();
    safetyPoll = setInterval(() => {
      void sweepStale().then(() => awaken());
    }, SAFETY_POLL_MS);
    // Unref so the timer doesn't block process exit on graceful shutdown.
    if (safetyPoll.unref) safetyPoll.unref();
  })().catch((err) => {
    console.error({ err: String(err) }, "[cron-runner] boot failed");
  });

  async function stop(): Promise<void> {
    stopping = true;
    if (safetyPoll) {
      clearInterval(safetyPoll);
      safetyPoll = null;
    }
    if (listenHandle) {
      try {
        await listenHandle.unlisten();
      } catch {
        // Ignore — connection may already be closing.
      }
    }
    // Wait for in-flight jobs up to SHUTDOWN_DRAIN_MS; anything still
    // running past that will get reclaimed by the next instance's
    // sweepStale() via the LEASE_MS timeout.
    const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(
      { inFlightRemaining: inFlight },
      "[cron-runner] stopped",
    );
  }

  return { stop };
}

// Re-export postgres for the server boot file (only used to check that
// `sql.listen` is available; keeps the import surface compact).
export type { postgres };
