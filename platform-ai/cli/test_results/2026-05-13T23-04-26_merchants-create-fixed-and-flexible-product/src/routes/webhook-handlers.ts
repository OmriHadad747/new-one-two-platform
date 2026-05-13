import { Request } from "express";
import { sql } from "../lib/db.js";
import { money } from "../lib/money.js";
import { shopifyClientFor } from "../lib/shopify.js";

export const webhookHandlers = {
  "orders/paid": async (payload: unknown, req: Request): Promise<void> => {
    const orderId = (payload as any)?.id;
    const orderCreatedAt = (payload as any)?.created_at;
    const totalPrice = (payload as any)?.total_price;
    const currency = (payload as any)?.currency;
    const lineItems = (payload as any)?.line_items;
    const discountCodes = (payload as any)?.discount_codes;

    // Null-defend all payload fields
    const safePayload = {
      orderId: orderId ?? null,
      orderCreatedAt: orderCreatedAt ?? null,
      totalPrice: totalPrice ?? "0",
      currency: currency ?? "USD",
      lineItems: lineItems ?? [],
      discountCodes: discountCodes ?? [],
    };

    // Skip if payload is malformed
    if (safePayload.orderId === null) {
      console.warn(
        { requestId: req.platform!.requestId },
        "orders/paid webhook missing order id — skipping",
      );
      return;
    }

    // Convert order total to minor units
    const orderTotalMinorUnits = money.toMinorUnits(
      safePayload.totalPrice,
      safePayload.currency,
    );

    // Extract bundle discount code entries
    const bundleCodeEntries = (safePayload.discountCodes ?? [])
      .filter((dc: any) => dc.code && dc.code.startsWith("BUNDLE_"))
      .map((dc: any) => {
        const parts = dc.code.split("_");
        return { bundleId: parts[1], discountRate: parseInt(parts[2] ?? "0", 10) };
      });

    // Skip if no bundle discount codes
    if (bundleCodeEntries.length === 0) {
      console.log(
        { requestId: req.platform!.requestId, order_id: safePayload.orderId },
        "orders/paid: no bundle discount codes — skipping",
      );
      return;
    }

    // Collect parsed bundle UUIDs
    const parsedBundleIds = bundleCodeEntries
      .map((e: any) => e.bundleId)
      .filter((id: any) => id && id.length > 0);

    // Fetch only bundle ids that actually exist
    const validBundleRows = await sql<{ id: string }[]>`
      SELECT id FROM bundles WHERE id = ANY(${parsedBundleIds}::uuid[])
    `;

    // Build a Set of confirmed-existing bundle id strings
    const validBundleIdSet = new Set(validBundleRows.map((r) => String(r.id)));

    // Filter to confirmed bundle entries
    const resolvedBundleEntries = bundleCodeEntries.filter((e: any) =>
      validBundleIdSet.has(String(e.bundleId)),
    );

    // Skip if no entries resolved
    if (resolvedBundleEntries.length === 0) {
      console.warn(
        { requestId: req.platform!.requestId, order_id: safePayload.orderId },
        "orders/paid: bundle discount codes present but no valid bundle ids resolved — skipping",
      );
      return;
    }

    // Extract all line item variant ids
    const allVariantIds = (safePayload.lineItems ?? [])
      .map((li: any) => li.variant_id)
      .filter((v: any) => v != null);

    const savedPurchases: any[] = [];
    const failedPurchases: any[] = [];

    for (const bundleEntry of resolvedBundleEntries) {
      try {
        // Fetch all bundle items for this bundle
        const bundleItemRows = await sql<{ variant_external_id: string | number }[]>`
          SELECT variant_external_id FROM bundle_items WHERE bundle_id = ${bundleEntry.bundleId}
        `;

        // Intersect order line item variant ids with bundle's variant pool
        const selectedVariantIds = allVariantIds.filter((vid: any) =>
          bundleItemRows.some(
            (r) => String(r.variant_external_id) === String(vid),
          ),
        );

        // INSERT ... ON CONFLICT DO NOTHING RETURNING id
        const claimedPurchase = await sql<{ id: string }[]>`
          INSERT INTO bundle_purchase_records
            (bundle_id, order_external_id, order_placed_at, variant_external_ids, item_count, discount_rate_applied, order_total_minor_units, order_currency)
          VALUES
            (${bundleEntry.bundleId}, ${safePayload.orderId}, ${safePayload.orderCreatedAt}, ${JSON.stringify(selectedVariantIds)}, ${selectedVariantIds.length}, ${bundleEntry.discountRate}, ${orderTotalMinorUnits}, ${safePayload.currency})
          ON CONFLICT (order_external_id, bundle_id) DO NOTHING
          RETURNING id
        `;

        if (claimedPurchase.length === 0) {
          console.log(
            {
              requestId: req.platform!.requestId,
              order_id: safePayload.orderId,
              bundle_id: bundleEntry.bundleId,
            },
            "orders/paid: duplicate purchase record — skipping",
          );
        } else {
          console.log(
            {
              requestId: req.platform!.requestId,
              order_id: safePayload.orderId,
              bundle_id: bundleEntry.bundleId,
              item_count: selectedVariantIds.length,
            },
            "orders/paid: bundle purchase recorded",
          );
          savedPurchases.push(bundleEntry);
        }
      } catch (purchaseError) {
        failedPurchases.push({ item: bundleEntry, error: purchaseError });
        continue;
      }
    }

    if (failedPurchases.length > 0) {
      console.warn(
        {
          requestId: req.platform!.requestId,
          order_id: safePayload.orderId,
          failed_count: failedPurchases.length,
        },
        "orders/paid: some bundle purchase records failed",
      );
    }
  },

  "inventory_levels/update": async (payload: unknown, req: Request): Promise<void> => {
    const inventoryItemId = (payload as any)?.inventory_item_id;
    const available = (payload as any)?.available;

    // Null-defend payload
    const safePayload = {
      inventoryItemId: inventoryItemId ?? null,
      available: available !== undefined ? available : null,
    };

    // Skip if missing inventory_item_id
    if (safePayload.inventoryItemId === null) {
      console.warn(
        { requestId: req.platform!.requestId },
        "inventory_levels/update: missing inventory_item_id — skipping",
      );
      return;
    }

    // Skip if available is null
    if (safePayload.available === null) {
      console.log(
        {
          requestId: req.platform!.requestId,
          inventory_item_id: safePayload.inventoryItemId,
        },
        "inventory_levels/update: available is null — skipping to avoid incorrect availability transition",
      );
      return;
    }

    // Determine new availability
    const newAvailability = safePayload.available > 0 ? "available" : "out_of_stock";

    // Look up variant from cache
    const cachedVariant = await sql<{ variant_external_id: number }[]>`
      SELECT variant_external_id FROM inventory_item_variant_map WHERE inventory_item_id = ${safePayload.inventoryItemId}
    `;

    // If not cached, resolve from Shopify
    if (cachedVariant.length === 0) {
      const inventoryItemGid = `gid://shopify/InventoryItem/${safePayload.inventoryItemId}`;

      const shopify = await shopifyClientFor(req.platform!);

      const shopifyInventoryItem = await shopify.graphql<{
        inventoryItem: { id: string; variant: { id: string } | null } | null;
      }>(
        `query GetVariantByInventoryItem($id: ID!) {
           inventoryItem(id: $id) {
             id
             variant { id }
           }
         }`,
        { id: inventoryItemGid },
      );

      const resolvedVariantId =
        shopifyInventoryItem?.inventoryItem?.variant?.id
          ? Number(
              shopifyInventoryItem.inventoryItem.variant.id.split("/").pop(),
            )
          : null;

      if (resolvedVariantId === null) {
        console.warn(
          {
            requestId: req.platform!.requestId,
            inventory_item_id: safePayload.inventoryItemId,
          },
          "inventory_levels/update: cannot resolve variant — skipping",
        );
        return;
      } else {
        await sql`
          INSERT INTO inventory_item_variant_map (inventory_item_id, variant_external_id)
          VALUES (${safePayload.inventoryItemId}, ${resolvedVariantId})
          ON CONFLICT (inventory_item_id) DO UPDATE SET variant_external_id = EXCLUDED.variant_external_id, resolved_at = now()
        `;
      }
    }

    // Re-read cache after potential upsert
    const variantRow = await sql<{ variant_external_id: number }[]>`
      SELECT variant_external_id FROM inventory_item_variant_map WHERE inventory_item_id = ${safePayload.inventoryItemId}
    `;

    if (variantRow.length === 0) {
      return;
    }

    const variantExternalId = variantRow[0]!.variant_external_id;

    // Fetch all bundle_items for this variant
    const affectedItems = await sql<{
      id: string;
      bundle_id: string;
      observed_availability: string | null;
    }[]>`
      SELECT id, bundle_id, observed_availability FROM bundle_items WHERE variant_external_id = ${variantExternalId}
    `;

    if (affectedItems.length === 0) {
      return;
    }

    // Filter to items that need a state transition
    const itemsToTransition = affectedItems.filter(
      (item) =>
        item.observed_availability !== null &&
        item.observed_availability !== "deleted" &&
        item.observed_availability !== newAvailability,
    );

    if (itemsToTransition.length === 0) {
      console.log(
        {
          requestId: req.platform!.requestId,
          variant_id: variantExternalId,
          new_availability: newAvailability,
        },
        "inventory_levels/update: observed_availability already current — skipping",
      );
      return;
    }

    const failedTransitions: any[] = [];

    for (const item of itemsToTransition) {
      try {
        // Atomic claim — transition observed_availability
        const transitioned = await sql<{ id: string; bundle_id: string }[]>`
          UPDATE bundle_items
          SET observed_availability = ${newAvailability}
          WHERE id = ${item.id}
            AND observed_availability = ${item.observed_availability}
            AND observed_availability != 'deleted'
          RETURNING id, bundle_id
        `;

        if (transitioned.length === 0) {
          // Another worker already transitioned this item
        } else {
          // Evaluate bundle health
          const allBundleItems = await sql<{ observed_availability: string | null }[]>`
            SELECT observed_availability FROM bundle_items WHERE bundle_id = ${item.bundle_id}
          `;

          const bundleRow = await sql<{
            id: string;
            mode: string;
            health_status: string;
            enabled: boolean;
          }[]>`
            SELECT id, mode, health_status, enabled FROM bundles WHERE id = ${item.bundle_id}
          `;

          const lowestTier = await sql<{ minimum_item_count: number }[]>`
            SELECT minimum_item_count FROM bundle_tiers WHERE bundle_id = ${item.bundle_id} ORDER BY minimum_item_count ASC LIMIT 1
          `;

          const resolvedHealth = (() => {
            const b = bundleRow[0];
            if (!b) return null;
            const availCount = allBundleItems.filter(
              (i) => i.observed_availability === "available",
            ).length;
            const hasDeleted = allBundleItems.some(
              (i) => i.observed_availability === "deleted",
            );
            const hasOos = allBundleItems.some(
              (i) => i.observed_availability === "out_of_stock",
            );
            const minCount = lowestTier[0]?.minimum_item_count ?? 1;
            if (b.mode === "fixed" && (hasDeleted || hasOos)) return "auto_disabled";
            if (b.mode === "flexible" && (hasDeleted || availCount < minCount))
              return "auto_disabled";
            if (hasOos) return "warned";
            return "healthy";
          })();

          if (resolvedHealth !== null && resolvedHealth !== bundleRow[0]?.health_status) {
            const eventKind =
              resolvedHealth === "auto_disabled"
                ? "auto_disabled"
                : resolvedHealth === "warned"
                  ? "warned"
                  : "cleared";

            const healthReason = `variant ${variantExternalId} transitioned to ${newAvailability}; bundle mode=${bundleRow[0]?.mode}`;

            await sql.begin(async (tx) => {
              await tx`
                UPDATE bundles
                SET health_status = ${resolvedHealth},
                    enabled = CASE WHEN ${resolvedHealth} = 'auto_disabled' THEN false ELSE enabled END,
                    updated_at = now()
                WHERE id = ${item.bundle_id}
              `;
              await tx`
                INSERT INTO bundle_health_events (bundle_id, event_kind, affected_variant_external_id, reason)
                VALUES (${item.bundle_id}, ${eventKind}, ${variantExternalId}, ${healthReason})
              `;
            });
          }
        }
      } catch (transitionError) {
        failedTransitions.push({ item, error: transitionError });
        continue;
      }
    }

    if (failedTransitions.length > 0) {
      console.warn(
        {
          requestId: req.platform!.requestId,
          variant_id: variantExternalId,
          failed_count: failedTransitions.length,
        },
        "inventory_levels/update: some item transitions failed",
      );
    }
  },

  "products/update": async (payload: unknown, req: Request): Promise<void> => {
    const productId = (payload as any)?.id;
    const variantGids = (payload as any)?.variant_gids;

    // Null-defend and extract present variant ids
    const safePayload = {
      productId: productId ?? null,
      presentVariantIds: new Set(
        (variantGids ?? [])
          .map((g: any) =>
            g.admin_graphql_api_id
              ? Number(g.admin_graphql_api_id.split("/").pop())
              : null,
          )
          .filter((v: any) => v !== null),
      ),
    };

    if (safePayload.productId === null) {
      console.warn(
        { requestId: req.platform!.requestId },
        "products/update: missing product id — skipping",
      );
      return;
    }

    // Find all bundle_items for this product that are not deleted
    const trackedItems = await sql<{
      id: string;
      bundle_id: string;
      variant_external_id: number;
      observed_availability: string;
    }[]>`
      SELECT id, bundle_id, variant_external_id, observed_availability
      FROM bundle_items
      WHERE product_external_id = ${safePayload.productId}
        AND observed_availability != 'deleted'
    `;

    if (trackedItems.length === 0) {
      return;
    }

    // Determine which variants were removed
    const deletedItems = trackedItems.filter(
      (item) => !safePayload.presentVariantIds.has(Number(item.variant_external_id)),
    );

    if (deletedItems.length === 0) {
      return;
    }

    const failedDeletions: any[] = [];

    for (const deletedItem of deletedItems) {
      try {
        // Atomic claim to transition to deleted
        const claimedDeletion = await sql<{
          id: string;
          bundle_id: string;
          variant_external_id: number;
        }[]>`
          UPDATE bundle_items
          SET observed_availability = 'deleted'
          WHERE id = ${deletedItem.id}
            AND observed_availability = ${deletedItem.observed_availability}
            AND observed_availability != 'deleted'
          RETURNING id, bundle_id, variant_external_id
        `;

        if (claimedDeletion.length === 0) {
          // Already deleted — skip
        } else {
          const allBundleItemsAfterDelete = await sql<{
            observed_availability: string | null;
          }[]>`
            SELECT observed_availability FROM bundle_items WHERE bundle_id = ${deletedItem.bundle_id}
          `;

          const bundleForDelete = await sql<{
            id: string;
            mode: string;
            health_status: string;
          }[]>`
            SELECT id, mode, health_status FROM bundles WHERE id = ${deletedItem.bundle_id}
          `;

          const deleteHealthStatus = "auto_disabled";

          if (bundleForDelete[0]?.health_status !== "auto_disabled") {
            await sql.begin(async (tx) => {
              await tx`
                UPDATE bundles
                SET health_status = 'auto_disabled', enabled = false, updated_at = now()
                WHERE id = ${deletedItem.bundle_id}
              `;
              await tx`
                INSERT INTO bundle_health_events (bundle_id, event_kind, affected_variant_external_id, reason)
                VALUES (${deletedItem.bundle_id}, 'auto_disabled', ${deletedItem.variant_external_id}, ${`variant ${deletedItem.variant_external_id} permanently deleted from product ${safePayload.productId}`})
              `;
            });
          }
        }
      } catch (deleteError) {
        failedDeletions.push({ item: deletedItem, error: deleteError });
        continue;
      }
    }

    if (failedDeletions.length > 0) {
      console.warn(
        {
          requestId: req.platform!.requestId,
          product_id: safePayload.productId,
          failed_count: failedDeletions.length,
        },
        "products/update: some deletion transitions failed",
      );
    }
  },
};