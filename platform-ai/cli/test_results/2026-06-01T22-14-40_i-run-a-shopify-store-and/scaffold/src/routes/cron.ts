import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import { platform, QuotaExceeded } from "../lib/platform.js";
import type {
  NotificationSendWithContext,
  EmailTemplateRow,
  AppSettingsRow,
  NotificationSchedulerPayload,
  ProductVariantQueryResponse,
} from "../types/contracts.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isWithinQuietHours(quietStart: number, quietEnd: number): boolean {
  const nowHour = new Date().getUTCHours();
  // If start < end: quiet is within a single day (e.g. 22:00–08:00 wraps)
  if (quietStart > quietEnd) {
    // e.g. quiet from 22 to 8: quiet if hour >= 22 OR hour < 8
    return nowHour >= quietStart || nowHour < quietEnd;
  } else if (quietStart < quietEnd) {
    // e.g. quiet from 2 to 6: quiet if 2 <= hour < 6
    return nowHour >= quietStart && nowHour < quietEnd;
  }
  // quietStart === quietEnd: no quiet period
  return false;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

// ─── send_notifications cron job ─────────────────────────────────────────────
// Runs every 2 minutes. Reads queued notification sends within allowed hours,
// sends each personalised email, marks each send as dispatched.

async function runNotificationScheduler(_payload: NotificationSchedulerPayload): Promise<void> {
  console.log({ jobName: "send_notifications" }, "scheduler tick started");

  // Read app settings (singleton)
  const settingsRows = await sql<AppSettingsRow[]>`
    SELECT quiet_hours_start, quiet_hours_end, per_restock_notify_cap FROM app_settings LIMIT 1
  `;
  const settings = settingsRows[0];
  const quietStart = settings?.quiet_hours_start ?? 22;
  const quietEnd = settings?.quiet_hours_end ?? 8;

  // Check quiet hours
  if (isWithinQuietHours(quietStart, quietEnd)) {
    console.log({ jobName: "send_notifications" }, "within quiet hours, skipping");
    return;
  }

  // Read email template (singleton)
  const templateRows = await sql<EmailTemplateRow[]>`
    SELECT subject_template, body_template FROM email_template LIMIT 1
  `;
  const emailTemplate = templateRows[0];
  if (!emailTemplate) {
    console.warn({ jobName: "send_notifications" }, "no email template configured, skipping");
    return;
  }

  // Find queued sends from open batches, ordered by queue_position
  // Join to check that the waitlist entry is still active and the batch is still open
  const pendingSends = await sql<NotificationSendWithContext[]>`
    SELECT
      ns.id,
      ns.batch_id,
      ns.waitlist_entry_id,
      ns.shopper_email,
      ns.queue_position,
      ns.status,
      ns.failure_reason,
      ns.queued_at,
      ns.dispatched_at,
      nb.product_external_id AS batch_product_external_id,
      nb.variant_external_id AS batch_variant_external_id,
      we.unsubscribe_token
    FROM notification_sends ns
    JOIN notification_batches nb ON nb.id = ns.batch_id
    JOIN waitlist_entries we ON we.id = ns.waitlist_entry_id
    WHERE ns.status = 'queued'
      AND nb.status = 'open'
      AND we.status = 'active'
      AND we.deleted_at IS NULL
    ORDER BY ns.queue_position ASC
    LIMIT 50
  `;

  if (pendingSends.length === 0) {
    console.log({ jobName: "send_notifications" }, "no queued sends, done");
    return;
  }

  const shopify = await shopifyClientFor();

  // Cache variant details to avoid repeated Shopify calls per batch
  const variantDetailsCache = new Map<string, {
    variantTitle: string;
    productTitle: string;
    productUrl: string;
  }>();

  for (const send of pendingSends) {
    const variantId = send.batch_variant_external_id;
    if (!variantId) {
      // Product-level waitlist — skip if no variant (shouldn't happen in practice)
      console.warn({ jobName: "send_notifications", send_id: send.id }, "no variant id on batch, skipping send");
      await sql`
        UPDATE notification_sends
        SET status = 'skipped'
        WHERE id = ${send.id}
      `;
      continue;
    }

    // Fetch variant details (with cache)
    const cacheKey = String(variantId);
    let variantDetails = variantDetailsCache.get(cacheKey);

    if (!variantDetails) {
      try {
        const variantData = await shopify.graphql<ProductVariantQueryResponse>(
          `query GetVariant($id: ID!) {
             productVariant(id: $id) {
               id
               title
               product {
                 id
                 title
                 handle
                 onlineStoreUrl
               }
             }
           }`,
          { id: `gid://shopify/ProductVariant/${variantId}` },
        );

        if (!variantData.productVariant) {
          console.warn({ jobName: "send_notifications", variant_id: variantId }, "variant not found, skipping send");
          await sql`
            UPDATE notification_sends
            SET status = 'skipped', failure_reason = 'variant not found in Shopify'
            WHERE id = ${send.id}
          `;
          continue;
        }

        const pv = variantData.productVariant;
        variantDetails = {
          variantTitle: pv.title.replace(/\x00/g, ""),
          productTitle: pv.product.title.replace(/\x00/g, ""),
          productUrl: pv.product.onlineStoreUrl ?? `https://${pv.product.handle}`,
        };
        variantDetailsCache.set(cacheKey, variantDetails);
      } catch (err) {
        console.error({ jobName: "send_notifications", send_id: send.id, err: String(err) }, "error fetching variant");
        await sql`
          UPDATE notification_sends
          SET status = 'failed', failure_reason = ${`Shopify error: ${String(err)}`.slice(0, 4000)}
          WHERE id = ${send.id}
        `;
        continue;
      }
    }

    // Build unsubscribe URL — the token is embedded, host reads from req context
    const unsubscribeUrl = `{{app_base_url}}/widget/unsubscribe?token=${send.unsubscribe_token}`;

    // Render subject and body
    const vars: Record<string, string> = {
      product_name: variantDetails.productTitle,
      variant_label: variantDetails.variantTitle,
      product_url: variantDetails.productUrl,
      unsubscribe_url: unsubscribeUrl,
    };

    const subject = renderTemplate(emailTemplate.subject_template, vars);
    const body = renderTemplate(emailTemplate.body_template, vars);

    // Send email
    try {
      const result = await platform.email.send({
        to: send.shopper_email,
        data: {
          subject,
          body,
          productTitle: variantDetails.productTitle,
          variantLabel: variantDetails.variantTitle,
          productUrl: variantDetails.productUrl,
          unsubscribeUrl,
        },
      });

      if (result.delivered) {
        // Mark as dispatched
        await sql`
          UPDATE notification_sends
          SET status = 'dispatched', dispatched_at = now()
          WHERE id = ${send.id}
        `;

        // Mark waitlist entry as notified
        await sql`
          UPDATE waitlist_entries
          SET status = 'notified'
          WHERE id = ${send.waitlist_entry_id}
            AND status = 'active'
        `;

        // Increment batch total_sent
        await sql`
          UPDATE notification_batches
          SET total_sent = total_sent + 1
          WHERE id = ${send.batch_id}
        `;

        // Update snapshot total_notified_count
        await sql`
          UPDATE waitlist_snapshots
          SET
            total_notified_count = total_notified_count + 1,
            active_entry_count = GREATEST(0, active_entry_count - 1),
            last_updated_at = now()
          WHERE product_external_id = ${send.batch_product_external_id}
        `;

        console.log(
          { jobName: "send_notifications", send_id: send.id, delivery_id: result.deliveryId },
          "email sent",
        );
      } else {
        // Delivery suppressed or failed at provider
        await sql`
          UPDATE notification_sends
          SET
            status = 'failed',
            failure_reason = ${(result.reason ?? "provider not delivered").slice(0, 4000)}
          WHERE id = ${send.id}
        `;

        console.warn(
          { jobName: "send_notifications", send_id: send.id, reason: result.reason },
          "email not delivered",
        );
      }
    } catch (err) {
      if (err instanceof QuotaExceeded) {
        console.warn(
          { jobName: "send_notifications", limit: err.limit, resetsAt: err.resetsAt },
          "email quota exceeded, stopping scheduler",
        );
        return; // Stop the loop — quota is global
      }

      // Record failure but continue with next send
      await sql`
        UPDATE notification_sends
        SET
          status = 'failed',
          failure_reason = ${String(err).slice(0, 4000)}
        WHERE id = ${send.id}
      `;

      console.error({ jobName: "send_notifications", send_id: send.id, err: String(err) }, "email send error");
    }
  }

  // Close batches that are fully sent (total_sent >= total_queued)
  await sql`
    UPDATE notification_batches
    SET status = 'completed'
    WHERE status = 'open'
      AND total_queued > 0
      AND total_sent >= total_queued
  `;

  console.log({ jobName: "send_notifications", processed: pendingSends.length }, "scheduler tick complete");
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const jobs = {
  send_notifications: async (payload: NotificationSchedulerPayload) => runNotificationScheduler(payload),
};
