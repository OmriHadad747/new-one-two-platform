import { sql } from "../lib/db.js";
import { platform, QuotaExceeded } from "../lib/platform.js";
import { shopifyClientFor } from "../lib/shopify.js";
import type {
  NotificationSettingsRow,
  ProductVariantQueryResult,
  NotificationBatchId,
  WaitlistEntryId,
} from "../types/contracts.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parseHHMM(hhmm: string): { h: number; m: number } {
  const [h, m] = hhmm.split(":").map(Number);
  return { h: h ?? 0, m: m ?? 0 };
}

function isWithinSendWindow(now: Date, quietStart: string, quietEnd: string, timezone: string): boolean {
  const localStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);

  const [lhStr, lmStr] = localStr.split(":");
  const localH = parseInt(lhStr ?? "0", 10);
  const localM = parseInt(lmStr ?? "0", 10);
  const localMinutes = localH * 60 + localM;

  const startParsed = parseHHMM(quietStart);
  const endParsed = parseHHMM(quietEnd);
  const startMinutes = startParsed.h * 60 + startParsed.m;
  const endMinutes = endParsed.h * 60 + endParsed.m;

  // Returns true if NOT in quiet hours (i.e. within send window)
  if (startMinutes <= endMinutes) {
    return localMinutes < startMinutes || localMinutes >= endMinutes;
  } else {
    // Wrap-around (e.g. 22:00-07:00)
    return localMinutes >= endMinutes && localMinutes < startMinutes;
  }
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? `{{${key}}}`);
}

// ─── Job: dispatch_notification_batches ───────────────────────────────────────

