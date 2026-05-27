// Shared bundle-health helpers used by both webhook handlers and the
// cron job that evaluates a bundle. Centralised so all callers compute
// the same answer for the same inputs.

import { sql } from "./db.js";
import type {
  BundleId,
  BundleHealth,
  BundleItemRow,
  BundleMode,
  BundleRow,
  BundleTierRow,
  HealthEventKind,
  VariantAvailability,
} from "../types/contracts.js";

export interface EvaluatedHealth {
  health: BundleHealth;
  enabled: boolean;
  reason: string;
}

/**
 * Pure function — given a bundle's mode, item availability list, and
 * tier list, decide the target health + enabled state.
 *
 * Rules:
 *   - fixed: any deleted variant → auto_disabled; any out_of_stock → warned.
 *   - flexible: if available-count < lowest tier threshold → auto_disabled.
 *               else if any item out_of_stock or deleted → warned.
 *               else healthy.
 */
export function evaluateBundleHealth(
  mode: BundleMode,
  items: ReadonlyArray<{ observed_availability: VariantAvailability }>,
  tiers: ReadonlyArray<{ minimum_item_count: number }>,
): EvaluatedHealth {
  const availableCount = items.filter((i) => i.observed_availability === "available").length;
  const hasDeleted = items.some((i) => i.observed_availability === "deleted");
  const hasOutOfStock = items.some((i) => i.observed_availability === "out_of_stock");

  if (mode === "fixed") {
    if (hasDeleted) {
      return {
        health: "auto_disabled",
        enabled: false,
        reason: "fixed_bundle_has_deleted_variant",
      };
    }
    if (hasOutOfStock) {
      return { health: "warned", enabled: true, reason: "fixed_bundle_has_out_of_stock" };
    }
    return { health: "healthy", enabled: true, reason: "all_items_available" };
  }

  // flexible
  const lowestThreshold =
    tiers.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.min(...tiers.map((t) => t.minimum_item_count));

  if (availableCount < lowestThreshold) {
    return {
      health: "auto_disabled",
      enabled: false,
      reason: "flexible_bundle_below_lowest_tier_threshold",
    };
  }
  if (hasDeleted || hasOutOfStock) {
    return { health: "warned", enabled: true, reason: "flexible_bundle_partial_availability" };
  }
  return { health: "healthy", enabled: true, reason: "all_items_available" };
}

/**
 * Returns blocking variant identifiers for a bundle — variants that are
 * NOT in the "available" state. Used to gate manual re-enable.
 */
export async function findBlockingVariants(bundleId: BundleId): Promise<string[]> {
  const rows = await sql<{ variant_external_id: string }[]>`
    SELECT variant_external_id::text AS variant_external_id
      FROM bundle_items
     WHERE bundle_id = ${bundleId}
       AND observed_availability <> 'available'
  `;
  return rows.map((r) => r.variant_external_id);
}

/**
 * Full evaluate-and-apply cycle for one bundle. Loads the bundle, its
 * items and tiers, computes the target state, and applies it (with a
 * health event log row) if the state actually changes.
 *
 * Returns the resolved state regardless of whether a write occurred.
 */
export async function applyBundleHealth(
  bundleId: BundleId,
  triggeringVariantId: string | null,
): Promise<EvaluatedHealth | null> {
  const bundles = await sql<BundleRow[]>`
    SELECT id, title, description, mode, enabled, health_status, created_at, updated_at
      FROM bundles
     WHERE id = ${bundleId}
  `;
  const bundle = bundles[0];
  if (!bundle) return null;

  const items = await sql<BundleItemRow[]>`
    SELECT id, bundle_id, variant_external_id::text AS variant_external_id,
           product_external_id::text AS product_external_id,
           observed_availability, added_at
      FROM bundle_items
     WHERE bundle_id = ${bundleId}
  `;
  const tiers = await sql<BundleTierRow[]>`
    SELECT id, bundle_id, minimum_item_count, discount_rate, display_order,
           created_at, updated_at
      FROM bundle_tiers
     WHERE bundle_id = ${bundleId}
  `;

  const target = evaluateBundleHealth(bundle.mode, items, tiers);

  const statusChanged = bundle.health_status !== target.health;
  const enabledChanged = bundle.enabled !== target.enabled;

  if (!statusChanged && !enabledChanged) {
    return target;
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE bundles
         SET health_status = ${target.health},
             enabled = ${target.enabled},
             updated_at = now()
       WHERE id = ${bundleId}
    `;

    const eventKind: HealthEventKind =
      target.health === "auto_disabled"
        ? "auto_disabled"
        : target.health === "warned"
          ? "warned"
          : "cleared";

    await tx`
      INSERT INTO bundle_health_events
        (bundle_id, event_kind, affected_variant_external_id, reason)
      VALUES (
        ${bundleId},
        ${eventKind},
        ${triggeringVariantId},
        ${target.reason}
      )
    `;
  });

  return target;
}
