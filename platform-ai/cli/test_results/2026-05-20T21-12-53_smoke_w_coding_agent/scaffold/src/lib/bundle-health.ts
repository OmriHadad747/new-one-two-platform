/**
 * Shared bundle health evaluation logic.
 * Used by both webhook handlers and cron jobs.
 */
import { sql } from "./db.js";
import {
  BundleId,
  BundleMode,
  BundleHealthStatus,
  BundleHealthEvalResult,
  HealthEventKind,
  BundleItemRow,
  BundleTierRow,
  ObservedAvailability,
} from "../types/contracts.js";

/**
 * Evaluate the health of a single bundle given its current item availability.
 *
 * Rules:
 *  - If any item is "deleted" → auto_disable
 *  - For "fixed" bundles: if any item is out_of_stock → auto_disable
 *  - For "flexible" bundles: if the count of available items < lowest tier
 *    minimum_item_count → auto_disable
 *  - For "flexible" bundles: if available < (some items unavailable) but
 *    enough for lowest tier → warned
 *  - Otherwise → healthy
 */
export function evaluateBundleHealth(
  bundleId: BundleId,
  mode: BundleMode,
  items: Pick<BundleItemRow, "observed_availability">[],
  tiers: Pick<BundleTierRow, "minimum_item_count">[],
): BundleHealthEvalResult {
  const availableCount = items.filter(
    (i) => i.observed_availability === "available",
  ).length;
  const deletedCount = items.filter(
    (i) => i.observed_availability === "deleted",
  ).length;
  const outOfStockCount = items.filter(
    (i) => i.observed_availability === "out_of_stock",
  ).length;
  const totalCount = items.length;

  // Sort tiers by minimum_item_count ascending to find lowest threshold
  const sortedTiers = [...tiers].sort(
    (a, b) => a.minimum_item_count - b.minimum_item_count,
  );
  const lowestMinimum = sortedTiers.length > 0 ? sortedTiers[0].minimum_item_count : 1;

  if (deletedCount > 0) {
    return {
      bundle_id: bundleId,
      new_health_status: "auto_disabled",
      should_disable: true,
      event_kind: "auto_disabled",
      reason: `${deletedCount} variant(s) permanently deleted from Shopify. Bundle auto-disabled.`,
    };
  }

  if (mode === "fixed") {
    if (outOfStockCount > 0) {
      return {
        bundle_id: bundleId,
        new_health_status: "auto_disabled",
        should_disable: true,
        event_kind: "auto_disabled",
        reason: `Fixed bundle has ${outOfStockCount} out-of-stock variant(s) out of ${totalCount}. Bundle auto-disabled.`,
      };
    }
    // All available
    return {
      bundle_id: bundleId,
      new_health_status: "healthy",
      should_disable: false,
      event_kind: "cleared",
      reason: "All variants available.",
    };
  }

  // Flexible bundle
  if (availableCount < lowestMinimum) {
    return {
      bundle_id: bundleId,
      new_health_status: "auto_disabled",
      should_disable: true,
      event_kind: "auto_disabled",
      reason: `Flexible bundle only has ${availableCount} available variant(s); lowest tier requires ${lowestMinimum}. Bundle auto-disabled.`,
    };
  }

  if (outOfStockCount > 0) {
    return {
      bundle_id: bundleId,
      new_health_status: "warned",
      should_disable: false,
      event_kind: "warned",
      reason: `Flexible bundle has ${outOfStockCount} out-of-stock variant(s) but still meets lowest tier threshold. Merchant warned.`,
    };
  }

  return {
    bundle_id: bundleId,
    new_health_status: "healthy",
    should_disable: false,
    event_kind: "cleared",
    reason: "All variants available.",
  };
}

/**
 * Apply a health evaluation result to the database:
 *  1. Update bundles.health_status (and disable if needed)
 *  2. Insert a bundle_health_events row
 *
 * Skips write if the bundle's current health_status already matches the new one
 * (to avoid redundant rows in bundle_health_events).
 */
