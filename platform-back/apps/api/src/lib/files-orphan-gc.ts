import {
  deleteFileRow,
  getStalePendingFiles,
} from "@platform-back/db";
import { SKIP_GCS, deleteObject } from "@platform-back/files";
import { logger as baseLogger } from "@platform-back/logger";

// Orphan-GC sweeper for the resumable-upload flow.
//
// A row in files.status='pending' means the handler called
// /services/files/create-upload-url, we reserved quota, and handed back
// a PUT URL — but the handler never came back to call finalize. Causes
// include: handler crashed mid-upload, customer cancelled the operation,
// PUT itself failed, or the 1-hour URL expired before the handler got
// around to it.
//
// Without cleanup those rows hold tenant quota forever. This sweeper
// runs every SWEEP_INTERVAL_MS, looks for rows older than STALE_AFTER_SEC
// (generous grace beyond the upload URL TTL), best-effort deletes any
// partial GCS object, then hard-deletes the row.
//
// Run mode: an in-process setInterval owned by the api server. Fine at
// single-replica scale; with multiple replicas it'll run on each but the
// SQL is idempotent (stale rows that one replica claimed won't be seen
// by the next tick) so duplicates are harmless.

const logger = baseLogger.child({ service: "files-orphan-gc" });

// 2 hours — twice the upload URL TTL so there's no race between URL
// expiry and GC. Any handler in the middle of a long upload can still
// call finalize within this window.
const STALE_AFTER_SEC = 2 * 60 * 60;

// Every hour. Balances timeliness (don't let quota stay reserved for
// days) against Postgres load (one query per replica per tick).
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// Cap per tick to bound one sweep's duration — a flood of expiries
// shouldn't stall the event loop for minutes. Remaining rows get swept
// next tick.
const BATCH_SIZE = 200;

let handle: NodeJS.Timeout | null = null;

export function startOrphanGc(): void {
  if (handle) return;
  if (SKIP_GCS) {
    logger.info("SKIP_GCS=true — orphan GC disabled");
    return;
  }
  // First sweep after a short delay so app boot finishes before we
  // hit the DB. Then on a steady interval.
  handle = setInterval(() => {
    void runSweep().catch((err) =>
      logger.warn({ err }, "orphan GC sweep threw"),
    );
  }, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive solely for the timer — the HTTP
  // server is the thing that should hold the process up.
  handle.unref();
  logger.info({ intervalMs: SWEEP_INTERVAL_MS, staleAfterSec: STALE_AFTER_SEC }, "orphan GC started");
}

export function stopOrphanGc(): void {
  if (!handle) return;
  clearInterval(handle);
  handle = null;
}

async function runSweep(): Promise<void> {
  const stale = await getStalePendingFiles(STALE_AFTER_SEC, BATCH_SIZE);
  if (stale.length === 0) return;

  logger.info({ count: stale.length }, "orphan GC sweep claim");

  for (const row of stale) {
    // GCS delete first, then DB row. If GCS delete fails, leave the
    // row in place — next tick will retry. Flipping the row before the
    // object delete risks orphaning storage.
    try {
      await deleteObject(row.gcsObject);
    } catch (err) {
      logger.warn({ err, gcsObject: row.gcsObject }, "orphan GC object delete failed");
      continue;
    }
    try {
      await deleteFileRow(row.id);
    } catch (err) {
      // GCS object is already gone; DB row will get re-picked by the
      // next sweep and the DB delete retried. Object-delete above was
      // idempotent (ignoreNotFound) so a second run is safe.
      logger.warn({ err, fileId: row.id }, "orphan GC row delete failed");
    }
  }
}
