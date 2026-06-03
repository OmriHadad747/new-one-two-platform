import { Request } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import { platform, QuotaExceeded } from "../lib/platform.js";
import type {
  InventoryLevelUpdatePayload,
  ProductDeletePayload,
  OrderPaidPayload,
  WaitlistEntryRow,
  RestockEventRow,
  NotificationSettingsRow,
  RestockEventId,
  WaitlistEntryId,
} from "../types/contracts.js";

// ─── Helper: check quiet hours ────────────────────────────────────────────────
function isInQuietHours(settings: NotificationSettingsRow): boolean {
  const nowHour = new Date().getUTCHours();
  const start = settings.quiet_hours_start;
  const end = settings.quiet_hours_end;

  if (start <= end) {
    // e.g. start=22, end=8 is midnight-crossing; start=8, end=18 is daytime
    return nowHour >= start && nowHour < end;
  } else {
    // wraps midnight: quiet from start..23 and 0..end
    return nowHour >= start || nowHour < end;
  }
}

// ─── Helper: render notification template ────────────────────────────────────
function renderTemplate(
  template: string,
  vars: { product_name: string; item_details: string; unsubscribe_url: string }
): string {
  return template
    .replace(/\{\{product_name\}\}/g, vars.product_name)
    .replace(/\{\{item_details\}\}/g, vars.item_details)
    .replace(/\{\{unsubscribe_url\}\}/g, vars.unsubscribe_url);
}

