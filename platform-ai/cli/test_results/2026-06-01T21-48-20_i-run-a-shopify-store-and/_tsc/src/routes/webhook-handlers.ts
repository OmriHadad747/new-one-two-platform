import { Request } from "express";
import { sql } from "../lib/db.js";
import {
  VariantInStockPayload,
  VariantOutOfStockPayload,
  ProductDeletePayload,
  OrderPaidPayload,
  VariantAvailabilityRow,
  NotificationRunRow,
  WaitlistSignupRow,
  NotificationSendRow,
  VariantExternalId,
  ProductExternalId,
  OrderExternalId,
  NotificationRunId,
} from "../types/contracts.js";

// ─── variants/in_stock ────────────────────────────────────────────────────────
async function handleVariantInStock(
  payload: VariantInStockPayload,
  _req: Request
): Promise<void> {
  const variantId = String(payload.id) as VariantExternalId;
  const productId = String(payload.product_id) as ProductExternalId;
  const variantTitle = payload.title.replace(/\0/g, "");
  const inventoryQty = payload.inventory_quantity;

  console.log(
    { topic: "variants/in_stock", variantId, productId, inventoryQty },
    "received"
  );

  // Upsert variant availability — set to available, record last_available_at
  const now = new Date().toISOString();

  const [availRow] = await sql<VariantAvailabilityRow[]>`
    INSERT INTO variant_availability
      (variant_external_id, product_external_id, availability_state, last_available_at)
    VALUES
      (${variantId}, ${productId}, 'available', ${now})
    ON CONFLICT (variant_external_id) DO UPDATE
      SET availability_state = 'available',
          last_available_at = ${now}
    RETURNING *
  `;

  if (!availRow) {
    console.error({ topic: "variants/in_stock", variantId }, "upsert returned no row");
    return;
  }

  // Dedup gate: only create a run if no run exists created AFTER last_out_of_stock_at
  // (i.e. this is a genuine new restock cycle)
  const lastOosAt = availRow.last_out_of_stock_at;

  const [existingRun] = await sql<{ id: NotificationRunId }[]>`
    SELECT id
    FROM notification_runs
    WHERE variant_external_id = ${variantId}
      AND status = 'open'
      ${lastOosAt
        ? sql`AND created_at > ${lastOosAt}`
        : sql`AND created_at > now() - INTERVAL '1 year'`}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (existingRun) {
    console.log(
      { topic: "variants/in_stock", variantId, runId: existingRun.id },
      "run already exists for this restock cycle — no-op"
    );
    return;
  }

  // Fetch product title from waitlist signups (denormalized there at signup)
  const [sampleSignup] = await sql<{ product_title: string }[]>`
    SELECT product_title
    FROM waitlist_signups
    WHERE variant_external_id = ${variantId}
      AND status = 'active'
    LIMIT 1
  `;

  const productTitle = sampleSignup?.product_title?.replace(/\0/g, "") ?? "Unknown Product";
  const safeVariantTitle = variantTitle;

  // Create the notification run
  const [run] = await sql<NotificationRunRow[]>`
    INSERT INTO notification_runs
      (variant_external_id, product_external_id, product_title, variant_title,
       status, available_units, sends_enqueued, sends_dispatched, sends_failed, conversions)
    VALUES
      (${variantId}, ${productId}, ${productTitle}, ${safeVariantTitle},
       'open', ${inventoryQty}, 0, 0, 0, 0)
    RETURNING *
  `;

  if (!run) {
    console.error({ topic: "variants/in_stock", variantId }, "failed to create run");
    return;
  }

  // Select front of FIFO queue — up to available_units active signups
  const signups = await sql<WaitlistSignupRow[]>`
    SELECT *
    FROM waitlist_signups
    WHERE variant_external_id = ${variantId}
      AND status = 'active'
      AND deleted_at IS NULL
    ORDER BY signed_up_at ASC
    LIMIT ${inventoryQty}
  `;

  if (signups.length === 0) {
    console.log(
      { topic: "variants/in_stock", variantId, runId: run.id },
      "no active signups — run created but no sends enqueued"
    );
    // Mark run completed immediately
    await sql`
      UPDATE notification_runs
      SET status = 'completed'
      WHERE id = ${run.id}
    `;
    return;
  }

  // Enqueue sends in bulk via transaction
  await sql.begin(async (tx) => {
    for (const signup of signups) {
      await tx`
        INSERT INTO notification_sends
          (run_id, signup_id, shopper_email, variant_external_id, status, enqueued_at)
        VALUES
          (${run.id}, ${signup.id}, ${signup.shopper_email}, ${variantId}, 'enqueued', now())
        ON CONFLICT (run_id, signup_id) DO NOTHING
      `;
    }

    // Update run sends_enqueued count
    await tx`
      UPDATE notification_runs
      SET sends_enqueued = ${signups.length}
      WHERE id = ${run.id}
    `;

    // Update demand_snapshot — upsert
    await tx`
      INSERT INTO demand_snapshots
        (variant_external_id, product_external_id, product_title, variant_title,
         active_signup_count, total_notified, total_converted, last_restock_at, snapshot_updated_at)
      VALUES
        (${variantId}, ${productId}, ${productTitle}, ${safeVariantTitle},
         0, 0, 0, now(), now())
      ON CONFLICT (variant_external_id) DO UPDATE
        SET last_restock_at = now(),
            snapshot_updated_at = now()
    `;
  });

  console.log(
    { topic: "variants/in_stock", variantId, runId: run.id, sendsEnqueued: signups.length },
    "notification run created and sends enqueued"
  );
}

// ─── variants/out_of_stock ────────────────────────────────────────────────────
async function handleVariantOutOfStock(
  payload: VariantOutOfStockPayload,
  _req: Request
): Promise<void> {
  const variantId = String(payload.id) as VariantExternalId;
  const productId = String(payload.product_id) as ProductExternalId;

  console.log(
    { topic: "variants/out_of_stock", variantId, productId },
    "received"
  );

  const now = new Date().toISOString();

  // Upsert variant availability — set to out_of_stock, update last_out_of_stock_at
  await sql`
    INSERT INTO variant_availability
      (variant_external_id, product_external_id, availability_state, last_out_of_stock_at)
    VALUES
      (${variantId}, ${productId}, 'out_of_stock', ${now})
    ON CONFLICT (variant_external_id) DO UPDATE
      SET availability_state = 'out_of_stock',
          last_out_of_stock_at = ${now}
  `;

  console.log(
    { topic: "variants/out_of_stock", variantId },
    "availability state updated to out_of_stock"
  );
}

// ─── products/delete ──────────────────────────────────────────────────────────
async function handleProductDelete(
  payload: ProductDeletePayload,
  _req: Request
): Promise<void> {
  const productId = String(payload.id) as ProductExternalId;

  console.log({ topic: "products/delete", productId }, "received");

  const now = new Date().toISOString();

  await sql.begin(async (tx) => {
    // Soft-delete all active waitlist signups for this product
    await tx`
      UPDATE waitlist_signups
      SET status = 'purged',
          deleted_at = ${now}
      WHERE product_external_id = ${productId}
        AND deleted_at IS NULL
    `;

    // Cancel all open notification runs for this product
    await tx`
      UPDATE notification_runs
      SET status = 'cancelled'
      WHERE product_external_id = ${productId}
        AND status = 'open'
    `;

    // Cancel all enqueued/held sends for signups of this product
    await tx`
      UPDATE notification_sends ns
      SET status = 'failed',
          failure_reason = 'product deleted'
      WHERE ns.variant_external_id IN (
        SELECT variant_external_id FROM waitlist_signups
        WHERE product_external_id = ${productId}
      )
      AND ns.status IN ('enqueued', 'held_quiet_hours')
    `;
  });

  console.log({ topic: "products/delete", productId }, "waitlists and runs purged");
}

// ─── orders/paid ─────────────────────────────────────────────────────────────
async function handleOrderPaid(
  payload: OrderPaidPayload,
  _req: Request
): Promise<void> {
  const orderId = String(payload.id) as OrderExternalId;
  const buyerEmail = payload.email;
  const lineItems = payload.line_items;

  console.log({ topic: "orders/paid", orderId, buyerEmail }, "received");

  // Collect purchased variant ids (filter out null variant_ids — custom line items)
  const purchasedVariantIds = lineItems
    .filter((li) => li.variant_id != null)
    .map((li) => String(li.variant_id) as VariantExternalId);

  if (purchasedVariantIds.length === 0) {
    console.log(
      { topic: "orders/paid", orderId },
      "no variant line items — skipping attribution"
    );
    return;
  }

  // Idempotency: check if any conversion event already exists for this order
  const [existingConversion] = await sql<{ id: string }[]>`
    SELECT id
    FROM conversion_events
    WHERE order_external_id = ${orderId}
    LIMIT 1
  `;

  if (existingConversion) {
    console.log(
      { topic: "orders/paid", orderId },
      "conversion already recorded — no-op"
    );
    return;
  }

  // Find dispatched sends for this buyer's email + purchased variants within 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const matchingSends = await sql<NotificationSendRow[]>`
    SELECT *
    FROM notification_sends
    WHERE shopper_email = ${buyerEmail}
      AND variant_external_id = ANY(${purchasedVariantIds}::bigint[])
      AND status = 'dispatched'
      AND dispatched_at >= ${sevenDaysAgo}
    ORDER BY dispatched_at DESC
  `;

  if (matchingSends.length === 0) {
    console.log(
      { topic: "orders/paid", orderId, buyerEmail },
      "no attributed sends found within 7-day window"
    );
    return;
  }

  // Record conversions and update counters
  await sql.begin(async (tx) => {
    for (const send of matchingSends) {
      // Insert conversion event (idempotent on order + send)
      await tx`
        INSERT INTO conversion_events
          (order_external_id, send_id, shopper_email, variant_external_id, converted_at)
        VALUES
          (${orderId}, ${send.id}, ${buyerEmail}, ${send.variant_external_id}, now())
        ON CONFLICT (order_external_id, send_id) DO NOTHING
      `;

      // Mark the send as converted
      await tx`
        UPDATE notification_sends
        SET converted = true
        WHERE id = ${send.id}
      `;

      // Increment conversions counter on the parent run
      await tx`
        UPDATE notification_runs
        SET conversions = conversions + 1
        WHERE id = ${send.run_id}
      `;

      // Update demand snapshot conversions
      await tx`
        UPDATE demand_snapshots
        SET total_converted = total_converted + 1,
            snapshot_updated_at = now()
        WHERE variant_external_id = ${send.variant_external_id}
      `;
    }
  });

  console.log(
    { topic: "orders/paid", orderId, conversionsRecorded: matchingSends.length },
    "conversions attributed"
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────
export const webhookHandlers = {
  "variants/in_stock": async (payload: VariantInStockPayload, req: Request) =>
    handleVariantInStock(payload, req),
  "variants/out_of_stock": async (payload: VariantOutOfStockPayload, req: Request) =>
    handleVariantOutOfStock(payload, req),
  "products/delete": async (payload: ProductDeletePayload, req: Request) =>
    handleProductDelete(payload, req),
  "orders/paid": async (payload: OrderPaidPayload, req: Request) =>
    handleOrderPaid(payload, req),
};
