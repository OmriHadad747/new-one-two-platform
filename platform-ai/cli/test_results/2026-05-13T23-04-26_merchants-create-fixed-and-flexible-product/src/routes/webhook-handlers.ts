import { Request } from "express";
import { sql } from "../lib/db.js";
import { money } from "../lib/money.js";
import { shopifyClientFor } from "../lib/shopify.js";

export const webhookHandlers = {
  "orders/paid": async (payload: unknown, _req: Request): Promise<void> => {
    const orderId = (payload as any)?.id;
    const orderCreatedAt = (payload as any)?.created_at;
    const totalPrice = (payload as any)?.total_price;
    const currency = (payload as any)?.currency;
    const lineItems = (payload as any)?.line_items;
    const discountCodes = (payload as any)?.discount_codes;

    // Step: Null-defend all payload fields
    const safePayload = {
      orderId: orderId ?? null,
      orderCreatedAt: orderCreatedAt ?? null,
      totalPrice: totalPrice ?? "0",
      currency: currency ?? "USD",
      lineItems: lineItems ?? [],
      discountCodes: discountCodes ?? [],
    };

    // Step: Skip if payload is malformed
    if (safePayload.orderId === null) {
      console.warn(
        {},
        "orders/paid webhook missing order id — skipping",
      );
      return;
    }

    // Step: Convert order total to minor units
    const orderTotalMinorUnits = money.toMinorUnits(
      safePayload.totalPrice,
      safePayload.currency,
    );

    // Step: Extract bundle discount code entries
    const bundleCodeEntries = (safePayload.discountCodes ?? [])
      .filter((dc: any) => dc.code && dc.code.startsWith("BUNDLE_"))
      .map((dc: any) => {
        const parts = dc.code.split("_");
        return {
          bundleId: parts[1],
          discountRate: parseInt(parts[2] ?? "0", 10),
        };
      });

    // Step: Skip if no bundle discount codes present
    if (bundleCodeEntries.length === 0) {
      console.log(
        { order_id: safePayload.orderId },
        "orders/paid: no bundle discount codes — skipping",
      );
      return;
    }

    // Step: Collect parsed bundle UUIDs
    const parsedBundleIds = bundleCodeEntries
      .map((e: any) => e.bundleId)
      .filter((id: any) => id && id.length > 0);

    // Step: Fetch only bundle ids that actually exist
    const validBundleRows = await sql<{ id: string }[]>`
      SELECT id FROM bundles WHERE id = ANY(${parsedBundleIds}::uuid[])
    `;

    // Step: Build Set of confirmed-existing bundle id strings
    const validBundleIdSet = new Set(validBundleRows.map((r) => String(r.id)));

    // Step: Filter bundleCodeEntries to only confirmed DB entries
    const resolvedBundleEntries = bundleCodeEntries.filter((e: any) =>
      validBundleIdSet.has(String(e.bundleId)),
    );

    // Step: Skip if no bundle code entries resolved
    if (resolvedBundleEntries.length === 0) {
      console.warn(
        { order_id: safePayload.orderId },
        "orders/paid: bundle discount codes present but no valid bundle ids resolved — skipping",
      );
      return;
    }

    // Step: Extract all line item variant ids
    const allVariantIds = (safePayload.lineItems ?? [])
      .map((li: any) => li.variant_id)
      .filter((v: any) => v != null);

    // Step: For each resolved bundle code entry
    const savedPurchases: any[] = [];
    const failedPurchases: any[] = [];

    for (const bundleEntry of resolvedBundleEntries) {
      try {
        // Step: Fetch all bundle items for this bundle
        const bundleItemRows = await sql<{ variant_external_id: string }[]>`
          SELECT variant_external_id FROM bundle_items WHERE bundle_id = ${bundleEntry.bundleId}
        `;

        // Step: Intersect order line item variant ids with this bundle's variant pool
        const selectedVariantIds = allVariantIds.filter((vid: any) =>
          bundleItemRows.some(
            (r) => String(r.variant_external_id) === String(vid),
          ),
        );

        // Step: INSERT ... ON CONFLICT DO NOTHING RETURNING id
        const claimedPurchase = await sql<{ id: string }[]>`
          INSERT INTO bundle_purchase_records (
            bundle_id, order_external_id, order_placed_at, variant_external_ids,
            item_count, discount_rate_applied, order_total_minor_units, order_currency
          )
          VALUES (
            ${bundleEntry.bundleId},
            ${safePayload.orderId},
            ${safePayload.orderCreatedAt},
            ${JSON.stringify(selectedVariantIds)},
            ${selectedVariantIds.length},
            ${bundleEntry.discountRate},
            ${orderTotalMinorUnits},
            ${safePayload.currency}
          )
          ON CONFLICT (order_external_id, bundle_id) DO NOTHING
          RETURNING id
        `;

        // Step: Duplicate delivery check
        if (claimedPurchase.length === 0) {
          console.log(
            {
              order_id: safePayload.orderId,
              bundle_id: bundleEntry.bundleId,
            },
            "orders/paid: duplicate purchase record — skipping",
          );
        } else {
          console.log(
            {
              order_id: safePayload.orderId,
              bundle_id: bundleEntry.bundleId,
              item_count: selectedVariantIds.length,
            },
            "orders/paid: bundle purchase recorded",
          );
          savedPurchases.push(bundleEntry);
        }
      } catch (purchaseError: any) {
        failedPurchases.push({ item: bundleEntry, error: purchaseError });
      }
    }

    // Step: Log partial failure summary
    if (failedPurchases.length > 0) {
      console.warn(
        {
          order_id: safePayload.orderId,
          failed_count: failedPurchases.length,
        },
        "orders/paid: some bundle purchase records failed",
      );
    }
  },

  "inventory_levels/update": async (
    payload: unknown,
    _req: Request,
  ): Promise<void> => {
    const inventoryItemId = (payload as any)?.inventory_item_id;
    const available = (payload as any)?.available;

    // Step: Null-defend payload fields
    const safePayload = {
      inventoryItemId: inventoryItemId ?? null,
      available: available !== undefined ? available : null,
    };

    // Step: Skip if inventory item id is missing
    if (safePayload.inventoryItemId === null) {
      console.warn(
        {},
        "inventory_levels/update: missing inventory_item_id — skipping",
      );
      return;
    }

    // Step: Skip if available count is null
    if (safePayload.available === null) {
      console.log(
        { inventory_item_id: safePayload.inventoryItemId },
        "inventory_levels/update: available is null — skipping to avoid incorrect availability transition",
      );
      return;
    }

    // Step: Determine new availability status
    const newAvailability =
      safePayload.available > 0 ? "available" : "out_of_stock";

    // Step: Look up variant_external_id from local cache
    const cachedVariant = await sql<{ variant_external_id: string }[]>`
      SELECT variant_external_id FROM inventory_item_variant_map
      WHERE inventory_item_id = ${safePayload.inventoryItemId}
    `;

    // Step: If not cached, resolve variant from Shopify admin API
    if (cachedVariant.length === 0) {
      const inventoryItemGid = `gid://shopify/InventoryItem/${safePayload.inventoryItemId}`;

      const shopify = await shopifyClientFor();

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

      // Step: Parse raw numeric variant id from GID
      const resolvedVariantId =
        shopifyInventoryItem?.inventoryItem?.variant?.id
          ? Number(
              shopifyInventoryItem.inventoryItem.variant.id
                .split("/")
                .pop(),
            )
          : null;

      // Step: Skip if Shopify could not resolve a variant
      if (resolvedVariantId === null) {
        console.warn(
          { inventory_item_id: safePayload.inventoryItemId },
          "inventory_levels/update: cannot resolve variant — skipping",
        );
        return;
      } else {
        // Step: Cache the inventory_item -> variant mapping
        await sql`
          INSERT INTO inventory_item_variant_map (inventory_item_id, variant_external_id)
          VALUES (${safePayload.inventoryItemId}, ${resolvedVariantId})
          ON CONFLICT (inventory_item_id)
          DO UPDATE SET variant_external_id = EXCLUDED.variant_external_id, resolved_at = now()
        `;
      }
    }

    // Step: Re-read cache to get definitive variant_external_id
    const variantRow = await sql<{ variant_external_id: string }[]>`
      SELECT variant_external_id FROM inventory_item_variant_map
      WHERE inventory_item_id = ${safePayload.inventoryItemId}
    `;

    // Step: Final guard — still no variant after resolution attempt
    if (variantRow.length === 0) {
      return;
    }

    // Step: Extract the variant id from the resolved cache row
    const variantExternalId = variantRow[0]!.variant_external_id;

    // Step: Fetch all bundle_items rows for this variant
    const affectedItems = await sql<
      {
        id: string;
        bundle_id: string;
        observed_availability: string;
      }[]
    >`
      SELECT id, bundle_id, observed_availability
      FROM bundle_items
      WHERE variant_external_id = ${variantExternalId}
    `;

    // Step: Skip if no bundle items reference this variant
    if (affectedItems.length === 0) {
      return;
    }

    // Step: Filter to items that actually need a state transition
    const itemsToTransition = affectedItems.filter(
      (item) =>
        item.observed_availability !== null &&
        item.observed_availability !== "deleted" &&
        item.observed_availability !== newAvailability,
    );

    // Step: Skip if all items already reflect new availability
    if (itemsToTransition.length === 0) {
      console.log(
        {
          variant_id: variantExternalId,
          new_availability: newAvailability,
        },
        "inventory_levels/update: observed_availability already current — skipping",
      );
      return;
    }

    // Step: For each affected bundle item
    const failedTransitions: any[] = [];

    for (const item of itemsToTransition) {
      try {
        // Step: Atomic UPDATE-form claim
        const transitioned = await sql<{ id: string; bundle_id: string }[]>`
          UPDATE bundle_items
          SET observed_availability = ${newAvailability}
          WHERE id = ${item.id}
            AND observed_availability = ${item.observed_availability}
            AND observed_availability != 'deleted'
          RETURNING id, bundle_id
        `;

        if (transitioned.length === 0) {
          // Another worker already transitioned this item — skip
        } else {
          // Step: Fetch all items for this bundle to evaluate health
          const allBundleItems = await sql<
            { observed_availability: string }[]
          >`
            SELECT observed_availability FROM bundle_items WHERE bundle_id = ${item.bundle_id}
          `;

          // Step: Fetch the bundle's mode and current health_status
          const bundleRow = await sql<
            {
              id: string;
              mode: string;
              health_status: string;
              enabled: boolean;
            }[]
          >`
            SELECT id, mode, health_status, enabled FROM bundles WHERE id = ${item.bundle_id}
          `;

          // Step: Fetch the bundle's lowest tier
          const lowestTier = await sql<{ minimum_item_count: number }[]>`
            SELECT minimum_item_count FROM bundle_tiers
            WHERE bundle_id = ${item.bundle_id}
            ORDER BY minimum_item_count ASC LIMIT 1
          `;

          // Step: Compute resolved health status
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
            if (b.mode === "fixed" && (hasDeleted || hasOos))
              return "auto_disabled";
            if (
              b.mode === "flexible" &&
              (hasDeleted || availCount < minCount)
            )
              return "auto_disabled";
            if (hasOos) return "warned";
            return "healthy";
          })();

          // Step: Only write health changes when resolvedHealth differs
          if (
            resolvedHealth !== null &&
            resolvedHealth !== bundleRow[0]?.health_status
          ) {
            // Step: Determine the health event kind
            const eventKind =
              resolvedHealth === "auto_disabled"
                ? "auto_disabled"
                : resolvedHealth === "warned"
                  ? "warned"
                  : "cleared";

            // Step: Compose human-readable reason
            const healthReason = `variant ${variantExternalId} transitioned to ${newAvailability}; bundle mode=${bundleRow[0]?.mode}`;

            // Step: Atomically update bundle health and insert health event
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
      } catch (transitionError: any) {
        failedTransitions.push({ item, error: transitionError });
      }
    }

    // Step: Log partial failure summary
    if (failedTransitions.length > 0) {
      console.warn(
        {
          variant_id: variantExternalId,
          failed_count: failedTransitions.length,
        },
        "inventory_levels/update: some item transitions failed",
      );
    }
  },

  "products/update": async (
    payload: unknown,
    _req: Request,
  ): Promise<void> => {
    const productId = (payload as any)?.id;
    const variantGids = (payload as any)?.variant_gids;

    // Step: Null-defend payload and extract present variant ids
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

    // Step: Skip if product id is missing
    if (safePayload.productId === null) {
      console.warn(
        {},
        "products/update: missing product id — skipping",
      );
      return;
    }

    // Step: Find all bundle_items for this product not currently deleted
    const trackedItems = await sql<
      {
        id: string;
        bundle_id: string;
        variant_external_id: string;
        observed_availability: string;
      }[]
    >`
      SELECT id, bundle_id, variant_external_id, observed_availability
      FROM bundle_items
      WHERE product_external_id = ${safePayload.productId}
        AND observed_availability != 'deleted'
    `;

    // Step: Exit if no tracked items for this product
    if (trackedItems.length === 0) {
      return;
    }

    // Step: Determine which tracked variants are no longer present
    const deletedItems = trackedItems.filter(
      (item) =>
        !safePayload.presentVariantIds.has(Number(item.variant_external_id)),
    );

    // Step: Exit if no variants were removed
    if (deletedItems.length === 0) {
      return;
    }

    // Step: For each deleted variant
    const failedDeletions: any[] = [];

    for (const deletedItem of deletedItems) {
      try {
        // Step: Atomic UPDATE-form claim to transition to deleted
        const claimedDeletion = await sql<
          {
            id: string;
            bundle_id: string;
            variant_external_id: string;
          }[]
        >`
          UPDATE bundle_items
          SET observed_availability = 'deleted'
          WHERE id = ${deletedItem.id}
            AND observed_availability = ${deletedItem.observed_availability}
            AND observed_availability != 'deleted'
          RETURNING id, bundle_id, variant_external_id
        `;

        if (claimedDeletion.length === 0) {
          // Item was already deleted — skip health check
        } else {
          // Step: Fetch the bundle's mode and health
          const bundleForDelete = await sql<
            { id: string; mode: string; health_status: string }[]
          >`
            SELECT id, mode, health_status FROM bundles WHERE id = ${deletedItem.bundle_id}
          `;

          // Step: Only write if health_status is not already auto_disabled
          if (bundleForDelete[0]?.health_status !== "auto_disabled") {
            await sql.begin(async (tx) => {
              await tx`
                UPDATE bundles
                SET health_status = 'auto_disabled', enabled = false, updated_at = now()
                WHERE id = ${deletedItem.bundle_id}
              `;
              await tx`
                INSERT INTO bundle_health_events (bundle_id, event_kind, affected_variant_external_id, reason)
                VALUES (
                  ${deletedItem.bundle_id},
                  'auto_disabled',
                  ${deletedItem.variant_external_id},
                  ${`variant ${deletedItem.variant_external_id} permanently deleted from product ${safePayload.productId}`}
                )
              `;
            });
          }
        }
      } catch (deleteError: any) {
        failedDeletions.push({ item: deletedItem, error: deleteError });
      }
    }

    // Step: Log partial failure summary
    if (failedDeletions.length > 0) {
      console.warn(
        {
          product_id: safePayload.productId,
          failed_count: failedDeletions.length,
        },
        "products/update: some deletion transitions failed",
      );
    }
  },
};