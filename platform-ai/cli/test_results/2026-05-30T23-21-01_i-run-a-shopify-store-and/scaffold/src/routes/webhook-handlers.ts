import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import type { Request } from "express";
import type {
  InventoryLevelUpdatePayload,
  ProductsDeletePayload,
  OrdersPaidPayload,
  InventoryItemQueryResult,
} from "../types/contracts.js";

// ─── Helper: compute scheduled_send_at respecting quiet hours ────────────────

function parseHHMM(hhmm: string): { h: number; m: number } {
  const [h, m] = hhmm.split(":").map(Number);
  return { h: h ?? 0, m: m ?? 0 };
}

function computeScheduledSendAt(
  detectedAt: Date,
  quietStart: string,
  quietEnd: string,
  timezone: string,
): Date {
  const localStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(detectedAt);

  const [lhStr, lmStr] = localStr.split(":");
  const localH = parseInt(lhStr ?? "0", 10);
  const localM = parseInt(lmStr ?? "0", 10);
  const localMinutes = localH * 60 + localM;

  const startParsed = parseHHMM(quietStart);
  const endParsed = parseHHMM(quietEnd);
  const startMinutes = startParsed.h * 60 + startParsed.m;
  const endMinutes = endParsed.h * 60 + endParsed.m;

  // Returns true if currently inside quiet hours
  const isQuiet = (mins: number): boolean => {
    if (startMinutes <= endMinutes) {
      return mins >= startMinutes && mins < endMinutes;
    } else {
      // Wrap-around (e.g. 22:00-07:00)
      return mins >= startMinutes || mins < endMinutes;
    }
  };

  if (!isQuiet(localMinutes)) {
    return detectedAt;
  }

  // Schedule for next quietEnd — advance detectedAt to the next quietEnd boundary
  const pad = (n: number): string => String(n).padStart(2, "0");

  // Build a "today at quietEnd" datetime in UTC by computing TZ offset
  const fullLocalStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(detectedAt);

  // Format: "YYYY-MM-DD, HH:MM:SS"
  const cleaned = fullLocalStr.replace(",", "").trim();
  const spaceParts = cleaned.split(/\s+/);
  const datePart = spaceParts[0] ?? "";
  const [lyStr, lmonStr, ldStr] = datePart.split("-");
  const ly = parseInt(lyStr ?? "0", 10);
  const lmon = parseInt(lmonStr ?? "0", 10);
  const ld = parseInt(ldStr ?? "0", 10);

  // "today at quietEnd in local timezone" represented as if it were UTC
  const naiveEndUTC = new Date(
    `${ly}-${pad(lmon)}-${pad(ld)}T${pad(endParsed.h)}:${pad(endParsed.m)}:00.000Z`,
  );

  // Compute the UTC offset at detectedAt: offset = localTime_as_UTC - actual_UTC
  const naiveDetectedUTC = new Date(
    `${ly}-${pad(lmon)}-${pad(ld)}T${pad(localH)}:${pad(localM)}:00.000Z`,
  );
  const offsetMs = naiveDetectedUTC.getTime() - detectedAt.getTime();

  // Real UTC time for "today at quietEnd"
  const scheduledAt = new Date(naiveEndUTC.getTime() - offsetMs);

  // If the computed time is in the past (quiet hours wrapped and end is tomorrow), add a day
  if (scheduledAt <= detectedAt) {
    scheduledAt.setUTCDate(scheduledAt.getUTCDate() + 1);
  }

  return scheduledAt;
}

// ─── Handler: inventory_levels/update ────────────────────────────────────────

