import { Request } from "express";
import { sql } from "../lib/db.js";
import { money } from "../lib/money.js";
import { runHealthChecksForVariant } from "../lib/bundle-health.js";
import type {
  BundleId,
  BundleItemRow,
  OrdersPaidPayload,
  VariantStockPayload,
  ProductDeletePayload,
  ObservedAvailability,
} from "../types/contracts.js";

export const webhookHandlers = {
  "orders/paid": async (payload: OrdersPaidPayload, _req: Request): Promise<void> => {
    const orderId = payload.id;
    const orderPlacedAt = payload.created_at;
    const currency = payload.currency;
    const totalPriceMinor = money.toMinorUnits(payload.total_price, currency);

    // Collect all variant IDs from line items
    const variantIds: number[] = payload.line_items
      .map((li) => li.variant_id)
      .filter((v): v is number => v !== null);

    if (variantIds.length === 0) {
      console.log({ topic: "orders/paid", orderId }, "no variant ids in order, skipping");
      return;
    }

    // Find all active bundles whose item pools intersect with the order line items
    const matchingBundleItems = await sql<{ bundle_id: BundleId; variant_external_id: number }[]>`
      SELECT DISTINCT bi.bundle_id, bi.variant_external_id
      FROM bundle_items bi
      WHERE bi.variant_external_id = ANY(${variantIds}::bigint[])
    `;

    if (matchingBundleItems.length === 0) {
      console.log({ topic: "orders/paid", orderId }, "no bundles matched order variants, skipping");
      return;
    }

    // Group matched variants by bundle
    const bundleVariantMap = new Map<string, number[]>();
    for (const row of matchingBundleItems) {
      const bid = row.bundle_id as string;
      if (!bundleVariantMap.has(bid)) bundleVariantMap.set(bid, []);
      bundleVariantMap.get(bid)!.push(row.variant_external_id);
    }

    // Extract discount codes from payload
    const discountCodes = payload.discount_codes.map((d) => d.code);

    for (const [bundleIdStr, matchedVariants] of bundleVariantMap) {
      const bundleId = bundleIdStr as BundleId;

      // Check for existing purchase record (idempotency)
      const [existing] = await sql<{ id: string }[]>`
        SELECT id FROM bundle_purchase_records
        WHERE order_external_id = ${orderId}
          AND bundle_id = ${bundleId}
        LIMIT 1
      `;
      if (existing) {
        console.log({ topic: "orders/paid", orderId, bundleId }, "duplicate webhook, skipping");
        continue;
      }

      // Build line item quantities for the selected variants
      const lineItemQtyMap = new Map<number, number>();
      for (const li of payload.line_items) {
        if (li.variant_id !== null) {
          lineItemQtyMap.set(li.variant_id, (lineItemQtyMap.get(li.variant_id) ?? 0) + li.quantity);
        }
      }

      // Count items from this bundle
      const itemCount = matchedVariants.reduce((sum, vid) => sum + (lineItemQtyMap.get(vid) ?? 0), 0);

      // Fetch tiers to determine discount rate applied
      const tiers = await sql<{ minimum_item_count: number; discount_rate: number }[]>`
        SELECT minimum_item_count, discount_rate
        FROM bundle_tiers
        WHERE bundle_id = ${bundleId}
        ORDER BY minimum_item_count DESC
      `;

      // Find earned tier
      const earnedTier = tiers.find((t) => itemCount >= t.minimum_item_count);
      const discountRateApplied = earnedTier?.discount_rate ?? 0;

      // Insert purchase record (with ON CONFLICT for race safety)
      await sql`
        INSERT INTO bundle_purchase_records
          (bundle_id, order_external_id, order_placed_at, variant_external_ids, item_count, discount_rate_applied, order_total, order_currency)
        VALUES (
          ${bundleId},
          ${orderId},
          ${orderPlacedAt}::timestamptz,
          ${JSON.stringify(matchedVariants)},
          ${itemCount},
          ${discountRateApplied},
          ${totalPriceMinor},
          ${currency}
        )
        ON CONFLICT (order_external_id, bundle_id) DO NOTHING
      `;

      console.log({ topic: "orders/paid", orderId, bundleId, itemCount, discountRateApplied }, "recorded bundle purchase");
    }
  },

  "variants/out_of_stock": async (payload: VariantStockPayload, _req: Request): Promise<void> => {
    const variantId = payload.id;
    const newAvailability: ObservedAvailability = "out_of_stock";

    // Check idempotency: if already out_of_stock, skip
    const currentItems = await sql<BundleItemRow[]>`
      SELECT * FROM bundle_items WHERE variant_external_id = ${variantId}
    `;

    if (currentItems.length === 0) {
      console.log({ topic: "variants/out_of_stock", variantId }, "variant not in any bundle, skipping");
      return;
    }

    // Filter to items that need updating (not already out_of_stock or deleted)
    const needsUpdate = currentItems.filter(
      (item) => item.observed_availability !== newAvailability && item.observed_availability !== "deleted"
    );

    if (needsUpdate.length === 0) {
      console.log({ topic: "variants/out_of_stock", variantId }, "availability already matches, skipping");
      return;
    }

    // Update observed availability
    await sql`
      UPDATE bundle_items
      SET observed_availability = 'out_of_stock'
      WHERE variant_external_id = ${variantId}
        AND observed_availability NOT IN ('out_of_stock', 'deleted')
    `;

    console.log({ topic: "variants/out_of_stock", variantId, affectedBundles: needsUpdate.length }, "updated availability");

    // Run health checks for all affected bundles
    await runHealthChecksForVariant(variantId);
  },

  "variants/in_stock": async (payload: VariantStockPayload, _req: Request): Promise<void> => {
    const variantId = payload.id;
    const newAvailability: ObservedAvailability = "available";

    // Check idempotency: if already available, skip
    const currentItems = await sql<BundleItemRow[]>`
      SELECT * FROM bundle_items WHERE variant_external_id = ${variantId}
    `;

    if (currentItems.length === 0) {
      console.log({ topic: "variants/in_stock", variantId }, "variant not in any bundle, skipping");
      return;
    }

    // Only update items that are currently out_of_stock (not deleted — deleted is terminal)
    const needsUpdate = currentItems.filter(
      (item) => item.observed_availability === "out_of_stock"
    );

    if (needsUpdate.length === 0) {
      console.log({ topic: "variants/in_stock", variantId }, "availability already matches or terminal, skipping");
      return;
    }

    await sql`
      UPDATE bundle_items
      SET observed_availability = 'available'
      WHERE variant_external_id = ${variantId}
        AND observed_availability = 'out_of_stock'
    `;

    console.log({ topic: "variants/in_stock", variantId, affectedBundles: needsUpdate.length }, "restored availability");

    // Run health checks — some bundles may clear their warnings
    await runHealthChecksForVariant(variantId);
  },

  "products/delete": async (payload: ProductDeletePayload, _req: Request): Promise<void> => {
    const productId = payload.id;

    // Find all bundle items for variants of this product
    const currentItems = await sql<BundleItemRow[]>`
      SELECT * FROM bundle_items WHERE product_external_id = ${productId}
    `;

    if (currentItems.length === 0) {
      console.log({ topic: "products/delete", productId }, "product not in any bundle, skipping");
      return;
    }

    // Filter items not already deleted
    const needsUpdate = currentItems.filter((item) => item.observed_availability !== "deleted");

    if (needsUpdate.length === 0) {
      console.log({ topic: "products/delete", productId }, "all items already marked deleted, skipping");
      return;
    }

    // Mark all variants of this product as deleted
    await sql`
      UPDATE bundle_items
      SET observed_availability = 'deleted'
      WHERE product_external_id = ${productId}
        AND observed_availability != 'deleted'
    `;

    // Collect unique variant IDs that were just updated
    const affectedVariantIds = [...new Set(needsUpdate.map((i) => i.variant_external_id))];

    console.log({ topic: "products/delete", productId, affectedVariantCount: affectedVariantIds.length }, "marked variants as deleted");

    // Run health checks for all unique affected variant IDs
    for (const variantId of affectedVariantIds) {
      await runHealthChecksForVariant(variantId);
    }
  },
};
