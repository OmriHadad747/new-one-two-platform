import type { Request } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import { config } from "../lib/config.js";
import { platform } from "../lib/platform.js";
import { workflow } from "../lib/workflow.js";
import type {
  InventoryLevelUpdatePayload,
  ProductDeletePayload,
  OrderPaidPayload,
  WaitlistSignupRow,
  NotificationBatchRow,
  NotificationSendId,
  NotificationBatchId,
  WaitlistSignupId,
} from "../types/contracts.js";

// ─── helpers ────────────────────────────────────────────────────────────────

/** Returns today's YYYY-MM-DD string (UTC) */
function todayBucket(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Strip NUL bytes from external strings before DB writes */
function safe(s: string): string {
  return s.replace(/\0/g, "");
}

/** Check whether current UTC hour falls within a quiet window (inclusive start, exclusive end) */
function isInQuietHours(startHHMM: string, endHHMM: string): boolean {
  const nowH = new Date().getUTCHours();
  const nowM = new Date().getUTCMinutes();
  const nowMins = nowH * 60 + nowM;

  const [sh, sm] = startHHMM.split(":").map(Number);
  const [eh, em] = endHHMM.split(":").map(Number);
  const startMins = (sh ?? 22) * 60 + (sm ?? 0);
  const endMins = (eh ?? 8) * 60 + (em ?? 0);

  if (startMins < endMins) {
    // same-day window e.g. 02:00-06:00
    return nowMins >= startMins && nowMins < endMins;
  }
  // overnight window e.g. 22:00-08:00
  return nowMins >= startMins || nowMins < endMins;
}

// ─── restock notification dispatcher ────────────────────────────────────────

/**
 * Given an open batch (and its pending sends), dispatch emails.
 * Callers are responsible for quiet-hours checks before calling this.
 * Used by the webhook handler (immediate dispatch) and the cron deferred-dispatch job.
 */
export async function dispatchBatchEmails(
  batchId: NotificationBatchId,
  itemExternalId: string,
): Promise<void> {
  // Fetch all pending sends for this batch, joined with signup data
  const sends = await sql<
    {
      send_id: NotificationSendId;
      batch_id: NotificationBatchId;
      signup_id: WaitlistSignupId;
      email: string;
      unsubscribe_token: string;
      item_external_id: string;
      item_type: string;
    }[]
  >`
    SELECT
      ns.id        AS send_id,
      ns.batch_id,
      ns.signup_id,
      ws.email,
      ws.unsubscribe_token,
      ws.item_external_id,
      ws.item_type
    FROM notification_sends ns
    JOIN waitlist_signups ws ON ws.id = ns.signup_id
    WHERE ns.batch_id = ${batchId}
      AND ns.status = 'pending'
    ORDER BY ws.signed_up_at ASC
  `;

  if (sends.length === 0) {
    // All already dispatched — nothing more to do (caller manages batch status via workflow)
    return;
  }

  // Fetch variant/product details for email
  const shopify = await shopifyClientFor();

  // Determine variant id to look up
  const firstSend = sends[0];
  if (!firstSend) return;

  const itemType = firstSend.item_type;
  const itemId = firstSend.item_external_id;

  // Validate itemId is numeric before constructing any GID
  if (!/^\d+$/.test(itemId)) {
    console.warn({ batchId, itemId }, "item_external_id is not numeric — skipping GID construction");
    return;
  }

  let productTitle = "your waitlisted item";
  let variantTitle = "";
  let productUrl = "";
  let variantImageUrl: string | null = null;

  if (itemType === "variant") {
    const variantGid = `gid://shopify/ProductVariant/${itemId}`;
    const variantData = await shopify.graphql<{
      productVariant: {
        id: string;
        displayName: string;
        title: string;
        image: { url: string } | null;
        product: {
          id: string;
          title: string;
          onlineStoreUrl: string | null;
        };
      } | null;
    }>(
      `query GetVariantForEmail($id: ID!) {
        productVariant(id: $id) {
          id
          displayName
          title
          image { url }
          product {
            id
            title
            onlineStoreUrl
          }
        }
      }`,
      { id: variantGid },
    );

    if (variantData.productVariant) {
      productTitle = safe(variantData.productVariant.product.title);
      variantTitle = safe(variantData.productVariant.displayName);
      productUrl = variantData.productVariant.product.onlineStoreUrl ?? "";
      variantImageUrl = variantData.productVariant.image?.url ?? null;
    }
  } else {
    // product-level signup
    const productGid = `gid://shopify/Product/${itemId}`;
    const productData = await shopify.graphql<{
      product: {
        id: string;
        title: string;
        onlineStoreUrl: string | null;
      } | null;
    }>(
      `query GetProductForEmail($id: ID!) {
        product(id: $id) {
          id
          title
          onlineStoreUrl
        }
      }`,
      { id: productGid },
    );

    if (productData.product) {
      productTitle = safe(productData.product.title);
      variantTitle = "";
      productUrl = productData.product.onlineStoreUrl ?? "";
    }
  }

  // Send emails in batch
  const emailItems = sends.map((s) => ({
    to: s.email,
    data: {
      productTitle,
      variantTitle,
      productUrl,
      variantImageUrl: variantImageUrl ?? "",
      unsubscribeToken: s.unsubscribe_token,
      sendId: s.send_id,
    },
  }));

  let emailsSentCount = 0;

  try {
    const batchResult = await platform.email.sendBatch(emailItems);

    for (const item of batchResult.items) {
      const send = sends[item.index];
      if (!send) continue;

      if (item.status === 200 && item.result.delivered) {
        await sql`
          UPDATE notification_sends
          SET status = 'sent', sent_at = now()
          WHERE id = ${send.send_id}
        `;
        emailsSentCount++;
      } else if (item.status === 429) {
        // quota exceeded for this item
        console.warn(
          { sendId: send.send_id, batchId },
          "email quota exceeded — stopping batch dispatch",
        );
        break;
      } else {
        await sql`
          UPDATE notification_sends
          SET status = 'failed'
          WHERE id = ${send.send_id}
        `;
        console.warn(
          { sendId: send.send_id, status: item.status },
          "email send failed for recipient",
        );
      }
    }
  } catch (err) {
    console.error({ batchId, err: String(err) }, "sendBatch threw unexpectedly");
  }

  // Increment emails_sent counter on batch
  if (emailsSentCount > 0) {
    await sql`
      UPDATE notification_batches
      SET emails_sent = emails_sent + ${emailsSentCount}
      WHERE id = ${batchId}
    `;
  }

  // Note: notification_batches.status is managed by workflow.attempt (caller-side)
  // This function only updates notification_sends rows and the emails_sent counter.
}

// ─── refresh demand stats snapshot ──────────────────────────────────────────

async function refreshDemandStatsSnapshot(
  itemExternalId: string,
  itemType: string,
  productExternalId: string,
): Promise<void> {
  // Validate ids are numeric before constructing any GIDs
  if (!/^\d+$/.test(itemExternalId)) {
    console.warn({ itemExternalId }, "item_external_id is not numeric — skipping snapshot refresh");
    return;
  }
  if (!/^\d+$/.test(productExternalId)) {
    console.warn({ productExternalId }, "product_external_id is not numeric — skipping snapshot refresh");
    return;
  }

  const shopify = await shopifyClientFor();

  let productTitle: string | null = null;
  let variantTitle: string | null = null;

  if (itemType === "variant") {
    const variantGid = `gid://shopify/ProductVariant/${itemExternalId}`;
    const data = await shopify.graphql<{
      productVariant: {
        displayName: string;
        product: { title: string };
      } | null;
    }>(
      `query GetVariantSnapshot($id: ID!) {
        productVariant(id: $id) {
          displayName
          product { title }
        }
      }`,
      { id: variantGid },
    );
    if (data.productVariant) {
      productTitle = safe(data.productVariant.product.title);
      variantTitle = safe(data.productVariant.displayName);
    }
  } else {
    const productGid = `gid://shopify/Product/${itemExternalId}`;
    const data = await shopify.graphql<{
      product: { title: string } | null;
    }>(
      `query GetProductSnapshot($id: ID!) {
        product(id: $id) { title }
      }`,
      { id: productGid },
    );
    if (data.product) {
      productTitle = safe(data.product.title);
      variantTitle = null;
    }
  }

  // Compute aggregates
  const [counts] = await sql<{
    waitlist_count: string;
    total_signups: string;
    total_notified: string;
  }[]>`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending')   AS waitlist_count,
      COUNT(*)                                      AS total_signups,
      COUNT(*) FILTER (WHERE status = 'notified')  AS total_notified
    FROM waitlist_signups
    WHERE item_external_id = ${itemExternalId}
      AND deleted_at IS NULL
  `;

  const [convCounts] = await sql<{ total_conversions: string }[]>`
    SELECT COUNT(*) AS total_conversions
    FROM conversions
    WHERE item_external_id = ${itemExternalId}
  `;

  const waitlistCount = parseInt(counts?.waitlist_count ?? "0", 10);
  const totalSignups = parseInt(counts?.total_signups ?? "0", 10);
  const totalNotified = parseInt(counts?.total_notified ?? "0", 10);
  const totalConversions = parseInt(convCounts?.total_conversions ?? "0", 10);

  await sql`
    INSERT INTO demand_stats_snapshots
      (item_external_id, item_type, product_external_id, product_title, variant_title,
       waitlist_count, total_signups, total_notified, total_conversions, last_refreshed_at)
    VALUES
      (${itemExternalId}, ${itemType}, ${productExternalId},
       ${productTitle}, ${variantTitle},
       ${waitlistCount}, ${totalSignups}, ${totalNotified}, ${totalConversions}, now())
    ON CONFLICT (item_external_id)
    DO UPDATE SET
      item_type             = EXCLUDED.item_type,
      product_external_id   = EXCLUDED.product_external_id,
      product_title         = EXCLUDED.product_title,
      variant_title         = EXCLUDED.variant_title,
      waitlist_count        = EXCLUDED.waitlist_count,
      total_signups         = EXCLUDED.total_signups,
      total_notified        = EXCLUDED.total_notified,
      total_conversions     = EXCLUDED.total_conversions,
      last_refreshed_at     = now()
  `;
}

// ═══════════════════════════════════════════════════════════
// Webhook handlers
// ═══════════════════════════════════════════════════════════

export const webhookHandlers: Record<
  string,
  (payload: unknown, req: Request) => Promise<void>
> = {
  // ── inventory_levels/update ──────────────────────────────
  "inventory_levels/update": async (
    rawPayload: unknown,
    _req: Request,
  ): Promise<void> => {
    const payload = rawPayload as InventoryLevelUpdatePayload;
    const inventoryItemId = payload.inventory_item_id;
    const available = payload.available;
    const locationId = payload.location_id;

    console.log(
      { topic: "inventory_levels/update", inventoryItemId, available, locationId },
      "received",
    );

    // Only proceed when available quantity is positive (restock event)
    if (available === null || available <= 0) {
      console.log(
        { topic: "inventory_levels/update", inventoryItemId, available },
        "not a restock — skipping",
      );
      return;
    }

    // Resolve variant and product external ids via inventoryItem query
    const shopify = await shopifyClientFor();
    const inventoryGid = `gid://shopify/InventoryItem/${inventoryItemId}`;

    const invData = await shopify.graphql<{
      inventoryItem: {
        id: string;
        variant: {
          id: string;
          product: { id: string };
        };
      } | null;
    }>(
      `query ResolveInventoryItem($id: ID!) {
        inventoryItem(id: $id) {
          id
          variant {
            id
            product { id }
          }
        }
      }`,
      { id: inventoryGid },
    );

    if (!invData.inventoryItem) {
      console.warn(
        { topic: "inventory_levels/update", inventoryItemId },
        "inventoryItem not found — skipping",
      );
      return;
    }

    // Extract numeric ids from GIDs
    const variantGid = invData.inventoryItem.variant.id; // gid://shopify/ProductVariant/XXX
    const productGid = invData.inventoryItem.variant.product.id;

    const variantExternalId = variantGid.split("/").pop() ?? "";
    const productExternalId = productGid.split("/").pop() ?? "";

    if (!variantExternalId || !productExternalId) {
      console.warn(
        { topic: "inventory_levels/update", inventoryItemId },
        "could not parse variant/product id from GID — skipping",
      );
      return;
    }

    // Check for pending signups for this variant (variant-level)
    const [pendingCount] = await sql<{ cnt: string }[]>`
      SELECT COUNT(*) AS cnt
      FROM waitlist_signups
      WHERE item_external_id = ${variantExternalId}
        AND status = 'pending'
        AND deleted_at IS NULL
    `;
    const hasPending = parseInt(pendingCount?.cnt ?? "0", 10) > 0;

    // Also check product-level signups
    const [productPendingCount] = await sql<{ cnt: string }[]>`
      SELECT COUNT(*) AS cnt
      FROM waitlist_signups
      WHERE item_external_id = ${productExternalId}
        AND item_type = 'product'
        AND status = 'pending'
        AND deleted_at IS NULL
    `;
    const hasProductPending = parseInt(productPendingCount?.cnt ?? "0", 10) > 0;

    if (!hasPending && !hasProductPending) {
      console.log(
        { topic: "inventory_levels/update", variantExternalId },
        "no pending signups — skipping",
      );
      return;
    }

    const dateBucket = todayBucket();
    const batchSize: number = await config.get("notification_batch_size", 50);

    // Process variant-level signups
    if (hasPending) {
      await processRestockForItem(
        variantExternalId,
        "variant",
        productExternalId,
        dateBucket,
        batchSize,
      );
    }

    // Process product-level signups
    if (hasProductPending) {
      await processRestockForItem(
        productExternalId,
        "product",
        productExternalId,
        dateBucket,
        batchSize,
      );
    }
  },

  // ── products/delete ──────────────────────────────────────
  "products/delete": async (
    rawPayload: unknown,
    _req: Request,
  ): Promise<void> => {
    const payload = rawPayload as ProductDeletePayload;
    const productExternalId = String(payload.id);

    console.log(
      { topic: "products/delete", productExternalId },
      "soft-deleting all waitlist data for product",
    );

    await sql.begin(async (tx) => {
      // Soft-delete all signups for this product
      await tx`
        UPDATE waitlist_signups
        SET status = 'deleted', deleted_at = now()
        WHERE product_external_id = ${productExternalId}
          AND deleted_at IS NULL
      `;

      // Soft-delete all notification batches for this product
      await tx`
        UPDATE notification_batches
        SET deleted_at = now()
        WHERE product_external_id = ${productExternalId}
          AND deleted_at IS NULL
      `;

      // Soft-delete demand stats snapshots
      await tx`
        DELETE FROM demand_stats_snapshots
        WHERE product_external_id = ${productExternalId}
      `;
    });

    console.log(
      { topic: "products/delete", productExternalId },
      "cascade-delete completed",
    );
  },

  // ── orders/paid ──────────────────────────────────────────
  "orders/paid": async (
    rawPayload: unknown,
    _req: Request,
  ): Promise<void> => {
    const payload = rawPayload as OrderPaidPayload;
    const orderExternalId = String(payload.id);
    const buyerEmail = payload.email;
    const lineItems = payload.line_items;

    console.log(
      { topic: "orders/paid", orderExternalId, buyerEmail },
      "checking for conversions",
    );

    const attributionDays: number = await config.get(
      "conversion_attribution_window_days",
      7,
    );

    // Extract purchased variant external ids from line items (null variant_id lines are skipped)
    const purchasedVariantIds = lineItems
      .filter((li) => li.variant_id !== null)
      .map((li) => String(li.variant_id));

    // For each purchased variant, check if buyer was notified within attribution window.
    // If buyerEmail is absent or purchasedVariantIds is empty, the loop runs zero times — no early return.
    for (const variantId of purchasedVariantIds) {
      // Skip if no email — queries below would find no matches anyway, but be explicit
      if (!buyerEmail) {
        continue;
      }

      // Find notified signups for this email+item within attribution window
      const matchingSignups = await sql<{ id: string }[]>`
        SELECT ws.id
        FROM waitlist_signups ws
        JOIN notification_sends ns ON ns.signup_id = ws.id
        WHERE ws.email = ${buyerEmail}
          AND ws.item_external_id = ${variantId}
          AND ws.status = 'notified'
          AND ns.status = 'sent'
          AND ns.sent_at >= now() - (${attributionDays} || ' days')::INTERVAL
        LIMIT 1
      `;

      if (matchingSignups.length === 0) {
        // Also check product-level — the shopper may have signed up at product level
        // We don't know the product id from this context, so skip product-level for now
        // (variant-level is the primary conversion tracking)
        continue;
      }

      const signup = matchingSignups[0];
      if (!signup) continue;

      // Insert conversion idempotently
      await sql`
        INSERT INTO conversions
          (order_external_id, signup_id, item_external_id, converted_at)
        VALUES
          (${orderExternalId}, ${signup.id}, ${variantId}, now())
        ON CONFLICT (order_external_id, signup_id) DO NOTHING
      `;

      // Refresh demand stats snapshot for this item
      const [signupRow] = await sql<{ product_external_id: string; item_type: string }[]>`
        SELECT product_external_id, item_type
        FROM waitlist_signups
        WHERE id = ${signup.id}
      `;
      if (signupRow) {
        await refreshDemandStatsSnapshot(
          variantId,
          signupRow.item_type,
          signupRow.product_external_id,
        );
      }
    }

    console.log(
      { topic: "orders/paid", orderExternalId, purchasedVariantCount: purchasedVariantIds.length },
      "conversion check complete",
    );
  },
};

// ─── processRestockForItem ───────────────────────────────────────────────────

async function processRestockForItem(
  itemExternalId: string,
  itemType: string,
  productExternalId: string,
  dateBucket: string,
  batchSize: number,
): Promise<void> {
  // Select front-of-queue signups up to batchSize
  const signupsToNotify = await sql<WaitlistSignupRow[]>`
    SELECT id, email, item_external_id, item_type, product_external_id, unsubscribe_token, status, signed_up_at, deleted_at
    FROM waitlist_signups
    WHERE item_external_id = ${itemExternalId}
      AND item_type = ${itemType}
      AND status = 'pending'
      AND deleted_at IS NULL
    ORDER BY signed_up_at ASC
    LIMIT ${batchSize}
  `;

  if (signupsToNotify.length === 0) {
    console.log({ itemExternalId, itemType }, "no pending signups to notify");
    return;
  }

  // Create batch and notification_send rows in a transaction.
  // INSERT ... ON CONFLICT DO NOTHING provides atomic idempotency:
  // if a batch already exists for this item+date, the insert is skipped
  // and batch will be null — this is the dedup-safe pattern (no SELECT-then-INSERT race).
  let newBatchId: NotificationBatchId | null = null;

  await sql.begin(async (tx) => {
    // Attempt to create the notification batch in 'pending' state
    const [batch] = await tx<NotificationBatchRow[]>`
      INSERT INTO notification_batches
        (item_external_id, item_type, product_external_id, restock_date_bucket,
         signups_selected, emails_sent, status)
      VALUES
        (${itemExternalId}, ${itemType}, ${productExternalId}, ${dateBucket},
         ${signupsToNotify.length}, 0, 'pending')
      ON CONFLICT (item_external_id, restock_date_bucket) DO NOTHING
      RETURNING id, item_external_id, item_type, product_external_id, restock_date_bucket,
                signups_selected, emails_sent, status, created_at, deleted_at
    `;

    if (!batch) {
      // ON CONFLICT hit — batch already exists for this item+date. Idempotent no-op.
      console.log({ itemExternalId, dateBucket }, "batch already exists — idempotent no-op");
      return; // exits the sql.begin callback; newBatchId stays null
    }
    newBatchId = batch.id;

    // Mark signups as notified and create send rows
    for (const signup of signupsToNotify) {
      await tx`
        UPDATE waitlist_signups
        SET status = 'notified'
        WHERE id = ${signup.id}
      `;

      await tx`
        INSERT INTO notification_sends (batch_id, signup_id, status)
        VALUES (${batch.id}, ${signup.id}, 'pending')
        ON CONFLICT (batch_id, signup_id) DO NOTHING
      `;
    }
  });

  if (!newBatchId) return;

  console.log(
    { itemExternalId, batchId: newBatchId, signupsSelected: signupsToNotify.length },
    "notification batch created",
  );

  // Check quiet hours — if active, leave batch pending for the cron to dispatch
  const quietStart: string = await config.get("notification_quiet_start", "22:00");
  const quietEnd: string = await config.get("notification_quiet_end", "08:00");

  if (isInQuietHours(quietStart, quietEnd)) {
    console.log({ batchId: newBatchId }, "quiet hours active — deferring to cron");
  } else {
    // Dispatch immediately using workflow to drive the lifecycle
    await workflow.attempt<NotificationBatchRow, void>(
      "notification_batches",
      newBatchId,
      { from: "pending" },
      async (_row) => {
        await dispatchBatchEmails(newBatchId as NotificationBatchId, itemExternalId);
      },
    );
  }

  // Refresh demand stats snapshot regardless of email dispatch outcome
  await refreshDemandStatsSnapshot(itemExternalId, itemType, productExternalId);
}