async function dispatchNotificationBatches(_payload: Record<string, unknown>): Promise<void> {
  const now = new Date();
  console.log({ jobName: "dispatch_notification_batches", now }, "tick");

  // Load settings
  const [settings] = await sql<Pick<NotificationSettingsRow,
    "notification_subject_template" | "notification_body_template" |
    "quiet_hours_start" | "quiet_hours_end" | "timezone">[]>`
    SELECT notification_subject_template, notification_body_template,
           quiet_hours_start, quiet_hours_end, timezone
    FROM notification_settings
    LIMIT 1
  `;

  const quietStart = settings?.quiet_hours_start ?? "22:00";
  const quietEnd = settings?.quiet_hours_end ?? "08:00";
  const timezone = settings?.timezone ?? "America/New_York";
  const subjectTemplate = settings?.notification_subject_template ?? "{{product_name}} is back in stock!";
  const bodyTemplate = settings?.notification_body_template ??
    "<p>Great news! {{item_detail}} is back in stock.</p><p><a href=\"{{item_url}}\">Shop now</a></p><p><a href=\"{{unsubscribe_url}}\">Unsubscribe</a></p>";

  if (!isWithinSendWindow(now, quietStart, quietEnd, timezone)) {
    console.log({ jobName: "dispatch_notification_batches" }, "outside send window — skipping");
    return;
  }

  // Fetch pending batches
  const pendingBatches = await sql<{
    id: string;
    product_external_id: string;
    variant_external_id: string | null;
    variant_gid: string | null;
    available_quantity_at_detection: number;
  }[]>`
    SELECT id,
           product_external_id::text,
           variant_external_id::text,
           variant_gid,
           available_quantity_at_detection
    FROM notification_batches
    WHERE status = 'pending'
    AND scheduled_send_at <= ${now}
    ORDER BY scheduled_send_at ASC
    LIMIT 50
  `;

  if (pendingBatches.length === 0) {
    console.log({ jobName: "dispatch_notification_batches" }, "no pending batches");
    return;
  }

  const shopify = await shopifyClientFor();

  for (const batch of pendingBatches) {
    const batchId = batch.id as NotificationBatchId;
    const productIdStr = batch.product_external_id;
    const variantIdStr = batch.variant_external_id;
    const storedVariantGid = batch.variant_gid; // canonical GID from inventoryItem API response
    const availableQty = batch.available_quantity_at_detection;

    // Claim the batch atomically
    const [claimed] = await sql<{ id: string }[]>`
      UPDATE notification_batches
      SET status = 'sending'
      WHERE id = ${batchId}
      AND status = 'pending'
      RETURNING id
    `;

    if (!claimed) {
      console.log({ batchId }, "batch already claimed — skipping");
      continue;
    }

    // Re-confirm variant availability at send time
    if (variantIdStr !== null) {
      // Validate variantIdStr is numeric before constructing GID
      if (!/^\d+$/.test(variantIdStr)) {
        console.error({ batchId, variantIdStr }, "variant id is not numeric — completing batch without send");
        await sql`
          UPDATE notification_batches
          SET status = 'completed', completed_at = now()
          WHERE id = ${batchId}
        `;
        continue;
      }
      // Use only the canonical GID stored from the original inventoryItem Shopify API response.
      // If not available, skip the batch rather than fabricating a GID.
      if (!storedVariantGid) {
        console.error({ batchId, variantIdStr }, "no canonical variant GID stored — completing batch without send");
        await sql`
          UPDATE notification_batches
          SET status = 'completed', completed_at = now()
          WHERE id = ${batchId}
        `;
        continue;
      }
      const variantGidToCheck = storedVariantGid;
      const variantData = await shopify.graphql<ProductVariantQueryResult>(
        `query CheckVariant($id: ID!) {
           productVariant(id: $id) {
             id
             availableForSale
             inventoryQuantity
           }
         }`,
        { id: variantGidToCheck },
      );

      // confirmedGid is the canonical GID returned by the Shopify API
      const confirmedGid = variantData.productVariant?.id ?? variantGidToCheck;
      console.log({ batchId, confirmedGid, availableForSale: variantData.productVariant?.availableForSale }, "variant availability confirmed");

      if (!variantData.productVariant || !variantData.productVariant.availableForSale) {
        console.log({ batchId, variantId: variantIdStr }, "variant no longer available — cancelling batch");
        await sql`
          UPDATE notification_batches
          SET status = 'completed', completed_at = now()
          WHERE id = ${batchId}
        `;
        continue;
      }
    }

    // Fetch active waitlist entries ordered by signed_up_at (queue-order), capped by available qty
    type WaitlistPickRow = {
      id: string;
      shopper_email: string;
      item_display_name: string;
      item_page_url: string;
      unsubscribe_token: string;
    };

    let waitlistEntries: WaitlistPickRow[];

    if (variantIdStr !== null) {
      waitlistEntries = await sql<WaitlistPickRow[]>`
        SELECT id, shopper_email, item_display_name, item_page_url, unsubscribe_token
        FROM waitlist_entries
        WHERE product_external_id = ${productIdStr}::bigint
        AND variant_external_id = ${variantIdStr}::bigint
        AND status = 'active'
        ORDER BY signed_up_at ASC
        LIMIT ${availableQty}
      `;
    } else {
      waitlistEntries = await sql<WaitlistPickRow[]>`
        SELECT id, shopper_email, item_display_name, item_page_url, unsubscribe_token
        FROM waitlist_entries
        WHERE product_external_id = ${productIdStr}::bigint
        AND signup_level = 'product'
        AND status = 'active'
        ORDER BY signed_up_at ASC
        LIMIT ${availableQty}
      `;
    }

    if (waitlistEntries.length === 0) {
      console.log({ batchId }, "no active waitlist entries — completing batch");
      await sql`
        UPDATE notification_batches
        SET status = 'completed', completed_at = now()
        WHERE id = ${batchId}
      `;
      continue;
    }

    let emailsSent = 0;
    let quotaHit = false;

    for (const entry of waitlistEntries) {
      const entryId = entry.id as WaitlistEntryId;

      // Build unsubscribe URL using the shop domain stored in the environment
      const shopDomain = process.env["SHOP_DOMAIN"] ?? process.env["SHOPIFY_SHOP_DOMAIN"] ?? "";
      const unsubscribeUrl = `https://${shopDomain}/apps/back-in-stock/unsubscribe?token=${entry.unsubscribe_token}`;

      const emailVars: Record<string, string> = {
        product_name: entry.item_display_name,
        item_detail: entry.item_display_name,
        item_url: entry.item_page_url,
        unsubscribe_url: unsubscribeUrl,
      };

      const subject = renderTemplate(subjectTemplate, emailVars);
      const htmlBody = renderTemplate(bodyTemplate, emailVars);

      try {
        const result = await platform.email.send({
          to: entry.shopper_email,
          data: { subject, html: htmlBody },
        });

        if (result.delivered) {
          console.log({ batchId, entryId, deliveryId: result.deliveryId }, "email sent");
        } else {
          console.warn({ batchId, entryId, reason: result.reason }, "email not delivered");
        }
      } catch (err) {
        if (err instanceof QuotaExceeded) {
          console.warn({ batchId, limit: err.limit, resetsAt: err.resetsAt }, "email quota exceeded");
          quotaHit = true;
          break;
        }
        console.error({ batchId, entryId, err: String(err) }, "email send failed");
        continue;
      }

      // Mark entry as notified
      await sql`
        UPDATE waitlist_entries
        SET status = 'notified',
            notified_at = now(),
            notification_batch_id = ${batchId}
        WHERE id = ${entryId}
        AND status = 'active'
      `;

      emailsSent++;
    }

    if (quotaHit) {
      await sql`
        UPDATE notification_batches
        SET status = 'pending',
            entries_notified = entries_notified + ${emailsSent}
        WHERE id = ${batchId}
      `;
    } else {
      await sql`
        UPDATE notification_batches
        SET status = 'completed',
            completed_at = now(),
            entries_notified = entries_notified + ${emailsSent}
        WHERE id = ${batchId}
      `;

      // Refresh dashboard snapshot
      const activeCountRows = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM waitlist_entries
        WHERE product_external_id = ${productIdStr}::bigint
        AND (
          (${variantIdStr}::bigint IS NOT NULL AND variant_external_id = ${variantIdStr}::bigint)
          OR (${variantIdStr}::bigint IS NULL AND variant_external_id IS NULL)
        )
        AND status = 'active'
      `;
      const totalSignupsRows = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM waitlist_entries
        WHERE product_external_id = ${productIdStr}::bigint
        AND (
          (${variantIdStr}::bigint IS NOT NULL AND variant_external_id = ${variantIdStr}::bigint)
          OR (${variantIdStr}::bigint IS NULL AND variant_external_id IS NULL)
        )
      `;
      const totalNotifiedRows = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM waitlist_entries
        WHERE product_external_id = ${productIdStr}::bigint
        AND (
          (${variantIdStr}::bigint IS NOT NULL AND variant_external_id = ${variantIdStr}::bigint)
          OR (${variantIdStr}::bigint IS NULL AND variant_external_id IS NULL)
        )
        AND status IN ('notified', 'converted')
      `;
      const totalConversionsRows = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM conversions
        WHERE product_external_id = ${productIdStr}::bigint
        AND (
          (${variantIdStr}::bigint IS NOT NULL AND variant_external_id = ${variantIdStr}::bigint)
          OR (${variantIdStr}::bigint IS NULL AND variant_external_id IS NULL)
        )
      `;
      const [nameRow] = await sql<{ item_display_name: string }[]>`
        SELECT item_display_name FROM waitlist_entries
        WHERE product_external_id = ${productIdStr}::bigint
        AND (
          (${variantIdStr}::bigint IS NOT NULL AND variant_external_id = ${variantIdStr}::bigint)
          OR (${variantIdStr}::bigint IS NULL AND variant_external_id IS NULL)
        )
        LIMIT 1
      `;

      const activeCount = parseInt(activeCountRows[0]?.count ?? "0", 10);
      const totalSignups = parseInt(totalSignupsRows[0]?.count ?? "0", 10);
      const totalNotified = parseInt(totalNotifiedRows[0]?.count ?? "0", 10);
      const totalConversions = parseInt(totalConversionsRows[0]?.count ?? "0", 10);
      const displayName = nameRow?.item_display_name ?? "Unknown";

      if (variantIdStr !== null) {
        await sql`
          INSERT INTO dashboard_snapshots (
            product_external_id, variant_external_id, item_display_name,
            active_waitlist_count, total_signups, total_notified, total_conversions,
            last_restock_at, snapshot_updated_at
          ) VALUES (
            ${productIdStr}::bigint, ${variantIdStr}::bigint, ${displayName},
            ${activeCount}, ${totalSignups}, ${totalNotified}, ${totalConversions},
            now(), now()
          )
          ON CONFLICT (product_external_id, variant_external_id) DO UPDATE SET
            active_waitlist_count = EXCLUDED.active_waitlist_count,
            total_signups = EXCLUDED.total_signups,
            total_notified = EXCLUDED.total_notified,
            total_conversions = EXCLUDED.total_conversions,
            last_restock_at = now(),
            snapshot_updated_at = now()
        `;
      } else {
        // Product-level snapshot: NULL variant
        await sql`
          INSERT INTO dashboard_snapshots (
            product_external_id, variant_external_id, item_display_name,
            active_waitlist_count, total_signups, total_notified, total_conversions,
            last_restock_at, snapshot_updated_at
          ) VALUES (
            ${productIdStr}::bigint, NULL, ${displayName},
            ${activeCount}, ${totalSignups}, ${totalNotified}, ${totalConversions},
            now(), now()
          )
          ON CONFLICT (product_external_id, variant_external_id) DO UPDATE SET
            active_waitlist_count = EXCLUDED.active_waitlist_count,
            total_signups = EXCLUDED.total_signups,
            total_notified = EXCLUDED.total_notified,
            total_conversions = EXCLUDED.total_conversions,
            last_restock_at = now(),
            snapshot_updated_at = now()
        `;
      }
    }

    console.log({ batchId, emailsSent, quotaHit }, "batch processed");

    if (quotaHit) break;
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const jobs = {
  dispatch_notification_batches: dispatchNotificationBatches,
};