async function handleInventoryLevelUpdate(
  payload: InventoryLevelUpdatePayload,
): Promise<void> {
  const inventoryItemId = payload.inventory_item_id;
  const available = payload.available;
  const locationId = payload.location_id;
  const updatedAt = payload.updated_at;

  console.log(
    { topic: "inventory_levels/update", inventoryItemId, locationId, updatedAt },
    "received",
  );

  // Validate inventoryItemId is numeric before constructing GID
  if (!/^\d+$/.test(String(inventoryItemId))) {
    console.warn({ inventoryItemId }, "inventory_item_id is not numeric — skipping");
    return;
  }

  const shopify = await shopifyClientFor();

  const itemData = await shopify.graphql<InventoryItemQueryResult>(
    `query ResolveInventoryItem($id: ID!) {
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

  if (!itemData.inventoryItem) {
    throw new Error(`inventoryItem not found for id=${inventoryItemId} — cannot resolve variant`);
  }

  // Use the canonical GIDs directly from the Shopify API response
  const variantGid = itemData.inventoryItem.variant.id;   // e.g. gid://shopify/ProductVariant/123
  const productGid = itemData.inventoryItem.variant.product.id; // e.g. gid://shopify/Product/456

  // Extract numeric IDs for DB storage (BIGINT columns require numeric values)
  const variantIdStr = variantGid.split("/").pop();
  const productIdStr = productGid.split("/").pop();

  if (!variantIdStr || !productIdStr) {
    console.warn({ variantGid, productGid }, "could not extract numeric ids from Shopify GIDs — skipping");
    return;
  }

  // Validate that extracted IDs are numeric (GID format guarantee: gid://shopify/Type/123)
  if (!/^\d+$/.test(variantIdStr) || !/^\d+$/.test(productIdStr)) {
    console.warn({ variantGid, productGid }, "GID-extracted IDs are not numeric — skipping");
    return;
  }

  // Log the canonical Shopify GIDs used for this batch
  console.log({ variantGid, productGid, variantIdStr, productIdStr }, "resolved variant and product from inventoryItem");

  // Check for active waitlist entries
  const [entryCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count
    FROM waitlist_entries
    WHERE (
      (signup_level = 'variant' AND variant_external_id = ${variantIdStr}::bigint AND product_external_id = ${productIdStr}::bigint)
      OR
      (signup_level = 'product' AND product_external_id = ${productIdStr}::bigint)
    )
    AND status = 'active'
  `;

  const activeCount = parseInt(entryCount?.count ?? "0", 10);
  if (activeCount === 0) {
    console.log({ variantId: variantIdStr, productId: productIdStr }, "no active waitlist entries — skipping");
    return;
  }

  // Use the actual restock detection timestamp from the webhook payload
  const now = new Date();
  const detectedAt = updatedAt ? new Date(updatedAt) : now;

  // Load quiet hours settings
  const [settings] = await sql<{
    quiet_hours_start: string;
    quiet_hours_end: string;
    timezone: string;
  }[]>`
    SELECT quiet_hours_start, quiet_hours_end, timezone
    FROM notification_settings
    LIMIT 1
  `;

  const quietStart = settings?.quiet_hours_start ?? "22:00";
  const quietEnd = settings?.quiet_hours_end ?? "08:00";
  const timezone = settings?.timezone ?? "America/New_York";

  const scheduledSendAt = computeScheduledSendAt(now, quietStart, quietEnd, timezone);

  // Only create a notification batch when stock is positive (zero/null means no restock to notify)
  if (available !== null && available > 0) {
    // Store the canonical variant GID from the Shopify API response alongside the numeric ID
    await sql`
      INSERT INTO notification_batches (
        product_external_id,
        variant_external_id,
        variant_gid,
        available_quantity_at_detection,
        status,
        entries_notified,
        detected_at,
        scheduled_send_at
      ) VALUES (
        ${productIdStr}::bigint,
        ${variantIdStr}::bigint,
        ${variantGid},
        ${available},
        'pending',
        0,
        ${detectedAt},
        ${scheduledSendAt}
      )
      ON CONFLICT (product_external_id, variant_external_id, detected_at) DO NOTHING
    `;
    console.log({ productId: productIdStr, variantId: variantIdStr, scheduledSendAt }, "notification batch created");
  } else {
    console.log({ inventoryItemId, available }, "zero or null stock — no notification batch created");
  }
}

// ─── Handler: products/delete ─────────────────────────────────────────────────

async function handleProductsDelete(payload: ProductsDeletePayload): Promise<void> {
  const productIdStr = String(payload.id);

  console.log({ topic: "products/delete", productId: productIdStr }, "received");

  await sql.begin(async (tx) => {
    await tx`
      UPDATE notification_batches
      SET status = 'completed', completed_at = now()
      WHERE product_external_id = ${productIdStr}::bigint
      AND status = 'pending'
    `;

    await tx`
      DELETE FROM waitlist_entries
      WHERE product_external_id = ${productIdStr}::bigint
    `;

    await tx`
      DELETE FROM dashboard_snapshots
      WHERE product_external_id = ${productIdStr}::bigint
    `;
  });

  console.log({ productId: productIdStr }, "waitlist cascade-deleted");
}

// ─── Handler: orders/paid ─────────────────────────────────────────────────────

async function handleOrdersPaid(payload: OrdersPaidPayload): Promise<void> {
  const orderIdStr = String(payload.id);
  const buyerEmail = payload.email;
  const processedAt = new Date(payload.processed_at);
  const lineItems = payload.line_items;

  console.log({ topic: "orders/paid", orderId: orderIdStr, buyerEmail }, "received");

  // Collect variant ids from line items (may be empty for non-variant products)
  // Idempotency is enforced by ON CONFLICT (order_external_id, waitlist_entry_id) DO NOTHING on insert
  const variantIdStrings = lineItems
    .map((li) => li.variant_id)
    .filter((id): id is number => id !== null && id !== undefined)
    .map((id) => String(id));

  // Attribution window: 7 days
  const attributionWindowMs = 7 * 24 * 60 * 60 * 1000;
  const windowStart = new Date(processedAt.getTime() - attributionWindowMs);

  const safeEmail = buyerEmail.replace(/\0/g, "");

  const notifiedEntries = await sql<{
    id: string;
    product_external_id: string;
    variant_external_id: string | null;
    notified_at: Date;
  }[]>`
    SELECT id,
           product_external_id::text,
           variant_external_id::text,
           notified_at
    FROM waitlist_entries
    WHERE shopper_email = ${safeEmail}
    AND status IN ('notified', 'converted')
    AND notified_at IS NOT NULL
    AND notified_at >= ${windowStart}
    AND notified_at <= ${processedAt}
  `;

  if (notifiedEntries.length === 0) {
    console.log({ orderId: orderIdStr, buyerEmail }, "no notified entries in attribution window");
  }

  const variantIdSet = new Set(variantIdStrings);

  for (const entry of notifiedEntries) {
    // Match logic:
    // - Variant-level: the purchased variant ID must match exactly
    // - Product-level: at least one purchased variant must have the same product_external_id
    //   as the entry, confirmed via waitlist_entries to avoid cross-product false matches
    let isMatch: boolean;
    if (entry.variant_external_id !== null) {
      isMatch = variantIdSet.has(entry.variant_external_id);
    } else if (variantIdStrings.length === 0) {
      // No variant IDs in order — can't verify product ownership, skip
      isMatch = false;
    } else {
      // Check if any purchased variant belongs to the entry's product
      // variantIdStrings are validated numeric strings from the order payload
      const productMatchRows = await sql<{ id: string }[]>`
        SELECT id FROM waitlist_entries
        WHERE product_external_id = ${entry.product_external_id}::bigint
        AND variant_external_id::text = ANY(${variantIdStrings})
        LIMIT 1
      `;
      isMatch = productMatchRows.length > 0;
    }

    if (!isMatch) continue;

    if (entry.variant_external_id !== null) {
      const varExtId = entry.variant_external_id;
      await sql`
        INSERT INTO conversions (
          waitlist_entry_id, order_external_id, shopper_email,
          product_external_id, variant_external_id, notified_at, converted_at
        ) VALUES (
          ${entry.id}, ${orderIdStr}::bigint, ${safeEmail},
          ${entry.product_external_id}::bigint, ${varExtId}::bigint,
          ${entry.notified_at}, ${processedAt}
        )
        ON CONFLICT (order_external_id, waitlist_entry_id) DO NOTHING
      `;
    } else {
      await sql`
        INSERT INTO conversions (
          waitlist_entry_id, order_external_id, shopper_email,
          product_external_id, variant_external_id, notified_at, converted_at
        ) VALUES (
          ${entry.id}, ${orderIdStr}::bigint, ${safeEmail},
          ${entry.product_external_id}::bigint, NULL,
          ${entry.notified_at}, ${processedAt}
        )
        ON CONFLICT (order_external_id, waitlist_entry_id) DO NOTHING
      `;
    }

    await sql`
      UPDATE waitlist_entries
      SET status = 'converted'
      WHERE id = ${entry.id}
      AND status = 'notified'
    `;
  }

  console.log({ orderId: orderIdStr, buyerEmail }, "conversion processing complete");
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const webhookHandlers: Record<string, (payload: unknown, req: Request) => Promise<void>> = {
  "inventory_levels/update": async (payload: unknown, _req: Request) => {
    await handleInventoryLevelUpdate(payload as InventoryLevelUpdatePayload);
  },
  "products/delete": async (payload: unknown, _req: Request) => {
    await handleProductsDelete(payload as ProductsDeletePayload);
  },
  "orders/paid": async (payload: unknown, _req: Request) => {
    await handleOrdersPaid(payload as OrdersPaidPayload);
  },
};
