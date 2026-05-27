import { sql } from "./db.js";
import type {
  BundleId,
  BundleMode,
  BundleHealthStatus,
  HealthEventKind,
  ObservedAvailability,
  VariantExternalId,
  BundleItemRow,
  BundleTierRow,
  BundleHealthEvaluation,
} from "../types/contracts.js";

interface BundleForHealth {
  id: BundleId;
  mode: BundleMode;
  health_status: BundleHealthStatus;
  enabled: boolean;
}

/**
 * Evaluate the health of a single bundle based on current item availability.
 * Returns a BundleHealthEvaluation describing what action to take.
 */
export async function evaluateBundleHealth(
  bundleId: BundleId,
): Promise<BundleHealthEvaluation | null> {
  const [bundle] = await sql<BundleForHealth[]>`
    SELECT id, mode, health_status, enabled
    FROM bundles
    WHERE id = ${bundleId}
  `;
  if (!bundle) return null;

  const allItems = await sql<BundleItemRow[]>`
    SELECT id, bundle_id, variant_external_id, product_external_id, observed_availability, added_at
    FROM bundle_items
    WHERE bundle_id = ${bundleId}
  `;

  const tiers = await sql<BundleTierRow[]>`
    SELECT minimum_item_count
    FROM bundle_tiers
    WHERE bundle_id = ${bundleId}
    ORDER BY minimum_item_count ASC
  `;

  const totalItems = allItems.length;
  const availableItems = allItems.filter(
    (i) => i.observed_availability === "available",
  );
  const unavailableItems = allItems.filter(
    (i) => i.observed_availability !== "available",
  );
  const deletedItems = allItems.filter(
    (i) => i.observed_availability === "deleted",
  );

  // If any item is deleted → auto-disable
  if (deletedItems.length > 0) {
    const affectedVariant = deletedItems[0]!.variant_external_id;
    return {
      bundle_id: bundleId,
      new_health_status: "auto_disabled",
      should_disable: true,
      event_kind: "auto_disabled",
      reason: `Variant ${affectedVariant} was permanently deleted from Shopify.`,
    };
  }

  // If no tiers exist, nothing to check about availability thresholds
  if (tiers.length === 0) {
    if (unavailableItems.length > 0) {
      const affectedVariant = unavailableItems[0]!.variant_external_id;
      return {
        bundle_id: bundleId,
        new_health_status: "warned",
        should_disable: false,
        event_kind: "warned",
        reason: `Variant ${affectedVariant} is out of stock.`,
      };
    }
    // Everything is fine
    if (bundle.health_status !== "healthy") {
      return {
        bundle_id: bundleId,
        new_health_status: "healthy",
        should_disable: false,
        event_kind: "cleared",
        reason: "All variants are now available.",
      };
    }
    return null; // No change needed
  }

  const lowestTierMinCount = tiers[0]!.minimum_item_count;
  const availableCount = availableItems.length;

  if (bundle.mode === "fixed") {
    // Fixed bundle: if ANY item is unavailable → auto-disable
    if (unavailableItems.length > 0) {
      const affectedVariant = unavailableItems[0]!.variant_external_id;
      return {
        bundle_id: bundleId,
        new_health_status: "auto_disabled",
        should_disable: true,
        event_kind: "auto_disabled",
        reason: `Fixed bundle variant ${affectedVariant} is out of stock; bundle auto-disabled.`,
      };
    }
  } else {
    // Flexible bundle: if available items < lowest tier minimum → auto-disable
    if (availableCount < lowestTierMinCount) {
      const affectedVariant =
        unavailableItems[0]?.variant_external_id ??
        (null as unknown as VariantExternalId);
      return {
        bundle_id: bundleId,
        new_health_status: "auto_disabled",
        should_disable: true,
        event_kind: "auto_disabled",
        reason: `Only ${availableCount} of ${totalItems} variants available; cannot satisfy lowest tier (minimum ${lowestTierMinCount} items). Bundle auto-disabled.`,
      };
    }

    // Flexible bundle: some items out of stock but still above lowest tier → warn
    if (unavailableItems.length > 0) {
      const affectedVariant = unavailableItems[0]!.variant_external_id;
      return {
        bundle_id: bundleId,
        new_health_status: "warned",
        should_disable: false,
        event_kind: "warned",
        reason: `${unavailableItems.length} variant(s) out of stock (e.g. variant ${affectedVariant}); bundle still operable but customer selection pool reduced.`,
      };
    }
  }

  // All items available
  if (bundle.health_status !== "healthy") {
    return {
      bundle_id: bundleId,
      new_health_status: "healthy",
      should_disable: false,
      event_kind: "cleared",
      reason: "All variants are now available.",
    };
  }

  return null; // No change needed
}

/**
 * Apply a health evaluation to the DB: update bundle status and log the event.
 */
export async function applyBundleHealthEvaluation(
  evaluation: BundleHealthEvaluation,
  affectedVariantExternalId: VariantExternalId | null,
): Promise<void> {
  await sql.begin(async (tx) => {
    const updateFields: Record<string, unknown> = {
      health_status: evaluation.new_health_status,
      updated_at: new Date(),
    };

    if (evaluation.should_disable) {
      updateFields.enabled = false;
    }

    if (evaluation.should_disable) {
      await tx`
        UPDATE bundles
        SET health_status = ${evaluation.new_health_status},
            enabled = false,
            updated_at = now()
        WHERE id = ${evaluation.bundle_id}
      `;
    } else {
      await tx`
        UPDATE bundles
        SET health_status = ${evaluation.new_health_status},
            updated_at = now()
        WHERE id = ${evaluation.bundle_id}
      `;
    }

    await tx`
      INSERT INTO bundle_health_events (bundle_id, event_kind, affected_variant_external_id, reason)
      VALUES (
        ${evaluation.bundle_id},
        ${evaluation.event_kind},
        ${affectedVariantExternalId},
        ${evaluation.reason}
      )
    `;
  });

  console.log(
    {
      bundleId: evaluation.bundle_id,
      newHealthStatus: evaluation.new_health_status,
      eventKind: evaluation.event_kind,
      reason: evaluation.reason,
    },
    "bundle health applied",
  );
}

/**
 * Compute the highest earned tier for a given selection count.
 * Tiers must be ordered by minimum_item_count descending.
 */
export function computeEarnedTier(
  selectedCount: number,
  tiers: Pick<
    BundleTierRow,
    | "id"
    | "bundle_id"
    | "minimum_item_count"
    | "discount_rate"
    | "display_order"
    | "created_at"
    | "updated_at"
  >[],
): (typeof tiers)[number] | null {
  // Sort descending so we find the highest qualifying tier first
  const sorted = [...tiers].sort(
    (a, b) => b.minimum_item_count - a.minimum_item_count,
  );
  for (const tier of sorted) {
    if (selectedCount >= tier.minimum_item_count) {
      return tier;
    }
  }
  return null;
}
