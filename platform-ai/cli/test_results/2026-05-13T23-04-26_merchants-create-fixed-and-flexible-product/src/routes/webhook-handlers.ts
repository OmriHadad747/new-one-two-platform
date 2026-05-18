import { sql } from "../lib/db.js";
import { money } from "../lib/money.js";
import { shopifyClientFor } from "../lib/shopify.js";
import type { Request } from "express";

export const webhookHandlers: Record<string, (payload: unknown, req: Request) => Promise<void>> = {
  "orders/paid": async (payload: unknown, _req: Request) => {
    const orderId: number = (payload as any)?.id;
    const orderCreatedAt: string = (payload as any)?.created_at;
    const lineItems: object[] = (payload as any)?.line_items;
    const totalPrice: string = (payload as any)?.total_price;
    const currency: string = (payload as any)?.currency;
    const discountCodes: object[] = (payload as any)?.discount_codes;

    // Null-defend the line items array and extract variant IDs from the payload
    const lineItemVariants = (lineItems ?? []).map((li: any) => ({ variantId: li.variant_id, quantity: li.quantity }));

    // Extract numeric variant IDs present in the order
    const orderVariantIds = lineItemVariants.map((li: any) => li.variantId).filter((id: any) => id != null).map((id: any) => Number(id));

    // Find all bundles that have at least one item whose variant_external_id is in this order's line items
    const matchedBundleRows = await sql<{ bundle_id: string }[]>`SELECT DISTINCT bi.bundle_id FROM bundle_items bi WHERE bi.variant_external_id = ANY(${orderVariantIds}::bigint[])`;

    // Skip further processing if no bundle variants appear in this order
    if (matchedBundleRows.length === 0) {
      console.log({ topic: "orders/paid", order_id: orderId }, "orders/paid: no bundle variants matched, skipping");
      return;
    }

    // Convert order total to minor units using money helper
    const orderTotalMinorUnits = money.toMinorUnits(totalPrice, currency);

    // Build the list of unique bundle IDs matched in this order
    const matchedBundleIds = matchedBundleRows.map((r: any) => r.bundle_id);

    // Load full item sets for all matched bundles to determine per-bundle selection
    const allBundleItemRows = await sql<{ bundle_id: string; variant_external_id: bigint }[]>`SELECT bi.bundle_id, bi.variant_external_id FROM bundle_items bi WHERE bi.bundle_id = ANY(${matchedBundleIds}::uuid[])`;

    // Load tiers for all matched bundles to determine earned discount per bundle
    const allBundleTierRows = await sql<{ bundle_id: string; minimum_item_count: number; discount_rate: number }[]>`SELECT bt.bundle_id, bt.minimum_item_count, bt.discount_rate FROM bundle_tiers bt WHERE bt.bundle_id = ANY(${matchedBundleIds}::uuid[]) ORDER BY bt.bundle_id, bt.minimum_item_count DESC`;

    // For each matched bundle, compute the earned tier and record the purchase history row idempotently
    const failedBundleRecords: { item: string; error: unknown }[] = [];
    for (const bundleId of matchedBundleIds) {
      try {
        // Find variant IDs belonging to this bundle that appear in the order
        const selectedVariantIds = allBundleItemRows.filter((r: any) => r.bundle_id === bundleId).map((r: any) => Number(r.variant_external_id)).filter((vid: number) => orderVariantIds.includes(vid));

        // Count the number of selected variants for this bundle
        const itemCount = selectedVariantIds.length;

        // Find tiers for this bundle ordered by minimum_item_count descending
        const bundleTiers = allBundleTierRows.filter((r: any) => r.bundle_id === bundleId).sort((a: any, b: any) => b.minimum_item_count - a.minimum_item_count);

        // Determine earned tier: highest tier whose minimum_item_count is <= selected item count
        const earnedTier = bundleTiers.find((t: any) => itemCount >= t.minimum_item_count) ?? null;

        // Resolve the discount rate — zero if no tier earned
        const appliedDiscountRate = earnedTier ? earnedTier.discount_rate : 0;

        // Insert purchase record, DO NOTHING on conflict so duplicate webhook deliveries are safe no-ops
        const selectedVariantIdsJson = JSON.stringify(selectedVariantIds);
        const insertResult = await sql<{ id: string }[]>`INSERT INTO bundle_purchase_records (bundle_id, order_external_id, order_placed_at, variant_external_ids, item_count, discount_rate, order_total_minor_units, order_currency) VALUES (${bundleId}, ${orderId}, ${orderCreatedAt}, ${selectedVariantIdsJson}::jsonb, ${itemCount}, ${appliedDiscountRate}, ${orderTotalMinorUnits}, ${currency}) ON CONFLICT (order_external_id, bundle_id) DO NOTHING RETURNING id`;

        // Log whether the row was inserted or was a duplicate delivery
        if (insertResult.length === 0) {
          console.log({ topic: "orders/paid", order_id: orderId, bundle_id: bundleId }, "orders/paid: duplicate bundle purchase record, skipped");
        } else {
          console.log({ topic: "orders/paid", order_id: orderId, bundle_id: bundleId, item_count: itemCount, discount_rate: appliedDiscountRate }, "orders/paid: bundle purchase recorded");
        }
      } catch (bundleRecordError) {
        failedBundleRecords.push({ item: bundleId, error: bundleRecordError });
      }
    }

    // Log partial failure summary if any bundle records failed
    if (failedBundleRecords.length > 0) {
      console.warn({ topic: "orders/paid", order_id: orderId, failed_count: failedBundleRecords.length }, "orders/paid: some bundle purchase records failed to save");
    }
  },

  "inventory_levels/update": async (payload: unknown, req: Request) => {
    const inventoryItemId: number = (payload as any)?.inventory_item_id;
    const available: number | null = (payload as any)?.available ?? null;

    // Null-defend available count and derive target availability state
    const targetAvailability = ((available ?? 0) > 0) ? "available" : "out_of_stock";

    // Build the Shopify GID for inventoryItem to resolve the variant
    const inventoryItemGid = `gid://shopify/InventoryItem/${inventoryItemId}`;

    // Resolve inventoryItem GID to variant external ID via Shopify Admin API
    // Use the shop domain from the webhook request header (Shopify sends x-shopify-shop-domain on every webhook delivery)
    const shopDomain = req.headers["x-shopify-shop-domain"] as string;
    const shopify = await shopifyClientFor({ shopDomain } as any);
    const inventoryItemResult = await shopify.graphql<{
      inventoryItem: { id: string; variant: { id: string } | null } | null;
    }>(
      `query GetVariantByInventoryItem($id: ID!) { inventoryItem(id: $id) { id variant { id } } }`,
      { id: inventoryItemGid },
    );

    // Extract numeric variant ID from the Shopify GID response
    const variantExternalId = inventoryItemResult?.inventoryItem?.variant?.id
      ? Number(inventoryItemResult.inventoryItem.variant.id.split("/").pop())
      : null;

    // Skip if variant could not be resolved from inventory item
    if (variantExternalId === null) {
      console.warn({ topic: "inventory_levels/update", inventory_item_id: inventoryItemId }, "inventory_levels/update: could not resolve variant, skipping");
      return;
    }

    // Fetch all bundle_items rows for this variant that do NOT already have the target availability
    const staleItemRows = await sql<{ id: string; bundle_id: string; observed_availability: string }[]>`SELECT id, bundle_id, observed_availability FROM bundle_items WHERE variant_external_id = ${variantExternalId} AND observed_availability != ${targetAvailability} AND observed_availability != 'deleted'`;

    // Exit early if all bundle_items already reflect the incoming availability state
    if (staleItemRows.length === 0) {
      console.log({ topic: "inventory_levels/update", variant_id: variantExternalId, target: targetAvailability }, "inventory_levels/update: observed_availability already current, skipping");
      return;
    }

    // Atomically advance observed_availability for all stale rows for this variant
    const updatedItemRows = await sql<{ id: string; bundle_id: string }[]>`UPDATE bundle_items SET observed_availability = ${targetAvailability} WHERE variant_external_id = ${variantExternalId} AND observed_availability != ${targetAvailability} AND observed_availability != 'deleted' RETURNING id, bundle_id`;
    if (updatedItemRows.length === 0) {
      return;
    }

    // Collect unique bundle IDs affected by this availability change
    const affectedBundleIds = [...new Set(updatedItemRows.map((r: any) => r.bundle_id))];

    // Evaluate and apply health status for each affected bundle
    const failedHealthEvals: { item: string; error: unknown }[] = [];
    for (const bundleId of affectedBundleIds) {
      try {
        // Load the bundle record
        const bundleRow = await sql<{ id: string; mode: string; enabled: boolean; health_status: string }[]>`SELECT id, mode, enabled, health_status FROM bundles WHERE id = ${bundleId}`;

        // Load all items for this bundle to evaluate health
        const bundleItemRows = await sql<{ id: string; variant_external_id: bigint; observed_availability: string }[]>`SELECT id, variant_external_id, observed_availability FROM bundle_items WHERE bundle_id = ${bundleId}`;

        // Load tiers for this bundle to evaluate minimum threshold
        const lowestTierRow = await sql<{ minimum_item_count: number }[]>`SELECT minimum_item_count FROM bundle_tiers WHERE bundle_id = ${bundleId} ORDER BY minimum_item_count ASC LIMIT 1`;

        // Count available items remaining in this bundle
        const availableCount = bundleItemRows.filter((i: any) => i.observed_availability === "available").length;

        // Get the minimum item count threshold from the lowest tier (0 if no tiers)
        const lowestMinimum = lowestTierRow.length > 0 ? lowestTierRow[0]!.minimum_item_count : 0;

        // Determine new health status
        const newHealthStatus = bundleItemRows[0] === undefined
          ? "healthy"
          : (availableCount < lowestMinimum
            ? "auto_disabled"
            : (bundleItemRows.some((i: any) => i.observed_availability !== "available") ? "warned" : "healthy"));

        // Determine new enabled flag: force false if auto_disabled
        const newEnabled = newHealthStatus === "auto_disabled" ? false : bundleRow[0]!.enabled;

        // Map newHealthStatus to health event kind
        const eventKind = newHealthStatus === "auto_disabled" ? "auto_disabled" : (newHealthStatus === "warned" ? "warned" : "cleared");

        // Build a human-readable reason for the health event
        const healthReason = newHealthStatus === "auto_disabled"
          ? `Bundle auto-disabled: only ${availableCount} available variants, lowest tier requires ${lowestMinimum}`
          : (newHealthStatus === "warned"
            ? `Bundle warned: variant ${variantExternalId} is now ${targetAvailability}`
            : `Bundle health cleared: variant ${variantExternalId} is now available`);

        // Write resolved health status and enabled flag to the bundle record
        await sql`UPDATE bundles SET health_status = ${newHealthStatus}, enabled = ${newEnabled}, updated_at = now() WHERE id = ${bundleId}`;

        // Append a health event log entry for merchant audit trail
        await sql`INSERT INTO bundle_health_events (bundle_id, event_kind, affected_variant_external_id, reason) VALUES (${bundleId}, ${eventKind}, ${variantExternalId}, ${healthReason})`;
      } catch (healthEvalError) {
        failedHealthEvals.push({ item: bundleId as string, error: healthEvalError });
      }
    }
  },

  "products/update": async (payload: unknown, _req: Request) => {
    const productId: number = (payload as any)?.id;
    const variantGidsRaw: object[] | undefined = (payload as any)?.variant_gids;

    // Guard: if variant_gids is absent, we cannot safely determine which variants survive.
    // Treat absence as "no deletion information available" and skip to avoid false deletions.
    if (variantGidsRaw === undefined || variantGidsRaw === null) {
      console.log({ topic: "products/update", product_id: productId }, "products/update: variant_gids absent, skipping deletion check");
      return;
    }

    const variantGids: object[] = variantGidsRaw;

    // Null-defend variantGids and extract numeric variant IDs still present on the product
    const survivingVariantIds = (variantGids ?? []).map((g: any) => Number(g.admin_graphql_api_id.split("/").pop()));

    // If survivingVariantIds is empty after parsing, skip — could indicate a malformed payload
    // rather than a product with all variants deleted (which is not a valid Shopify state)
    if (survivingVariantIds.length === 0) {
      console.log({ topic: "products/update", product_id: productId }, "products/update: no surviving variant IDs parsed, skipping deletion check");
      return;
    }

    // Find all bundle_items for this product that are NOT in the surviving variant list and not already deleted
    const deletedItemRows = await sql<{ id: string; bundle_id: string; variant_external_id: bigint }[]>`SELECT id, bundle_id, variant_external_id FROM bundle_items WHERE product_external_id = ${productId} AND variant_external_id != ALL(${survivingVariantIds}::bigint[]) AND observed_availability != 'deleted'`;

    // Exit early if no new deletions detected
    if (deletedItemRows.length === 0) {
      console.log({ topic: "products/update", product_id: productId }, "products/update: no newly deleted variants in bundle items");
      return;
    }

    // Extract variant IDs of deleted variants
    const deletedVariantIds = deletedItemRows.map((r: any) => Number(r.variant_external_id));

    // Mark all newly-deleted variants as deleted in bundle_items
    const claimedDeletedRows = await sql<{ id: string; bundle_id: string; variant_external_id: bigint }[]>`UPDATE bundle_items SET observed_availability = 'deleted' WHERE product_external_id = ${productId} AND variant_external_id = ANY(${deletedVariantIds}::bigint[]) AND observed_availability != 'deleted' RETURNING id, bundle_id, variant_external_id`;
    if (claimedDeletedRows.length === 0) {
      return;
    }

    // Collect unique bundle IDs affected by deleted variants
    const affectedBundleIds = [...new Set(claimedDeletedRows.map((r: any) => r.bundle_id))];

    // For each affected bundle, evaluate health and auto-disable if necessary
    const failedDeletionHealthEvals: { item: string; error: unknown }[] = [];
    for (const bundleId of affectedBundleIds) {
      try {
        // Load the bundle record
        const bundleRow = await sql<{ id: string; mode: string; enabled: boolean; health_status: string }[]>`SELECT id, mode, enabled, health_status FROM bundles WHERE id = ${bundleId}`;

        // Load all items for this bundle
        const bundleItemRows = await sql<{ variant_external_id: bigint; observed_availability: string }[]>`SELECT variant_external_id, observed_availability FROM bundle_items WHERE bundle_id = ${bundleId}`;

        // Load the lowest tier for health threshold evaluation
        const lowestTierRow = await sql<{ minimum_item_count: number }[]>`SELECT minimum_item_count FROM bundle_tiers WHERE bundle_id = ${bundleId} ORDER BY minimum_item_count ASC LIMIT 1`;

        // Determine if bundle is fixed mode — fixed bundles auto-disable on any deletion
        const isFixed = bundleRow[0]?.mode === "fixed";

        // Count available items remaining
        const availableCount = bundleItemRows.filter((i: any) => i.observed_availability === "available").length;

        // Get lowest tier minimum
        const lowestMinimum = lowestTierRow.length > 0 ? lowestTierRow[0]!.minimum_item_count : 0;

        // Determine new health status
        const newHealthStatus = isFixed ? "auto_disabled" : (availableCount < lowestMinimum ? "auto_disabled" : "warned");

        // Find the specific deleted variant(s) for this bundle from the claim result
        const bundleDeletedVariantIds = claimedDeletedRows.filter((r: any) => r.bundle_id === bundleId).map((r: any) => Number(r.variant_external_id));

        // Build health reason string
        const healthReason = `Bundle ${newHealthStatus === "auto_disabled" ? "auto-disabled" : "warned"}: variant(s) ${bundleDeletedVariantIds.join(", ")} permanently deleted from product ${productId}`;

        // Write resolved health status and force-disable if auto_disabled
        await sql`UPDATE bundles SET health_status = ${newHealthStatus}, enabled = CASE WHEN ${newHealthStatus} = 'auto_disabled' THEN false ELSE enabled END, updated_at = now() WHERE id = ${bundleId}`;

        // Insert one health event per deleted variant for detailed audit log
        for (const deletedVid of bundleDeletedVariantIds) {
          await sql`INSERT INTO bundle_health_events (bundle_id, event_kind, affected_variant_external_id, reason) VALUES (${bundleId}, ${newHealthStatus}, ${deletedVid}, ${healthReason})`;
        }
      } catch (deletionHealthError) {
        failedDeletionHealthEvals.push({ item: bundleId as string, error: deletionHealthError });
      }
    }
  },
};