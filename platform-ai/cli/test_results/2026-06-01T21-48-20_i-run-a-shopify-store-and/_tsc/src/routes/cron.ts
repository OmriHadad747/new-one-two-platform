import { sql } from "../lib/db.js";
import { platform, QuotaExceeded } from "../lib/platform.js";
import {
  NotificationSendRow,
  EmailTemplateRow,
  AppSettingsRow,
  NotificationRunId,
  DeliverNotificationsPayload,
} from "../types/contracts.js";

// ─── Helper: is the current UTC hour inside quiet hours? ─────────────────────
function isQuietHour(currentHourUtc: number, start: number, end: number): boolean {
  if (start < end) {
    // Simple range: e.g. 9 to 17 → quiet between 9 and 16
    return currentHourUtc >= start && currentHourUtc < end;
  } else if (start > end) {
    // Wraps midnight: e.g. 22 to 7 → quiet from 22:00 or before 7:00
    return currentHourUtc >= start || currentHourUtc < end;
  } else {
    // start === end → no quiet period
    return false;
  }
}

// ─── Helper: render a simple template substituting {{key}} tokens ─────────────
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

// ─── deliver_notifications cron job ──────────────────────────────────────────
async function deliverNotifications(_payload: DeliverNotificationsPayload): Promise<void> {
  const jobName = "deliver_notifications";
  console.log({ jobName }, "starting email delivery tick");

  // Load app settings (with safe defaults if table is empty)
  const [settingsRow] = await sql<AppSettingsRow[]>`
    SELECT * FROM app_settings ORDER BY updated_at DESC LIMIT 1
  `;

  const quietHoursStart = settingsRow?.quiet_hours_start ?? 22;
  const quietHoursEnd = settingsRow?.quiet_hours_end ?? 8;
  const batchSize = settingsRow?.batch_size ?? 50;

  const currentHourUtc = new Date().getUTCHours();
  const currentlyQuiet = isQuietHour(currentHourUtc, quietHoursStart, quietHoursEnd);

  if (currentlyQuiet) {
    console.log(
      { jobName, currentHourUtc, quietHoursStart, quietHoursEnd },
      "inside quiet hours — holding enqueued sends"
    );
    // Mark any enqueued sends as held_quiet_hours so they're tracked
    await sql`
      UPDATE notification_sends
      SET status = 'held_quiet_hours'
      WHERE status = 'enqueued'
    `;
    return;
  }

  // Release any held sends (quiet period has ended)
  await sql`
    UPDATE notification_sends
    SET status = 'enqueued'
    WHERE status = 'held_quiet_hours'
  `;

  // Load email template
  const [templateRow] = await sql<EmailTemplateRow[]>`
    SELECT * FROM email_template ORDER BY updated_at DESC LIMIT 1
  `;

  const subjectTemplate =
    templateRow?.subject_template ??
    "{{product_name}} is back in stock!";
  const bodyTemplate =
    templateRow?.body_template ??
    "Hi,\n\nGreat news! {{product_name}} ({{variant_title}}) is back in stock.\n\nShop now: {{product_url}}\n\nUnsubscribe: {{unsubscribe_url}}";

  // Fetch enqueued sends up to batchSize, ordered by enqueued_at ASC
  const sends = await sql<NotificationSendRow[]>`
    SELECT ns.*
    FROM notification_sends ns
    WHERE ns.status = 'enqueued'
    ORDER BY ns.enqueued_at ASC
    LIMIT ${batchSize}
  `;

  if (sends.length === 0) {
    console.log({ jobName }, "no enqueued sends to process");
    return;
  }

  console.log({ jobName, count: sends.length }, "processing sends");

  // Track per-run dispatch counts to update aggregates once at the end
  const runDispatched = new Map<NotificationRunId, number>();
  const runFailed = new Map<NotificationRunId, number>();

  for (const send of sends) {
    // Look up the signup for this send to get unsubscribe token and product URL
    const [signup] = await sql<{
      unsubscribe_token: string;
      product_url: string;
      product_title: string;
      variant_title: string;
    }[]>`
      SELECT unsubscribe_token, product_url, product_title, variant_title
      FROM waitlist_signups
      WHERE id = ${send.signup_id}
      LIMIT 1
    `;

    if (!signup) {
      // Signup was deleted — mark send failed
      await sql`
        UPDATE notification_sends
        SET status = 'failed',
            failure_reason = 'signup not found'
        WHERE id = ${send.id}
      `;
      runFailed.set(send.run_id, (runFailed.get(send.run_id) ?? 0) + 1);
      continue;
    }

    // Build unsubscribe URL — this is a widget route
    const unsubscribeUrl = `/widget/unsubscribe?token=${encodeURIComponent(signup.unsubscribe_token)}`;

    const vars: Record<string, string> = {
      product_name: signup.product_title,
      variant_title: signup.variant_title,
      product_url: signup.product_url,
      unsubscribe_url: unsubscribeUrl,
    };

    const subject = renderTemplate(subjectTemplate, vars);
    const body = renderTemplate(bodyTemplate, vars);

    try {
      const result = await platform.email.send({
        to: send.shopper_email,
        subject,
        body,
        data: {
          productName: signup.product_title,
          variantTitle: signup.variant_title,
          productUrl: signup.product_url,
          unsubscribeUrl,
        },
      });

      const dispatchedAt = new Date().toISOString();

      if (result.delivered) {
        await sql`
          UPDATE notification_sends
          SET status = 'dispatched',
              dispatched_at = ${dispatchedAt}
          WHERE id = ${send.id}
        `;
        runDispatched.set(send.run_id, (runDispatched.get(send.run_id) ?? 0) + 1);

        // Update demand snapshot total_notified
        await sql`
          UPDATE demand_snapshots
          SET total_notified = total_notified + 1,
              snapshot_updated_at = now()
          WHERE variant_external_id = ${send.variant_external_id}
        `;

        // Mark signup as notified
        await sql`
          UPDATE waitlist_signups
          SET status = 'notified'
          WHERE id = ${send.signup_id}
            AND status = 'active'
        `;

        // Decrement active_signup_count in demand snapshot
        await sql`
          UPDATE demand_snapshots
          SET active_signup_count = GREATEST(0, active_signup_count - 1),
              snapshot_updated_at = now()
          WHERE variant_external_id = ${send.variant_external_id}
        `;

        console.log(
          { jobName, sendId: send.id, deliveryId: result.deliveryId },
          "email dispatched"
        );
      } else {
        const reason = result.reason ?? "unknown";
        await sql`
          UPDATE notification_sends
          SET status = 'failed',
              failure_reason = ${reason}
          WHERE id = ${send.id}
        `;
        runFailed.set(send.run_id, (runFailed.get(send.run_id) ?? 0) + 1);
        console.warn({ jobName, sendId: send.id, reason }, "email not delivered");
      }
    } catch (err) {
      if (err instanceof QuotaExceeded) {
        console.warn(
          { jobName, limit: err.limit, resetsAt: err.resetsAt },
          "email quota exceeded — stopping batch"
        );
        // Leave remaining sends as enqueued; they'll be picked up next tick
        break;
      }

      // Non-quota error — mark this send as failed and continue
      const reason = String(err).slice(0, 500);
      await sql`
        UPDATE notification_sends
        SET status = 'failed',
            failure_reason = ${reason}
        WHERE id = ${send.id}
      `;
      runFailed.set(send.run_id, (runFailed.get(send.run_id) ?? 0) + 1);
      console.error({ jobName, sendId: send.id, err: reason }, "email send failed");
    }
  }

  // Update run aggregates in batch
  for (const [runId, count] of runDispatched) {
    await sql`
      UPDATE notification_runs
      SET sends_dispatched = sends_dispatched + ${count}
      WHERE id = ${runId}
    `;
  }

  for (const [runId, count] of runFailed) {
    await sql`
      UPDATE notification_runs
      SET sends_failed = sends_failed + ${count}
      WHERE id = ${runId}
    `;
  }

  // Mark runs as completed when all their sends are terminal
  const allRunIds = [...new Set([...runDispatched.keys(), ...runFailed.keys()])];
  for (const runId of allRunIds) {
    await sql`
      UPDATE notification_runs nr
      SET status = 'completed'
      WHERE nr.id = ${runId}
        AND nr.status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM notification_sends
          WHERE run_id = ${runId}
            AND status IN ('enqueued', 'held_quiet_hours')
        )
    `;
  }

  console.log({ jobName, processed: sends.length }, "delivery tick complete");
}

// ─── Export ───────────────────────────────────────────────────────────────────
export const jobs = {
  deliver_notifications: async (payload: DeliverNotificationsPayload) =>
    deliverNotifications(payload),
};
