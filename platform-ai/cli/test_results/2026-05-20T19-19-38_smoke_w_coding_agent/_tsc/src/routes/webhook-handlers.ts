import { Request } from "express";
import { sql } from "../lib/db.js";
import { money } from "../lib/money.js";
import { shopifyClientFor } from "../lib/shopify.js";
import { evaluateBundleHealth, applyBundleHealthEvaluation } from "../lib/bundle-health.js";
import type {
  BundleId,
  BundleTierRow,
  OrdersPaidPayload,
  InventoryLevelsUpdatePayload,
  ProductsDeletePayload,
  VariantExternalId,
  ObservedAvailability,
} from "../types/contracts.js";

// ─── Handler type ─────────────────────────────────────────────────────────────

type WebhookHandler = (payload: unknown, req: Request) => Promise<void>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findEarnedTier(
  selectedCount: number,
  tiers: Pick<BundleTierRow, "minimum_item_count" | "discount_rate">[]
): Pick<BundleTierRow, "minimum_item_count" | "discount_rate"> | null {
  const sorted = [...tiers].sort((a, b) => b.minimum_item_count - a.minimum_item_count);
  for (const tier of sorted) {
    if (selectedCount >= tier.minimum_item_count) {
      return tier;
    }
  }
  return null;
}

// ─── Handler: orders/paid ─────────────────────────────────────────────────────

