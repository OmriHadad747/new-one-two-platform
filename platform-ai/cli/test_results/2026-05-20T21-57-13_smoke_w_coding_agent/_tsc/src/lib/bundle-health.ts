import { sql } from "../lib/db.js";
import type {
  BundleId,
  BundleMode,
  ObservedAvailability,
  BundleHealthStatus,
  HealthEventKind,
  BundleHealthEvalResult,
  BundleItemRow,
  BundleTierRow,
} from "../types/contracts.js";

/**
 * Evaluate the health of a bundle given its current item availability pool.
 *
 * Rules:
 * - If ANY item is "deleted" → auto_disabled
 * - For flexible bundles: if the count of available items < lowest tier's
 *   minimum_item_count → auto_disabled
 * - For fixed bundles: if ANY required item is not "available" → auto_disabled
 * - If some (but not all) items are out_of_stock and minimum can still be met
 *   → warned
 * - Otherwise → healthy
 */
export function evaluateBundleHealth(
  bundleId: BundleId,
  mode: BundleMode,
  items: Pick<BundleItemRow, "variant_external_id" | "observed_availability">[],
  tiers: Pick<BundleTierRow, "minimum_item_count">[],
  affectedVariantExternalId: string | null
): BundleHealthEvalResult {
  const deletedItems = items.filter((i) => i.observed_availability === "deleted");
  const outOfStockItems = items.filter((i) => i.observed_availability === "out_of_stock");
  const availableCount = items.filter((i) => i.observed_availability === "available").length;

  // Sort tiers ascending to find the minimum threshold
  const sortedTiers = [...tiers].sort((a, b) => a.minimum_item_count - b.minimum_item_count);
  const lowestThreshold = sortedTiers.length > 0 ? (sortedTiers[0]?.minimum_item_count ?? 1) : 1;

  if (deletedItems.length > 0) {
    const firstDeleted = deletedItems[0];
    const variantId = affectedVariantExternalId ?? (firstDeleted ? firstDeleted.variant_external_id : "unknown");
    return {
      bundle_id: bundleId,
      new_health_status: "auto_disabled",
      should_disable: true,
      event_kind: "auto_disabled",
      reason: `Variant ${variantId} was permanently deleted. Bundle auto-disabled.`,
      affected_variant_external_id: variantId,
    };
  }

  if (mode === "fixed") {
    // Fixed bundle: all items must be available
    if (outOfStockItems.length > 0) {
      const firstOos = outOfStockItems[0];
      const variantId = affectedVariantExternalId ?? (firstOos ? firstOos.variant_external_id : "unknown");
      return {
        bundle_id: bundleId,
        new_health_status: "auto_disabled",
        should_disable: true,
        event_kind: "auto_disabled",
        reason: `Variant ${variantId} is out of stock. Fixed bundle requires all variants to be available. Bundle auto-disabled.`,
        affected_variant_external_id: variantId,
      };
    }
    // All available
    return {
      bundle_id: bundleId,
      new_health_status: "healthy",
      should_disable: false,
      event_kind: "cleared",
      reason: "All variants are available.",
      affected_variant_external_id: affectedVariantExternalId,
    };
  }

  // Flexible bundle: check if available count satisfies at least the lowest tier
  if (availableCount < lowestThreshold) {
    const firstOos = outOfStockItems[0];
    const variantId = affectedVariantExternalId ?? (firstOos ? firstOos.variant_external_id : null);
    return {
      bundle_id: bundleId,
      new_health_status: "auto_disabled",
      should_disable: true,
      event_kind: "auto_disabled",
      reason: `Only ${availableCount} variant(s) available; lowest tier requires ${lowestThreshold}. Bundle auto-disabled.`,
      affected_variant_external_id: variantId,
    };
  }

  if (outOfStockItems.length > 0) {
    const firstOos = outOfStockItems[0];
    const variantId = affectedVariantExternalId ?? (firstOos ? firstOos.variant_external_id : null);
    return {
      bundle_id: bundleId,
      new_health_status: "warned",
      should_disable: false,
      event_kind: "warned",
      reason: `Variant ${variantId} is out of stock. Bundle still has enough items for the lowest tier.`,
      affected_variant_external_id: variantId,
    };
  }

  return {
    bundle_id: bundleId,
    new_health_status: "healthy",
    should_disable: false,
    event_kind: "cleared",
    reason: "All variants are available.",
    affected_variant_external_id: affectedVariantExternalId,
  };
}

/**
 * Persist the health evaluation result: update bundle record + insert health event.
 * Only writes when the health status actually changed (or always for events).
 */
export async function applyBundleHealthResult(
  result: BundleHealthEvalResult
): Promise<void> {
  // Update the bundle health status and potentially disable it
  if (result.should_disable) {
    await sql`
      UPDATE bundles
      SET health_status = ${result.new_health_status},
          enabled       = false,
          updated_at    = now()
      WHERE id = ${result.bundle_id}
    `;
  } else {
    await sql`
      UPDATE bundles
      SET health_status = ${result.new_health_status},
          updated_at    = now()
      WHERE id = ${result.bundle_id}
    `;
  }

  // Log the health event
  await sql`
    INSERT INTO bundle_health_events
      (bundle_id, event_kind, affected_variant_external_id, reason)
    VALUES
      (
        ${result.bundle_id},
        ${result.event_kind},
        ${result.affected_variant_external_id ?? null},
        ${result.reason}
      )
  `;
}

/**
 * Check if enabling a bundle would be blocked by its current health issues.
 * Returns null if enable is permitted, or a reason string if blocked.
 */
export async function checkEnableBlockers(
  bundleId: BundleId
): Promise<string | null> {
  const blockingItems = await sql<{ variant_external_id: string; observed_availability: ObservedAvailability }[]>`
    SELECT variant_external_id::text, observed_availability
    FROM bundle_items
    WHERE bundle_id = ${bundleId}
      AND observed_availability IN ('out_of_stock', 'deleted')
  `;

  if (blockingItems.length === 0) return null;

  const variantIds = blockingItems.map((i) => i.variant_external_id);
  const kinds = [...new Set(blockingItems.map((i) => i.observed_availability))];
  return `Cannot enable bundle: the following variants are ${kinds.join("/")} — ${variantIds.join(", ")}`;
}
