import { sql } from "../lib/db.js";
import { config } from "../lib/config.js";
import { workflow } from "../lib/workflow.js";
import { dispatchBatchEmails } from "./webhook-handlers.js";
import type { NotificationBatchId, NotificationBatchRow } from "../types/contracts.js";

// ─── helpers ────────────────────────────────────────────────────────────────

/** Check whether current UTC time is outside the quiet hours window */
function isOutsideQuietHours(startHHMM: string, endHHMM: string): boolean {
  const nowH = new Date().getUTCHours();
  const nowM = new Date().getUTCMinutes();
  const nowMins = nowH * 60 + nowM;

  const [sh, sm] = startHHMM.split(":").map(Number);
  const [eh, em] = endHHMM.split(":").map(Number);
  const startMins = (sh ?? 22) * 60 + (sm ?? 0);
  const endMins = (eh ?? 8) * 60 + (em ?? 0);

  let inQuiet: boolean;
  if (startMins < endMins) {
    // same-day window
    inQuiet = nowMins >= startMins && nowMins < endMins;
  } else {
    // overnight window e.g. 22:00-08:00
    inQuiet = nowMins >= startMins || nowMins < endMins;
  }

  return !inQuiet;
}

// ═══════════════════════════════════════════════════════════
// Cron jobs
// ═══════════════════════════════════════════════════════════

export const jobs = {
  /**
   * Sweeps stale notification_batches rows that have been stuck in 'processing'
   * for more than 60 minutes (e.g. due to a crash mid-dispatch).
   */
  sweep_stale_batches: async (_payload: Record<string, unknown>): Promise<void> => {
    const swept = await workflow.sweepStale("notification_batches", { ttlMinutes: 60 });
    console.log({ jobName: "sweep_stale_batches", swept }, "swept stale batches");
  },

  /**
   * Dispatches restock notification emails that were deferred because
   * the batch was created during the merchant-configured quiet hours window.
   * Runs every 15 minutes (configured in app.json cronSchedule).
   */
  dispatch_deferred_emails: async (_payload: Record<string, unknown>): Promise<void> => {
    const quietStart: string = await config.get("notification_quiet_start", "22:00");
    const quietEnd: string = await config.get("notification_quiet_end", "08:00");

    if (!isOutsideQuietHours(quietStart, quietEnd)) {
      console.log({ jobName: "dispatch_deferred_emails" }, "still in quiet hours — skipping");
      return;
    }

    // Find all pending batches that have pending sends
    // (batches created during quiet hours that haven't dispatched yet)
    const deferredBatches = await sql<{ id: NotificationBatchId; item_external_id: string }[]>`
      SELECT DISTINCT nb.id, nb.item_external_id
      FROM notification_batches nb
      JOIN notification_sends ns ON ns.batch_id = nb.id
      WHERE nb.status = 'pending'
        AND ns.status = 'pending'
        AND nb.deleted_at IS NULL
      ORDER BY nb.created_at ASC
    `;

    if (deferredBatches.length === 0) {
      console.log({ jobName: "dispatch_deferred_emails" }, "no deferred batches to process");
      return;
    }

    console.log(
      { jobName: "dispatch_deferred_emails", batchCount: deferredBatches.length },
      "dispatching deferred email batches",
    );

    for (const batch of deferredBatches) {
      // Use workflow.attempt to drive pending → running → completed/failed
      const result = await workflow.attempt<NotificationBatchRow, void>(
        "notification_batches",
        batch.id,
        { from: "pending" },
        async (_row) => {
          await dispatchBatchEmails(batch.id, batch.item_external_id);
        },
      );

      if (!result) {
        console.log(
          { jobName: "dispatch_deferred_emails", batchId: batch.id },
          "batch already claimed — skipping",
        );
      } else {
        console.log(
          { jobName: "dispatch_deferred_emails", batchId: batch.id },
          "batch dispatched",
        );
      }
    }
  },
};
