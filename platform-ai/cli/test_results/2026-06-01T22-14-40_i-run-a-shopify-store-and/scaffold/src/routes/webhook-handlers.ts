import { Request } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import type {
  InventoryLevelUpdatePayload,
  ProductDeletePayload,
  OrderPaidPayload,
  InventoryItemQueryResponse,
  NotificationBatchRow,
  WaitlistEntryRow,
  NotificationSendRow,
} from "../types/contracts.js";

// ─── inventory_levels/update ─────────────────────────────────────────────────

async function handleInventoryLevelUpdate(
  payload: InventoryLevelUpdatePayload,
  _req: Request,
): Promise<void> {
  const inventoryItemId = payload.inventory_item_id;
  const available = payload.available;

  console.log(
    { topic: "inventory_levels/update", inventory_item_id: inventoryItemId, available },
    "received inventory update",
  );

  // If available is null or not positive, no restock to process
  if (available === null || available <= 0) {
    console.log(
      { topic: "inventory_levels/update", inventory_item_id: inventoryItemId },
      "available not positive, skipping",
    );
    return;
  }

  // Resolve inventory item → variant + product via Admin GraphQL
  const shopify = await shopifyClientFor();

  const itemData = await shopify.graphql<InventoryItemQueryResponse>(
    `query GetInventoryItem($id: ID!) {
       inventoryItem(id: $id) {
         id
         variant {
           id
           product {
             id
           }
         }
       }
     }`,
    { id: `gid://shopify/InventoryItem/${inventoryItemId}` },
  );

  if (!itemData.inventoryItem || !itemData.inventoryItem.variant) {
    console.warn(
      { topic: "inventory_levels/update", inventory_item_id: inventoryItemId },
      "could not resolve inventory item to variant, skipping",
    );
    return;
  }

  // Extract numeric IDs from GIDs
  const variantGid = itemData.inventoryItem.variant.id;
  const productGid = itemData.inventoryItem.variant.product.id;

  // gid://shopify/ProductVariant/12345 → 12345
  const variantExternalId = variantGid.split("/").pop()!;
  const productExternalId = productGid.split("/").pop()!;

  console.log(
    {
      topic: "inventory_levels/update",
      inventory_item_id: inventoryItemId,
      variant_external_id: variantExternalId,
      product_external_id: productExternalId,
    },
    "resolved variant and product",
  );

  // Check for existing open or recent batch for this variant to detect idempotency.
  // A restock transition is: no open batch was created in the last 5 minutes for the same item.
  // We guard by checking if a batch already exists with status 'open' for this variant.
  const existingBatches = await sql<Pick<NotificationBatchRow, "id" | "status">[]>`
    SELECT id, status
    FROM notification_batches
    WHERE product_external_id = ${productExternalId}
      AND variant_external_id = ${variantExternalId}
      AND status = 'open'
      AND created_at > now() - INTERVAL '10 minutes'
    LIMIT 1
  `;

  if (existingBatches.length > 0) {
    console.log(
      { topic: "inventory_levels/update", variant_external_id: variantExternalId },
      "open batch already exists for this restock transition, skipping",
    );
    return;
  }

  // Read per_restock_notify_cap from app_settings (singleton)
  const settingsRows = await sql<{ per_restock_notify_cap: number }[]>`
    SELECT per_restock_notify_cap FROM app_settings LIMIT 1
  `;
  const notifyCap = settingsRows[0]?.per_restock_notify_cap ?? 100;

  // Find active waitlist entries for this variant, ordered by signed_up_at (FIFO)
  const activeEntries = await sql<Pick<WaitlistEntryRow, "id" | "shopper_email" | "unsubscribe_token">[]>`
    SELECT id, shopper_email, unsubscribe_token
    FROM waitlist_entries
    WHERE product_external_id = ${productExternalId}
      AND variant_external_id = ${variantExternalId}
      AND status = 'active'
      AND deleted_at IS NULL
    ORDER BY signed_up_at ASC
    LIMIT ${notifyCap}
  `;

  if (activeEntries.length === 0) {
    console.log(
      { topic: "inventory_levels/update", variant_external_id: variantExternalId },
      "no active waitlist entries, skipping batch creation",
    );
    return;
  }

  // Create the notification batch and queue sends in a transaction
  await sql.begin(async (tx) => {
    // Insert notification batch
    const batchRows = await tx<{ id: string }[]>`
      INSERT INTO notification_batches (
        product_external_id,
        variant_external_id,
        available_quantity_at_restock,
        notify_cap,
        total_queued,
        total_sent,
        status
      ) VALUES (
        ${productExternalId},
        ${variantExternalId},
        ${available},
        ${notifyCap},
        ${activeEntries.length},
        0,
        'open'
      )
      RETURNING id
    `;

    const batchRow = batchRows[0];
    if (!batchRow) throw new Error("Failed to create notification batch");

    const batchId = batchRow.id;

    // Insert one send per active entry, queue_position = 1-based index
    for (let i = 0; i < activeEntries.length; i++) {
      const entry = activeEntries[i];
      if (!entry) continue;
      await tx`
        INSERT INTO notification_sends (
          batch_id,
          waitlist_entry_id,
          shopper_email,
          queue_position,
          status
        ) VALUES (
          ${batchId},
          ${entry.id},
          ${entry.shopper_email},
          ${i + 1},
          'queued'
        )
        ON CONFLICT (batch_id, waitlist_entry_id) DO NOTHING
      `;
    }

    console.log(
      {
        topic: "inventory_levels/update",
        batch_id: batchId,
        variant_external_id: variantExternalId,
        queued_count: activeEntries.length,
      },
      "notification batch created",
    );
  });
}

