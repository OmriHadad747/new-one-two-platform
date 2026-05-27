import { sql } from "./db.js";
import type {
  BundleId,
  BundleRow,
  BundleItemRow,
  BundleTierRow,
  BundleHealthStatus,
  HealthEventKind,
  BundleHealthCheckResult,
  EarnedTierResult,
} from "../types/contracts.js";

/**
 * Evaluate the health of a bundle given its items and tiers.
 * Returns the resolved health status and event kind.
 */
export function evaluateBundleHealth(
  bundle: Pick<BundleRow, "id" | "mode" | "health_status">,
  items: BundleItemRow[],
  tiers: BundleTierRow[],
  _affectedVariantExternalId?: number
): BundleHealthCheckResult {
  const availableItems = items.filter((i) => i.observed_availability === "available");
  const unavailableItems = items.filter((i) => i.observed_availability !== "available");
  const deletedItems = items.filter((i) => i.observed_availability === "deleted");

  // Minimum tier threshold
  const sortedTiers = [...tiers].sort((a, b) => a.minimum_item_count - b.minimum_item_count);
  const lowestTierMin = sortedTiers.length > 0 ? sortedTiers[0].minimum_item_count : 1;

  let new_health_status: BundleHealthStatus;
  let should_auto_disable: boolean;
  let event_kind: HealthEventKind;
  let reason: string;

  if (deletedItems.length > 0) {
    // Any deleted variant forces auto-disable
    new_health_status = "auto_disabled";
    should_auto_disable = true;
    event_kind = "auto_disabled";
    const deletedIds = deletedItems.map((i) => i.variant_external_id).join(", ");
    reason = `Bundle auto-disabled: variant(s) ${deletedIds} have been permanently deleted.`;
  } else if (availableItems.length < lowestTierMin) {
    // Not enough available items to satisfy even the lowest tier
    new_health_status = "auto_disabled";
    should_auto_disable = true;
    event_kind = "auto_disabled";
    reason = `Bundle auto-disabled: only ${availableItems.length} available variant(s) remain, below minimum tier threshold of ${lowestTierMin}.`;
  } else if (unavailableItems.length > 0) {
    // Some items unavailable but bundle can still serve
    new_health_status = "warned";
    should_auto_disable = false;
    event_kind = "warned";
    const unavailableIds = unavailableItems.map((i) => i.variant_external_id).join(", ");
    reason = `Bundle warning: variant(s) ${unavailableIds} are out of stock. Bundle remains active but some selections may be unavailable.`;
  } else {
    // All items available
    new_health_status = "healthy";
    should_auto_disable = false;
    event_kind = "cleared";
    reason = "Bundle health restored: all variants are available.";
  }

  return {
    bundle_id: bundle.id,
    new_health_status,
    should_auto_disable,
    event_kind,
    reason,
  };
}

/**
 * Apply the health check result to the bundle record and log a health event.
 * Only writes if the health status has actually changed.
 */
export async function applyBundleHealthStatus(
  result: BundleHealthCheckResult,
  affectedVariantExternalId?: number
): Promise<void> {
  await sql.begin(async (tx) => {
    const [current] = await tx<{ health_status: BundleHealthStatus; enabled: boolean }[]>`
      SELECT health_status, enabled FROM bundles WHERE id = ${result.bundle_id}
    `;
    if (!current) return;

    if (current.health_status !== result.new_health_status) {
      const newEnabled = result.should_auto_disable ? false : current.enabled;
      await tx`
        UPDATE bundles
        SET health_status = ${result.new_health_status as string},
            enabled       = ${newEnabled},
            updated_at    = now()
        WHERE id = ${result.bundle_id}
      `;

      await tx`
        INSERT INTO bundle_health_events
          (bundle_id, event_kind, affected_variant_external_id, reason)
        VALUES (
          ${result.bundle_id},
          ${result.event_kind as string},
          ${affectedVariantExternalId ?? null},
          ${result.reason}
        )
      `;
    }
  });
}

/**
 * Find all unique bundle IDs that reference a given variant and run health checks.
 */
export async function runHealthChecksForVariant(variantExternalId: number): Promise<void> {
  const affectedBundles = await sql<{ bundle_id: BundleId }[]>`
    SELECT DISTINCT bundle_id FROM bundle_items WHERE variant_external_id = ${variantExternalId}
  `;

  for (const { bundle_id } of affectedBundles) {
    const [bundle] = await sql<BundleRow[]>`
      SELECT * FROM bundles WHERE id = ${bundle_id}
    `;
    if (!bundle) continue;

    const items = await sql<BundleItemRow[]>`
      SELECT * FROM bundle_items WHERE bundle_id = ${bundle_id}
    `;

    const tiers = await sql<BundleTierRow[]>`
      SELECT * FROM bundle_tiers WHERE bundle_id = ${bundle_id} ORDER BY minimum_item_count ASC
    `;

    const checkResult = evaluateBundleHealth(bundle, items, tiers, variantExternalId);
    await applyBundleHealthStatus(checkResult, variantExternalId);
  }
}

/**
 * Compute the highest earned tier for a given selection count.
 */
export function computeEarnedTier(
  selectedCount: number,
  tiers: BundleTierRow[]
): EarnedTierResult {
  // Sort descending by minimum_item_count to find the highest qualifying tier
  const sorted = [...tiers].sort((a, b) => b.minimum_item_count - a.minimum_item_count);
  const earned = sorted.find((t) => selectedCount >= t.minimum_item_count) ?? null;

  return {
    tier: earned,
    discount_rate: earned?.discount_rate ?? 0,
  };
}