export async function applyBundleHealthResult(
  result: BundleHealthEvalResult,
  affectedVariantExternalId: string | null,
): Promise<void> {
  // Read current health to check idempotency
  const [current] = await sql<{ health_status: BundleHealthStatus; enabled: boolean }[]>`
    SELECT health_status, enabled
    FROM bundles
    WHERE id = ${result.bundle_id}
  `;
  if (!current) return;

  const noChange =
    current.health_status === result.new_health_status &&
    (!result.should_disable || !current.enabled);

  if (noChange) return;

  await sql.begin(async (tx) => {
    // Update bundle health_status and optionally disable
    if (result.should_disable) {
      await tx`
        UPDATE bundles
        SET
          health_status = ${result.new_health_status},
          enabled       = false,
          updated_at    = now()
        WHERE id = ${result.bundle_id}
      `;
    } else {
      await tx`
        UPDATE bundles
        SET
          health_status = ${result.new_health_status},
          updated_at    = now()
        WHERE id = ${result.bundle_id}
      `;
    }

    // Insert health event log
    const affId = affectedVariantExternalId
      ? BigInt(affectedVariantExternalId)
      : null;
    await tx`
      INSERT INTO bundle_health_events
        (bundle_id, event_kind, affected_variant_external_id, reason)
      VALUES
        (${result.bundle_id}, ${result.event_kind}, ${affId}, ${result.reason})
    `;
  });
}

/**
 * Run a full health check for all bundles that contain a given variant,
 * and apply the results.
 */
export async function checkBundlesForVariant(
  variantExternalId: string,
  affectedVariantExternalIdForLog: string | null,
): Promise<void> {
  // Find all bundles that contain this variant
  const affectedBundles = await sql<
    { bundle_id: BundleId; mode: BundleMode; health_status: BundleHealthStatus }[]
  >`
    SELECT bi.bundle_id, b.mode, b.health_status
    FROM bundle_items bi
    JOIN bundles b ON b.id = bi.bundle_id
    WHERE bi.variant_external_id = ${BigInt(variantExternalId)}
  `;

  for (const bundle of affectedBundles) {
    // Load all items for this bundle
    const items = await sql<
      Pick<BundleItemRow, "observed_availability">[]
    >`
      SELECT observed_availability
      FROM bundle_items
      WHERE bundle_id = ${bundle.bundle_id}
    `;

    // Load tiers for threshold checks
    const tiers = await sql<
      Pick<BundleTierRow, "minimum_item_count">[]
    >`
      SELECT minimum_item_count
      FROM bundle_tiers
      WHERE bundle_id = ${bundle.bundle_id}
    `;

    const evalResult = evaluateBundleHealth(
      bundle.bundle_id,
      bundle.mode,
      items,
      tiers,
    );

    await applyBundleHealthResult(evalResult, affectedVariantExternalIdForLog);
  }
}

/**
 * Compute the highest earned tier for a given selection count.
 * Returns null if no tier threshold is met.
 */
export function computeEarnedTier(
  selectedCount: number,
  tiers: Pick<BundleTierRow, "id" | "minimum_item_count" | "discount_rate">[],
): Pick<BundleTierRow, "id" | "minimum_item_count" | "discount_rate"> | null {
  // Sort descending by minimum_item_count to find the highest qualifying tier
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

/**
 * Update observed_availability for a variant in all bundle_items rows.
 * Returns early (no write) if the variant's stored availability already
 * matches newAvailability.
 */
export async function updateVariantObservedAvailability(
  variantExternalId: string,
  newAvailability: ObservedAvailability,
): Promise<boolean> {
  const rows = await sql<{ observed_availability: ObservedAvailability }[]>`
    SELECT observed_availability
    FROM bundle_items
    WHERE variant_external_id = ${BigInt(variantExternalId)}
    LIMIT 1
  `;

  if (rows.length === 0) {
    // No bundle references this variant; nothing to do
    return false;
  }

  const currentAvailability = rows[0].observed_availability;

  // Invariant: deleted is terminal
  if (currentAvailability === "deleted") {
    return false;
  }

  // No-op if already matches
  if (currentAvailability === newAvailability) {
    return false;
  }

  await sql`
    UPDATE bundle_items
    SET observed_availability = ${newAvailability}
    WHERE variant_external_id = ${BigInt(variantExternalId)}
  `;

  return true;
}
