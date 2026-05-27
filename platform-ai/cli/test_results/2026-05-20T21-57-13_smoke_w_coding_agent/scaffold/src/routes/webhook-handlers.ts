import { Request } from "express";
import { sql } from "../lib/db.js";
import { evaluateBundleHealth, applyBundleHealthResult } from "../lib/bundle-health.js";
import { money } from "../lib/money.js";
import type {
  BundleId,
  BundleRow,
  BundleItemRow,
  BundleTierRow,
  OrdersPaidPayload,
  InventoryLevelUpdatePayload,
  ProductUpdatePayload,
  ProductDeletePayload,
  ObservedAvailability,
} from "../types/contracts.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebhookHandler = (payload: any, req: Request) => Promise<void>;

export const webhookHandlers: Record<string, WebhookHandler> = {
  "orders/paid": async (payload: OrdersPaidPayload, _req: Request): Promise<void> => {
    const orderId = payload.id;
    const orderExternalId = String(orderId);
    const orderPlacedAt = payload.created_at;
    const orderTotal = money.toMinorUnits(payload.total_price, payload.currency);
    const orderCurrency = payload.currency;

    console.log(
      { topic: "orders/paid", orderId: orderExternalId },
      "processing paid order"
    );

    if (!payload.line_items || payload.line_items.length === 0) {
      console.log({ topic: "orders/paid", orderId: orderExternalId }, "no line items, skipping");
      return;
    }

    // Extract variant IDs from line items, normalize to string
    const variantIdsInOrder: string[] = (payload.line_items as OrdersPaidPayload["line_items"])
      .filter((li) => li.variant_id !== null)
      .map((li) => String(li.variant_id));

    if (variantIdsInOrder.length === 0) {
      console.log({ topic: "orders/paid", orderId: orderExternalId }, "no variant ids in order, skipping");
      return;
    }

    // Find all bundles that contain at least one variant from this order
    const matchingItems = await sql<{ bundle_id: BundleId; variant_external_id: string }[]>`
      SELECT DISTINCT bundle_id, variant_external_id::text AS variant_external_id
      FROM bundle_items
      WHERE variant_external_id = ANY(
        SELECT unnest(ARRAY[${sql.array(variantIdsInOrder)}]::bigint[])
      )
    `;

    if (matchingItems.length === 0) {
      console.log({ topic: "orders/paid", orderId: orderExternalId }, "no matching bundle items, skipping");
      return;
    }

    // Group by bundle_id
    const bundleVariantsMap = new Map<BundleId, string[]>();
    for (const item of matchingItems) {
      const existing = bundleVariantsMap.get(item.bundle_id) ?? [];
      existing.push(String(item.variant_external_id));
      bundleVariantsMap.set(item.bundle_id, existing);
    }

    // Extract discount rate from note_attributes (set by our widget)
    const noteAttrs = new Map<string, string>(
      ((payload.note_attributes as OrdersPaidPayload["note_attributes"]) ?? []).map((a) => [a.name, a.value])
    );

    for (const [bundleId, matchedVariants] of bundleVariantsMap.entries()) {
      // Find earned tier by comparing matched variants count to tiers
      const tierRows = await sql<BundleTierRow[]>`
        SELECT * FROM bundle_tiers
        WHERE bundle_id = ${bundleId}
        ORDER BY minimum_item_count DESC
      `;

      let discountRateApplied = 0;
      for (const tier of tierRows) {
        if (matchedVariants.length >= tier.minimum_item_count) {
          discountRateApplied = tier.discount_rate;
          break;
        }
      }

      // Override with note_attribute if present
      const noteDiscountKey = `_bundle_${bundleId}_discount_rate`;
      const noteDiscount = noteAttrs.get(noteDiscountKey);
      if (noteDiscount) {
        const parsed = parseInt(noteDiscount, 10);
        if (!isNaN(parsed)) {
          discountRateApplied = parsed;
        }
      }

      // Idempotent insert — ON CONFLICT covers duplicate webhook delivery
      await sql`
        INSERT INTO bundle_purchase_records
          (bundle_id, order_external_id, order_placed_at, variant_external_ids,
           item_count, discount_rate_applied, order_total, order_currency)
        VALUES
          (
            ${bundleId},
            ${orderExternalId},
            ${orderPlacedAt},
            ${JSON.stringify(matchedVariants)},
            ${matchedVariants.length},
            ${discountRateApplied},
            ${orderTotal},
            ${orderCurrency}
          )
        ON CONFLICT (order_external_id, bundle_id) DO NOTHING
      `;

      console.log(
        { topic: "orders/paid", orderId: orderExternalId, bundleId, variants: matchedVariants.length },
        "recorded bundle purchase"
      );
    }
  },

  "inventory_levels/update": async (
    payload: InventoryLevelUpdatePayload,
    _req: Request
  ): Promise<void> => {
    const inventoryItemId = String(payload.inventory_item_id);
    const available: number | null = payload.available;

    console.log(
      { topic: "inventory_levels/update", inventoryItemId, available },
      "processing inventory update"
    );

    // inventory_levels/update gives inventory_item_id, not variant_id directly.
    // Bundle items are keyed by variant_external_id. Without a separate Admin API
    // call to resolve inventory_item_id → variant_id, we defer to products/update
    // which carries the full variant payload with inventory quantities.
    const newAvailability: ObservedAvailability =
      available !== null && available > 0 ? "available" : "out_of_stock";

    console.log(
      {
        topic: "inventory_levels/update",
        inventoryItemId,
        available,
        newAvailability,
        note: "inventory_item_id → variant resolution deferred to products/update",
      },
      "inventory level update received — deferred"
    );
  },

  "products/update": async (
    payload: ProductUpdatePayload,
    _req: Request
  ): Promise<void> => {
    const productId = String(payload.id);

    console.log(
      { topic: "products/update", productId },
      "processing product update"
    );

    if (!payload.variants || payload.variants.length === 0) {
      console.log({ topic: "products/update", productId }, "no variants in payload, skipping");
      return;
    }

    // Process each variant
    for (const variant of payload.variants) {
      const variantId = String(variant.id);

      const newAvailability: ObservedAvailability =
        variant.inventory_quantity > 0 ? "available" : "out_of_stock";

      const existingItems = await sql<BundleItemRow[]>`
        SELECT * FROM bundle_items
        WHERE variant_external_id = ${variantId}::bigint
      `;

      if (existingItems.length === 0) {
        continue;
      }

      for (const item of existingItems) {
        // Idempotency: skip if already in this state
        if (item.observed_availability === newAvailability) {
          console.log(
            { topic: "products/update", variantId, bundleId: item.bundle_id, availability: newAvailability },
            "availability already matches, skipping"
          );
          continue;
        }

        // Skip if already deleted (terminal state)
        if (item.observed_availability === "deleted") {
          continue;
        }

        // Update observed availability
        await sql`
          UPDATE bundle_items
          SET observed_availability = ${newAvailability}
          WHERE id = ${item.id}
        `;

        // Re-evaluate bundle health
        const allItems = await sql<BundleItemRow[]>`
          SELECT * FROM bundle_items WHERE bundle_id = ${item.bundle_id}
        `;
        const allTiers = await sql<BundleTierRow[]>`
          SELECT * FROM bundle_tiers WHERE bundle_id = ${item.bundle_id}
        `;
        const bundleRows = await sql<BundleRow[]>`
          SELECT * FROM bundles WHERE id = ${item.bundle_id}
        `;
        const currentBundle = bundleRows[0];
        if (!currentBundle) continue;

        const healthResult = evaluateBundleHealth(
          item.bundle_id,
          currentBundle.mode,
          allItems,
          allTiers,
          variantId
        );

        if (healthResult.new_health_status !== currentBundle.health_status ||
            healthResult.should_disable) {
          await applyBundleHealthResult(healthResult);
          console.log(
            {
              topic: "products/update",
              bundleId: item.bundle_id,
              variantId,
              newHealth: healthResult.new_health_status,
            },
            "bundle health updated"
          );
        }
      }
    }
  },

  "products/delete": async (
    payload: ProductDeletePayload,
    _req: Request
  ): Promise<void> => {
    const productId = String(payload.id);

    console.log(
      { topic: "products/delete", productId },
      "processing product deletion"
    );

    const affectedItems = await sql<BundleItemRow[]>`
      SELECT * FROM bundle_items
      WHERE product_external_id = ${productId}::bigint
    `;

    if (affectedItems.length === 0) {
      console.log({ topic: "products/delete", productId }, "no bundle items reference this product, skipping");
      return;
    }

    const affectedBundleIds = new Set<BundleId>();

    for (const item of affectedItems) {
      if (item.observed_availability === "deleted") {
        continue;
      }

      await sql`
        UPDATE bundle_items
        SET observed_availability = 'deleted'
        WHERE id = ${item.id}
      `;

      affectedBundleIds.add(item.bundle_id);
    }

    for (const bundleId of affectedBundleIds) {
      const allItems = await sql<BundleItemRow[]>`
        SELECT * FROM bundle_items WHERE bundle_id = ${bundleId}
      `;
      const allTiers = await sql<BundleTierRow[]>`
        SELECT * FROM bundle_tiers WHERE bundle_id = ${bundleId}
      `;
      const bundleRows = await sql<BundleRow[]>`
        SELECT * FROM bundles WHERE id = ${bundleId}
      `;
      const currentBundle = bundleRows[0];
      if (!currentBundle) continue;

      const healthResult = evaluateBundleHealth(
        bundleId,
        currentBundle.mode,
        allItems,
        allTiers,
        productId
      );

      await applyBundleHealthResult(healthResult);

      console.log(
        {
          topic: "products/delete",
          bundleId,
          productId,
          newHealth: healthResult.new_health_status,
        },
        "bundle health updated after product deletion"
      );
    }
  },
};