// ─── Webhook handlers ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const webhookHandlers: Record<string, (payload: any, req: Request) => Promise<void>> = {
  // ── inventory_levels/update ──────────────────────────────────────────────
  "inventory_levels/update": async (payload: InventoryLevelUpdatePayload, _req: Request): Promise<void> => {
    const inventoryItemId = payload.inventory_item_id;
    const available = payload.available;

    console.log(
      { topic: "inventory_levels/update", inventoryItemId, available },
      "inventory level update received"
    );

    // Only process restocks (available > 0)
    if (available <= 0) {
      console.log({ topic: "inventory_levels/update", inventoryItemId }, "available <= 0, skipping");
      return;
    }

    // Resolve variant external id via Admin GraphQL inventoryItem query
    const shopify = await shopifyClientFor();
    const invData = await shopify.graphql<{
      inventoryItem: {
        id: string;
        variant: {
          id: string;
          product: { id: string };
        };
      } | null;
    }>(
      `query ResolveVariant($id: ID!) {
         inventoryItem(id: $id) {
           id
           variant {
             id
             product { id }
           }
         }
       }`,
      { id: `gid://shopify/InventoryItem/${inventoryItemId}` }
    );

    if (!invData.inventoryItem) {
      console.warn(
        { topic: "inventory_levels/update", inventoryItemId },
        "inventoryItem not found in Shopify, skipping"
      );
      return;
    }

    const variantGid = invData.inventoryItem.variant.id; // e.g. "gid://shopify/ProductVariant/123"
    const productGid = invData.inventoryItem.variant.product.id; // e.g. "gid://shopify/Product/456"

    // Extract numeric IDs from GIDs
    const variantExternalId = parseInt(variantGid.split("/").pop() ?? "", 10);
    const productExternalId = parseInt(productGid.split("/").pop() ?? "", 10);

    if (isNaN(variantExternalId) || isNaN(productExternalId)) {
      console.error(
        { topic: "inventory_levels/update", inventoryItemId, variantGid, productGid },
        "failed to parse variant or product external id from GID"
      );
      return;
    }

    // Count active waitlist entries for this variant
    const [countRow] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM waitlist_entries
      WHERE item_external_id = ${variantExternalId}
        AND item_scope = 'variant'
        AND status = 'active'
    `;
    const activeWaitlistCount = parseInt(countRow?.count ?? "0", 10);

    if (activeWaitlistCount === 0) {
      console.log(
        { topic: "inventory_levels/update", variantExternalId },
        "no active waitlist entries, skipping restock event"
      );
      return;
    }

    const notificationBudget = Math.min(available, activeWaitlistCount);

    // Create restock event
    const [restockEvent] = await sql<RestockEventRow[]>`
      INSERT INTO restock_events
        (item_external_id, item_scope, inventory_item_external_id, available_quantity, notification_budget, notified_count, status)
      VALUES
        (${variantExternalId}, 'variant', ${inventoryItemId}, ${available}, ${notificationBudget}, 0, 'open')
      ON CONFLICT (inventory_item_external_id, status) DO NOTHING
      RETURNING *
    `;

    if (!restockEvent) {
      console.log(
        { topic: "inventory_levels/update", inventoryItemId },
        "restock event insert conflict (race), no-op"
      );
      return;
    }

    console.log(
      { topic: "inventory_levels/update", restockEventId: restockEvent.id, notificationBudget },
      "restock event created"
    );

    // Load notification settings for quiet hours check and template
    const [settings] = await sql<NotificationSettingsRow[]>`
      SELECT * FROM notification_settings LIMIT 1
    `;

    if (settings && isInQuietHours(settings)) {
      console.log(
        { topic: "inventory_levels/update", restockEventId: restockEvent.id },
        "quiet hours active, deferring notifications"
      );
      // Leave status as 'open'; a future re-delivery or cron could pick this up.
      // The plan states we hold the entire batch during quiet hours.
      return;
    }

    // Dispatch notifications
    await dispatchRestockNotifications(restockEvent.id as RestockEventId, settings ?? null, variantExternalId);
  },

  // ── products/delete ──────────────────────────────────────────────────────
  "products/delete": async (payload: ProductDeletePayload, _req: Request): Promise<void> => {
    const productExternalId = payload.id;

    console.log(
      { topic: "products/delete", productExternalId },
      "product delete received"
    );

    // Purge all waitlist entries for this product
    const purged = await sql<{ id: string }[]>`
      UPDATE waitlist_entries
      SET status = 'purged'
      WHERE product_external_id = ${productExternalId}
        AND status NOT IN ('purged', 'converted', 'unsubscribed')
      RETURNING id
    `;

    console.log(
      { topic: "products/delete", productExternalId, purgedCount: purged.length },
      "waitlist entries purged"
    );
  },

  // ── orders/paid ──────────────────────────────────────────────────────────
  "orders/paid": async (payload: OrderPaidPayload, _req: Request): Promise<void> => {
    const orderExternalId = payload.id;
    const customerEmail = payload.email;
    const lineItems = payload.line_items;

    console.log(
      { topic: "orders/paid", orderExternalId },
      "paid order received"
    );

    // Edge case: no email in payload — skip conversion matching
    if (!customerEmail) {
      console.warn(
        { topic: "orders/paid", orderExternalId },
        "no customer email in order payload, skipping conversion matching"
      );
      return;
    }

    // Check idempotency: if any conversion for this order already exists, skip
    const [existingConversion] = await sql<{ id: string }[]>`
      SELECT id FROM conversion_records
      WHERE order_external_id = ${orderExternalId}
      LIMIT 1
    `;

    if (existingConversion) {
      console.log(
        { topic: "orders/paid", orderExternalId },
        "conversion already recorded for this order, no-op"
      );
      return;
    }

    // Collect purchased variant external ids from line items
    const purchasedVariantIds: number[] = [];
    for (const item of lineItems) {
      if (item.variant_id != null) {
        purchasedVariantIds.push(item.variant_id);
      }
    }

    if (purchasedVariantIds.length === 0) {
      console.log(
        { topic: "orders/paid", orderExternalId },
        "no variant ids in line items, skipping conversion matching"
      );
      return;
    }

    // Match notified waitlist entries within 7-day attribution window
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    for (const variantId of purchasedVariantIds) {
      const matchingEntries = await sql<WaitlistEntryRow[]>`
        SELECT *
        FROM waitlist_entries
        WHERE email = ${customerEmail}
          AND item_external_id = ${variantId}
          AND status = 'notified'
          AND notified_at >= ${sevenDaysAgo}
      `;

      for (const entry of matchingEntries) {
        // Record conversion — ON CONFLICT on (waitlist_entry_id, order_external_id) for idempotency
        await sql`
          INSERT INTO conversion_records
            (waitlist_entry_id, order_external_id, item_external_id, converted_at)
          VALUES
            (${entry.id}, ${orderExternalId}, ${variantId}, now())
          ON CONFLICT (waitlist_entry_id, order_external_id) DO NOTHING
        `;

        // Update waitlist entry to converted status
        await sql`
          UPDATE waitlist_entries
          SET status = 'converted', converted_at = now()
          WHERE id = ${entry.id}
            AND status = 'notified'
        `;

        console.log(
          { topic: "orders/paid", orderExternalId, entryId: entry.id, variantId },
          "conversion recorded"
        );
      }
    }
  },
};

// ─── Dispatch restock notifications ──────────────────────────────────────────
async function dispatchRestockNotifications(
  restockEventId: RestockEventId,
  settings: NotificationSettingsRow | null,
  itemExternalId: number
): Promise<void> {
  // Mark event as dispatching
  await sql`
    UPDATE restock_events
    SET status = 'dispatching'
    WHERE id = ${restockEventId}
      AND status = 'open'
  `;

  // Load the restock event to get budget
  const [event] = await sql<RestockEventRow[]>`
    SELECT * FROM restock_events WHERE id = ${restockEventId}
  `;

  if (!event) {
    console.error({ restockEventId }, "restock event not found during dispatch");
    return;
  }

  const budget = event.notification_budget;

  // Fetch active waitlist entries ordered by queue position, up to budget
  const entries = await sql<WaitlistEntryRow[]>`
    SELECT *
    FROM waitlist_entries
    WHERE item_external_id = ${itemExternalId}
      AND item_scope = 'variant'
      AND status = 'active'
    ORDER BY queue_position ASC
    LIMIT ${budget}
  `;

  const defaultSubject = "You're back in luck! {{product_name}} is back in stock";
  const defaultBody =
    "Good news! {{item_details}} is now back in stock.\n\nShop now before it sells out again.\n\nTo unsubscribe from all back-in-stock notifications, click here: {{unsubscribe_url}}";

  const subject = settings?.template_subject ?? defaultSubject;
  const body = settings?.template_body ?? defaultBody;

  let notifiedCount = 0;

  for (const entry of entries) {
    const unsubscribeUrl = `${process.env.APP_URL ?? ""}/widget/unsubscribe?token=${entry.unsubscribe_token}`;
    const renderedSubject = renderTemplate(subject, {
      product_name: "your item",
      item_details: `Item #${String(entry.item_external_id)}`,
      unsubscribe_url: unsubscribeUrl,
    });
    const renderedBody = renderTemplate(body, {
      product_name: "your item",
      item_details: `Item #${String(entry.item_external_id)}`,
      unsubscribe_url: unsubscribeUrl,
    });

    try {
      const result = await platform.email.send({
        to: entry.email,
        data: {
          subject: renderedSubject,
          body: renderedBody,
        },
      });

      if (result.delivered) {
        // Mark entry as notified
        await sql`
          UPDATE waitlist_entries
          SET status = 'notified',
              restock_event_id = ${restockEventId},
              notified_at = now()
          WHERE id = ${entry.id as WaitlistEntryId}
            AND status = 'active'
        `;
        notifiedCount++;
        console.log({ restockEventId, entryId: entry.id }, "notification sent");
      } else {
        console.warn({ restockEventId, entryId: entry.id, reason: result.reason }, "email not delivered");
        // Entry retains 'notified' intent — mark as notified anyway so merchant can diagnose
        // per edge case spec: "failed entry retains its notified status"
        await sql`
          UPDATE waitlist_entries
          SET status = 'notified',
              restock_event_id = ${restockEventId},
              notified_at = now()
          WHERE id = ${entry.id as WaitlistEntryId}
            AND status = 'active'
        `;
        notifiedCount++;
      }
    } catch (err) {
      if (err instanceof QuotaExceeded) {
        console.warn({ restockEventId, limit: err.limit, resetsAt: err.resetsAt }, "email quota exceeded, stopping dispatch");
        break;
      }
      // Log failure and continue with remaining entries
      console.error({ restockEventId, entryId: entry.id, err: String(err) }, "email send error, continuing");
    }
  }

  // Update restock event with final notified count and status
  const newStatus = notifiedCount >= budget ? "completed" : "dispatching";
  await sql`
    UPDATE restock_events
    SET notified_count = ${notifiedCount},
        status = ${newStatus}
    WHERE id = ${restockEventId}
  `;

  console.log(
    { restockEventId, notifiedCount, budget, newStatus },
    "restock notification dispatch complete"
  );
}