// ─── products/delete ─────────────────────────────────────────────────────────

async function handleProductDelete(
  payload: ProductDeletePayload,
  _req: Request,
): Promise<void> {
  const productExternalId = String(payload.id);

  console.log(
    { topic: "products/delete", product_external_id: productExternalId },
    "received product delete",
  );

  // Tombstone all waitlist entries for the deleted product
  const deletedEntries = await sql`
    UPDATE waitlist_entries
    SET
      status = 'removed',
      deleted_at = now()
    WHERE product_external_id = ${productExternalId}
      AND deleted_at IS NULL
  `;

  // Cancel all open notification batches for the deleted product
  await sql`
    UPDATE notification_batches
    SET status = 'cancelled'
    WHERE product_external_id = ${productExternalId}
      AND status = 'open'
  `;

  console.log(
    { topic: "products/delete", product_external_id: productExternalId },
    "purged waitlist and cancelled open batches",
  );

  // Suppress unused variable warning
  void deletedEntries;
}

// ─── orders/paid ─────────────────────────────────────────────────────────────

async function handleOrderPaid(
  payload: OrderPaidPayload,
  _req: Request,
): Promise<void> {
  const orderExternalId = String(payload.id);
  const buyerEmail = payload.email;
  const processedAt = payload.processed_at;

  console.log(
    { topic: "orders/paid", order_external_id: orderExternalId, buyer_email: buyerEmail },
    "received order paid",
  );

  if (!buyerEmail) {
    console.warn({ topic: "orders/paid", order_external_id: orderExternalId }, "no buyer email, skipping conversion");
    return;
  }

  // Collect purchased variant external ids from line items
  const purchasedVariantIds = payload.line_items
    .filter((li) => li.variant_id !== null && li.variant_id !== undefined)
    .map((li) => String(li.variant_id!));

  if (purchasedVariantIds.length === 0) {
    console.log({ topic: "orders/paid", order_external_id: orderExternalId }, "no variant ids, skipping");
    return;
  }

  // Find dispatched sends within 7-day attribution window for this buyer + purchased variants
  const attributionWindow = new Date(processedAt);
  attributionWindow.setDate(attributionWindow.getDate() - 7);

  const matchingSends = await sql<Pick<NotificationSendRow, "id">[]>`
    SELECT ns.id
    FROM notification_sends ns
    JOIN waitlist_entries we ON we.id = ns.waitlist_entry_id
    JOIN notification_batches nb ON nb.id = ns.batch_id
    WHERE ns.shopper_email = ${buyerEmail}
      AND ns.status = 'dispatched'
      AND ns.dispatched_at >= ${attributionWindow}
      AND nb.variant_external_id = ANY(${purchasedVariantIds})
  `;

  if (matchingSends.length === 0) {
    console.log(
      { topic: "orders/paid", order_external_id: orderExternalId },
      "no matching notification sends within attribution window",
    );
    return;
  }

  const convertedAt = new Date(processedAt);

  for (const send of matchingSends) {
    await sql`
      INSERT INTO conversions (
        notification_send_id,
        order_external_id,
        converted_at
      ) VALUES (
        ${send.id},
        ${orderExternalId},
        ${convertedAt}
      )
      ON CONFLICT (notification_send_id, order_external_id) DO NOTHING
    `;
  }

  // Update waitlist snapshot conversion counts for affected products
  await sql`
    UPDATE waitlist_snapshots ws
    SET
      total_conversion_count = (
        SELECT COUNT(DISTINCT c.id)
        FROM conversions c
        JOIN notification_sends ns2 ON ns2.id = c.notification_send_id
        JOIN notification_batches nb2 ON nb2.id = ns2.batch_id
        WHERE nb2.product_external_id = ws.product_external_id
      ),
      last_updated_at = now()
    WHERE ws.product_external_id IN (
      SELECT DISTINCT nb3.product_external_id
      FROM notification_sends ns3
      JOIN notification_batches nb3 ON nb3.id = ns3.batch_id
      WHERE ns3.id = ANY(${matchingSends.map((s) => s.id)})
    )
  `;

  console.log(
    {
      topic: "orders/paid",
      order_external_id: orderExternalId,
      conversion_count: matchingSends.length,
    },
    "conversions recorded",
  );
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const webhookHandlers = {
  "inventory_levels/update": async (payload: InventoryLevelUpdatePayload, req: Request) =>
    handleInventoryLevelUpdate(payload, req),
  "products/delete": async (payload: ProductDeletePayload, req: Request) =>
    handleProductDelete(payload, req),
  "orders/paid": async (payload: OrderPaidPayload, req: Request) =>
    handleOrderPaid(payload, req),
};
