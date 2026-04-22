import { sweepStalePendingFiles, deleteFileRow } from "@platform-back/db";
import { SKIP_GCS, deleteObject } from "@platform-back/files";
import { logger as baseLogger } from "@platform-back/logger";

// Orphan-GC sweeper for the resumable-upload flow.
//
// A row in files.status='pending' means the handler called
// /services/files/create-upload-url, quota was reserved, and a signed
// PUT URL was handed back — but the handler never finalised. Causes:
// handler crashed mid-upload, PUT failed, URL expired. The cancel-upload
// endpoint clears rows immediately; this sweeper is the safety net.
//
// Multi-replica safety: sweepStalePendingFiles uses FOR UPDATE SKIP
// LOCKED inside an explicit transaction, so each replica only processes
// rows that no other replica is currently handling — no duplicate work
// and no wasted GCS round-trips.

const logger = baseLogger.child({ service: "files-orphan-gc" });

const STALE_AFTER_SEC = 2 * 60 * 60;      // 2 h — twice the upload URL TTL
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // every hour
const INITIAL_DELAY_MS = 60 * 1000;        // 1 min after boot before first sweep

let intervalHandle: NodeJS.Timeout | null = null;
let initialHandle: NodeJS.Timeout | null = null;

export function startOrphanGc(): void {
  if (intervalHandle) return;
  if (SKIP_GCS) {
    logger.info("SKIP_GCS=true — orphan GC disabled");
    return;
  }

  // Fire once shortly after boot so restarted replicas sweep promptly
  // rather than waiting up to an hour for the first interval tick.
  initialHandle = setTimeout(() => {
    void runSweep().catch((err) =>
      logger.warn({ err }, "orphan GC initial sweep threw"),
    );
  }, INITIAL_DELAY_MS);
  initialHandle.unref();

  intervalHandle = setInterval(() => {
    void runSweep().catch((err) =>
      logger.warn({ err }, "orphan GC sweep threw"),
    );
  }, SWEEP_INTERVAL_MS);
  intervalHandle.unref();

  logger.info(
    { intervalMs: SWEEP_INTERVAL_MS, initialDelayMs: INITIAL_DELAY_MS, staleAfterSec: STALE_AFTER_SEC },
    "orphan GC started",
  );
}

export function stopOrphanGc(): void {
  if (initialHandle) { clearTimeout(initialHandle); initialHandle = null; }
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

async function runSweep(): Promise<void> {
  const swept = await sweepStalePendingFiles(
    STALE_AFTER_SEC,
    200,
    async (row) => {
      // GCS delete first (idempotent via ignoreNotFound). If it fails,
      // skip the DB delete so the row is retried next tick.
      try {
        await deleteObject(row.gcsObject);
      } catch (err) {
        logger.warn(
          { err, gcsObject: row.gcsObject },
          "orphan GC: GCS delete failed — row left for retry",
        );
        return;
      }
      try {
        await deleteFileRow(row.id);
      } catch (err) {
        logger.warn({ err, fileId: row.id }, "orphan GC: row delete failed");
      }
    },
  );
  if (swept > 0) logger.info({ swept }, "orphan GC sweep complete");
}
