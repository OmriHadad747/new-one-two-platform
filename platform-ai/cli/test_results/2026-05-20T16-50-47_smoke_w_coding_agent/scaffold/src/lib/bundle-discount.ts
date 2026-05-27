import {
  BundleTierRow,
  EarnedTierInfo,
  ObservedAvailability,
  BundleItemRow,
} from "../types/contracts.js";

/**
 * Determine the highest earned discount tier for a given selection count.
 * Tiers are evaluated in descending order of minimum_item_count so the first
 * match is the best (highest) applicable tier.
 *
 * Returns null if no tier threshold is met.
 */
export function computeEarnedTier(
  selectedCount: number,
  tiers: BundleTierRow[],
): EarnedTierInfo | null {
  // Sort descending by minimum_item_count to find the highest earned tier first
  const sorted = [...tiers].sort(
    (a, b) => b.minimum_item_count - a.minimum_item_count,
  );

  for (const tier of sorted) {
    if (selectedCount >= tier.minimum_item_count) {
      return {
        id: tier.id,
        minimum_item_count: tier.minimum_item_count,
        discount_rate: tier.discount_rate,
      };
    }
  }
  return null;
}

/**
 * Validate a customer's bundle selection:
 * 1. All selected variants must belong to the bundle's item pool.
 * 2. All selected variants must be currently available (observed_availability).
 * 3. The selection count must meet at least the lowest tier threshold.
 *
 * Returns an array of validation error strings (empty = valid).
 */
export function validateSelection(
  selectedVariantIds: number[],
  items: Pick<BundleItemRow, "variant_external_id" | "observed_availability">[],
  tiers: Pick<BundleTierRow, "minimum_item_count">[],
): string[] {
  const errors: string[] = [];

  const poolMap = new Map<number, ObservedAvailability>();
  for (const item of items) {
    poolMap.set(item.variant_external_id, item.observed_availability);
  }

  // Check membership and availability
  const unavailable: number[] = [];
  const notInPool: number[] = [];

  for (const variantId of selectedVariantIds) {
    const availability = poolMap.get(variantId);
    if (availability === undefined) {
      notInPool.push(variantId);
    } else if (availability !== "available") {
      unavailable.push(variantId);
    }
  }

  if (notInPool.length > 0) {
    errors.push(
      `Variants not in bundle pool: ${notInPool.join(", ")}`,
    );
  }
  if (unavailable.length > 0) {
    errors.push(
      `Variants out of stock or deleted: ${unavailable.join(", ")}`,
    );
  }

  // Check minimum tier threshold
  if (tiers.length === 0) {
    errors.push("Bundle has no discount tiers configured.");
  } else {
    const lowestMinimum = Math.min(...tiers.map((t) => t.minimum_item_count));
    if (selectedVariantIds.length < lowestMinimum) {
      errors.push(
        `Selection of ${selectedVariantIds.length} item(s) does not meet the minimum threshold of ${lowestMinimum}.`,
      );
    }
  }

  return errors;
}

/**
 * Convert a discount rate in basis points to a percentage string.
 * e.g. 1000 bp → "10.00"
 */
export function bpsToPercent(basisPoints: number): number {
  return basisPoints / 100;
}

/**
 * Build the Shopify discount code string for a bundle selection.
 * We embed the bundle ID and discount rate so the cart endpoint can
 * look it up server-side. Format: BUNDLE-{shortId}-{bps}
 */
export function buildDiscountCode(bundleId: string, basisPoints: number): string {
  const shortId = bundleId.replace(/-/g, "").slice(0, 8).toUpperCase();
  return `BUNDLE-${shortId}-${basisPoints}`;
}

/**
 * Parse bundle metadata from line item properties.
 * When the widget adds items to cart it should attach a __bundle_id property.
 */
export function extractBundleIdFromProperties(
  properties: Array<{ name: string; value: string }>,
): string | null {
  const prop = properties.find((p) => p.name === "__bundle_id");
  return prop ? prop.value : null;
}

/**
 * Extract bundle discount rate (bps) from line item properties.
 */
export function extractDiscountRateFromProperties(
  properties: Array<{ name: string; value: string }>,
): number | null {
  const prop = properties.find((p) => p.name === "__bundle_discount_bps");
  if (!prop) return null;
  const val = parseInt(prop.value, 10);
  return isNaN(val) ? null : val;
}