const handleOrdersPaid: WebhookHandler = async (rawPayload, _req) => {
  const payload = rawPayload as OrdersPaidPayload;
  const orderId = payload.id;
  const orderPlacedAt = new Date(payload.created_at);
  const currency = payload.currency;

  console.log({ topic: "orders/paid", orderId }, "processing paid order");

  const orderTotalMinorUnits = money.toMinorUnits(payload.total_price, currency);

  const lineItemVariantIds = payload.line_items
    .filter((li) => li.variant_id !== null)
    .map((li) => li.variant_id as VariantExternalId);

  if (lineItemVariantIds.length === 0) {
    console.log({ topic: "orders/paid", orderId }, "no variant line items, skipping");
    return;
  }

  const matchingBundleItems = await sql<{ bundle_id: BundleId; variant_external_id: VariantExternalId }[]>`
    SELECT DISTINCT bundle_id, variant_external_id
    FROM bundle_items
    WHERE variant_external_id = ANY(${lineItemVariantIds}::bigint[])
  `;

  if (matchingBundleItems.length === 0) {
    console.log({ topic: "orders/paid", orderId }, "no matching bundles, skipping");
    return;
  }

  const bundleVariantMap = new Map<BundleId, Set<VariantExternalId>>();
  for (const row of matchingBundleItems) {
    if (!bundleVariantMap.has(row.bundle_id)) {
      bundleVariantMap.set(row.bundle_id, new Set());
    }
    bundleVariantMap.get(row.bundle_id)!.add(row.variant_external_id);
  }

  for (const [bundleId, variantsInBundle] of bundleVariantMap.entries()) {
    // Idempotency: skip if record already exists
    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM bundle_purchase_records
      WHERE order_external_id = ${orderId}
        AND bundle_id = ${bundleId}
    `;
    if (existing) {
      console.log({ topic: "orders/paid", orderId, bundleId }, "purchase record already exists, skipping");
      continue;
    }

    const selectedVariantIds = lineItemVariantIds.filter((vid) => variantsInBundle.has(vid));
    const itemCount = selectedVariantIds.length;

    const tiers = await sql<Pick<BundleTierRow, "minimum_item_count" | "discount_rate">[]>`
      SELECT minimum_item_count, discount_rate
      FROM bundle_tiers
      WHERE bundle_id = ${bundleId}
      ORDER BY minimum_item_count DESC
    `;

    const earnedTier = findEarnedTier(itemCount, tiers);
    const discountRateApplied = earnedTier?.discount_rate ?? 0;

    await sql`
      INSERT INTO bundle_purchase_records (
        bundle_id, order_external_id, order_placed_at,
        variant_external_ids, item_count, discount_rate_applied,
        order_total, currency_code
      ) VALUES (
        ${bundleId},
        ${orderId},
        ${orderPlacedAt},
        ${JSON.stringify(selectedVariantIds)},
        ${itemCount},
        ${discountRateApplied},
        ${orderTotalMinorUnits},
        ${currency}
      )
      ON CONFLICT (order_external_id, bundle_id) DO NOTHING
    `;

    console.log(
      { topic: "orders/paid", orderId, bundleId, itemCount, discountRateApplied },
      "bundle purchase record saved"
    );
  }
};

// ─── Handler: inventory_levels/update ────────────────────────────────────────

const handleInventoryLevelsUpdate: WebhookHandler = async (rawPayload, _req) => {
  const payload = rawPayload as InventoryLevelsUpdatePayload;
  const inventoryItemId = payload.inventory_item_id;
  const availableQty = payload.available;

  console.log({ topic: "inventory_levels/update", inventoryItemId, available: availableQty }, "processing inventory update");

  // Resolve inventory_item_id → variant via Admin GraphQL
  const shopify = await shopifyClientFor();
  const gid = `gid://shopify/InventoryItem/${inventoryItemId}`;

  const data = await shopify.graphql<{
    inventoryItem: {
      id: string;
      variant: { id: string; legacyResourceId: string } | null;
    } | null;
  }>(
    `query GetVariantFromInventoryItem($id: ID!) {
       inventoryItem(id: $id) {
         id
         variant {
           id
           legacyResourceId
         }
       }
     }`,
    { id: gid }
  );

  if (!data.inventoryItem?.variant) {
    console.log({ topic: "inventory_levels/update", inventoryItemId }, "no variant found, skipping");
    return;
  }

  const variantExternalId = parseInt(data.inventoryItem.variant.legacyResourceId, 10) as VariantExternalId;

  const newAvailability: ObservedAvailability =
    availableQty === null || availableQty <= 0 ? "out_of_stock" : "available";

  const affectedItems = await sql<{ id: string; bundle_id: BundleId; observed_availability: ObservedAvailability }[]>`
    SELECT id, bundle_id, observed_availability
    FROM bundle_items
    WHERE variant_external_id = ${variantExternalId}
  `;

  if (affectedItems.length === 0) {
    console.log({ topic: "inventory_levels/update", variantExternalId }, "variant not in any bundle, skipping");
    return;
  }

  // Only update rows where the state differs and the item is not in terminal 'deleted' state
  const nonDeletedToUpdate = affectedItems.filter(
    (item) => item.observed_availability !== "deleted" && item.observed_availability !== newAvailability
  );

  if (nonDeletedToUpdate.length === 0) {
    console.log({ topic: "inventory_levels/update", variantExternalId, newAvailability }, "no state change needed, skipping");
    return;
  }

  await sql`
    UPDATE bundle_items
    SET observed_availability = ${newAvailability}
    WHERE variant_external_id = ${variantExternalId}
      AND observed_availability != 'deleted'
      AND observed_availability != ${newAvailability}
  `;

  console.log({ topic: "inventory_levels/update", variantExternalId, newAvailability }, "variant availability updated");

  const affectedBundleIds = [...new Set(nonDeletedToUpdate.map((item) => item.bundle_id))];

  for (const bundleId of affectedBundleIds) {
    const evaluation = await evaluateBundleHealth(bundleId);
    if (evaluation) {
      await applyBundleHealthEvaluation(evaluation, variantExternalId);
      console.log(
        { topic: "inventory_levels/update", bundleId, evaluation: evaluation.event_kind },
        "bundle health updated"
      );
    }
  }
};

// ─── Handler: products/delete ─────────────────────────────────────────────────

const handleProductsDelete: WebhookHandler = async (rawPayload, _req) => {
  const payload = rawPayload as ProductsDeletePayload;
  const productExternalId = payload.id;

  console.log({ topic: "products/delete", productExternalId }, "processing product deletion");

  const affectedItems = await sql<{
    id: string;
    bundle_id: BundleId;
    variant_external_id: VariantExternalId;
    observed_availability: ObservedAvailability;
  }[]>`
    SELECT id, bundle_id, variant_external_id, observed_availability
    FROM bundle_items
    WHERE product_external_id = ${productExternalId}
      AND observed_availability != 'deleted'
  `;

  if (affectedItems.length === 0) {
    console.log({ topic: "products/delete", productExternalId }, "no affected bundle items, skipping");
    return;
  }

  const affectedVariantIds = [...new Set(affectedItems.map((i) => i.variant_external_id))];

  await sql`
    UPDATE bundle_items
    SET observed_availability = 'deleted'
    WHERE product_external_id = ${productExternalId}
      AND observed_availability != 'deleted'
  `;

  console.log(
    { topic: "products/delete", productExternalId, affectedVariantCount: affectedVariantIds.length },
    "bundle item variants marked deleted"
  );

  const affectedBundleIds = [...new Set(affectedItems.map((i) => i.bundle_id))];

  for (const bundleId of affectedBundleIds) {
    const firstAffectedVariant = affectedItems.find((i) => i.bundle_id === bundleId)?.variant_external_id ?? null;
    const evaluation = await evaluateBundleHealth(bundleId);
    if (evaluation) {
      await applyBundleHealthEvaluation(evaluation, firstAffectedVariant);
      console.log(
        { topic: "products/delete", bundleId, evaluation: evaluation.event_kind },
        "bundle health updated after product deletion"
      );
    }
  }
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const webhookHandlers: Record<string, WebhookHandler> = {
  "orders/paid": handleOrdersPaid,
  "inventory_levels/update": handleInventoryLevelsUpdate,
  "products/delete": handleProductsDelete,
};
