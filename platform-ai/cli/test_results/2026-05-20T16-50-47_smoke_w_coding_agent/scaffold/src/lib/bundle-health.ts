import {
  BundleMode,
  BundleHealthStatus,
  BundleHealthResult,
  BundleHealthEventKind,
  ObservedAvailability,
  BundleItemRow,
  BundleTierRow,
} from "../types/contracts.js";

/**
 * Evaluate whether a bundle should be auto-disabled, warned, or cleared to healthy
 * based on the current availability of all its items.
 *
 * Rules:
 * - fixed bundle: if ANY item is not available → auto_disabled
 * - flexible bundle: if the count of available items can no longer satisfy
 *   even the lowest tier's minimum_item_count → auto_disabled
 * - flexible bundle: if some items are unavailable but enough remain to satisfy
 *   at least the lowest tier → warned
 * - all items available → healthy / cleared
 */
export function evaluateBundleHealth(
  mode: BundleMode,
  items: Pick<BundleItemRow, "variant_external_id" | "observed_availability">[],
  tiers: Pick<BundleTierRow, "minimum_item_count">[],
  currentHealthStatus: BundleHealthStatus,
): BundleHealthResult {
  const availableCount = items.filter(
    (i) => i.observed_availability === "available",
  ).length;
  const totalCount = items.length;

  // Find the lowest minimum item count across all tiers
  const lowestMinimum =
    tiers.length > 0
      ? Math.min(...tiers.map((t) => t.minimum_item_count))
      : 1;

  if (mode === "fixed") {
    if (availableCount < totalCount) {
      return {
        health_status: "auto_disabled",
        event_kind: "auto_disabled",
        reason: `Fixed bundle has ${totalCount - availableCount} unavailable variant(s); auto-disabled.`,
        should_disable: true,
      };
    }
    // All available — clear to healthy if currently not healthy
    if (currentHealthStatus !== "healthy") {
      return {
        health_status: "healthy",
        event_kind: "cleared",
        reason: "All variants are available again; bundle health cleared.",
        should_disable: false,
      };
    }
    return {
      health_status: "healthy",
      event_kind: null,
      reason: null,
      should_disable: false,
    };
  }

  // flexible mode
  if (tiers.length === 0) {
    // No tiers yet — treat as healthy (not yet configured)
    return {
      health_status: "healthy",
      event_kind: null,
      reason: null,
      should_disable: false,
    };
  }

  if (availableCount < lowestMinimum) {
    return {
      health_status: "auto_disabled",
      event_kind: "auto_disabled",
      reason: `Flexible bundle has only ${availableCount} available variant(s), below the minimum tier threshold of ${lowestMinimum}; auto-disabled.`,
      should_disable: true,
    };
  }

  if (availableCount < totalCount) {
    return {
      health_status: "warned",
      event_kind: "warned",
      reason: `Flexible bundle has ${totalCount - availableCount} unavailable variant(s) but still meets the minimum tier threshold of ${lowestMinimum}.`,
      should_disable: false,
    };
  }

  // All available
  if (currentHealthStatus !== "healthy") {
    return {
      health_status: "healthy",
      event_kind: "cleared",
      reason: "All variants are available again; bundle health cleared.",
      should_disable: false,
    };
  }
  return {
    health_status: "healthy",
    event_kind: null,
    reason: null,
    should_disable: false,
  };
}

/**
 * Map an ObservedAvailability value and inventory_quantity to determine
 * what the new ObservedAvailability should be.
 */
export function stockToAvailability(inventoryQuantity: number): ObservedAvailability {
  return inventoryQuantity > 0 ? "available" : "out_of_stock";
}

/**
 * Determine if a transition is valid according to the state machine invariants.
 * Deleted is terminal — no transition away from deleted is allowed.
 * No-op transitions (same state) are also disallowed.
 */
export function isValidTransition(
  from: ObservedAvailability,
  to: ObservedAvailability,
): boolean {
  if (from === to) return false;
  if (from === "deleted") return false;
  return true;
}

/**
 * Check if re-enabling a bundle should be blocked because it is still
 * in auto_disabled health state.
 * Returns an array of blocking variant IDs (empty = not blocked).
 */
export function getBlockingVariants(
  items: Pick<BundleItemRow, "variant_external_id" | "observed_availability">[],
): number[] {
  return items
    .filter(
      (i) =>
        i.observed_availability === "out_of_stock" ||
        i.observed_availability === "deleted",
    )
    .map((i) => i.variant_external_id);
}
