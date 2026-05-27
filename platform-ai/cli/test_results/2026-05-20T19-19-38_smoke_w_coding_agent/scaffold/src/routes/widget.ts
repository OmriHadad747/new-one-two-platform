import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import { money } from "../lib/money.js";
import { computeEarnedTier } from "../lib/bundle-health.js";
import type {
  BundleId,
  BundleMode,
  BundleHealthStatus,
  BundleItemSummary,
  BundleTierSummary,
  BundleItemRow,
  BundleTierRow,
  BundleRow,
  VariantExternalId,
  WidgetBundleRequest,
  WidgetBundleResponse,
  ValidateBundleRequest,
  ValidateBundleResponse,
  CartAddRequest,
  CartAddResponse,
} from "../types/contracts.js";

export const widgetRouter = Router();

// ─── GET /widget/bundle ───────────────────────────────────────────────────────
widgetRouter.get("/widget/bundle", async (req: Request, res: Response) => {
  const query = req.query as Record<string, string>;
  const bundleId = query.bundle_id as BundleId | undefined;

  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const cursor = query.cursor ?? null;
  const pageSize = 50;

  const [bundle] = await sql<BundleRow[]>`
    SELECT id, title, description, mode, enabled, health_status, created_at, updated_at
    FROM bundles
    WHERE id = ${bundleId}
  `;

  if (!bundle) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  if (!bundle.enabled) {
    res.status(404).json({ error: "bundle not available" });
    return;
  }

  // Fetch tiers ordered by display_order
  const tiers = await sql<BundleTierRow[]>`
    SELECT id, bundle_id, minimum_item_count, discount_rate, display_order, created_at, updated_at
    FROM bundle_tiers
    WHERE bundle_id = ${bundleId}
    ORDER BY display_order ASC
  `;

  // Fetch items with cursor pagination
  const cursorClause = cursor ? sql`AND i.added_at < ${new Date(cursor)}` : sql``;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM bundle_items i
    WHERE i.bundle_id = ${bundleId}
      AND i.observed_availability = 'available'
  `;
  const totalCount = parseInt(countRow?.count ?? "0", 10);

  const itemRows = await sql<BundleItemRow[]>`
    SELECT id, bundle_id, variant_external_id, product_external_id, observed_availability, added_at
    FROM bundle_items i
    WHERE i.bundle_id = ${bundleId}
      AND i.observed_availability = 'available'
    ${cursorClause}
    ORDER BY i.added_at ASC
    LIMIT ${pageSize + 1}
  `;

  let nextCursor: string | null = null;
  if (itemRows.length > pageSize) {
    itemRows.pop();
    const last = itemRows[itemRows.length - 1];
    if (last) nextCursor = last.added_at.toISOString();
  }

  const tierSummaries: BundleTierSummary[] = tiers.map((t) => ({
    id: t.id,
    bundle_id: t.bundle_id,
    minimum_item_count: t.minimum_item_count,
    discount_rate: t.discount_rate,
    display_order: t.display_order,
    created_at: t.created_at.toISOString(),
    updated_at: t.updated_at.toISOString(),
  }));

  const items: BundleItemSummary[] = itemRows.map((r) => ({
    id: r.id,
    bundle_id: r.bundle_id,
    variant_external_id: r.variant_external_id,
    product_external_id: r.product_external_id,
    observed_availability: r.observed_availability,
    added_at: r.added_at.toISOString(),
  }));

  const response: WidgetBundleResponse = {
    bundle: {
      id: bundle.id,
      title: bundle.title,
      description: bundle.description,
      mode: bundle.mode as BundleMode,
      enabled: bundle.enabled,
      health_status: bundle.health_status as BundleHealthStatus,
    },
    tiers: tierSummaries,
    items,
    next_cursor: nextCursor,
    total_count: totalCount,
  };

  res.json(response);
});

// ─── POST /widget/bundle/validate ─────────────────────────────────────────────
widgetRouter.post("/widget/bundle/validate", async (req: Request, res: Response) => {
  const body = req.body as ValidateBundleRequest;

  if (!body.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  if (!Array.isArray(body.selected_variant_ids) || body.selected_variant_ids.length === 0) {
    res.status(400).json({ error: "selected_variant_ids must be a non-empty array" });
    return;
  }

  const errors: string[] = [];

  // Load bundle
  const [bundle] = await sql<BundleRow[]>`
    SELECT id, mode, enabled, health_status FROM bundles WHERE id = ${body.bundle_id}
  `;
  if (!bundle) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }
  if (!bundle.enabled) {
    res.status(422).json({ valid: false, earned_tier: null, discount_rate: 0, validation_errors: ["Bundle is not currently active."] });
    return;
  }

  // Load bundle items
  const itemPool = await sql<Pick<BundleItemRow, "variant_external_id" | "observed_availability">[]>`
    SELECT variant_external_id, observed_availability
    FROM bundle_items
    WHERE bundle_id = ${body.bundle_id}
  `;

  const availableVariantSet = new Set(
    itemPool
      .filter((i) => i.observed_availability === "available")
      .map((i) => i.variant_external_id)
  );
  const allVariantSet = new Set(itemPool.map((i) => i.variant_external_id));

  // Validate each selected variant
  for (const variantId of body.selected_variant_ids) {
    if (!allVariantSet.has(variantId as VariantExternalId)) {
      errors.push(`Variant ${variantId} is not part of this bundle.`);
    } else if (!availableVariantSet.has(variantId as VariantExternalId)) {
      errors.push(`Variant ${variantId} is currently out of stock or unavailable.`);
    }
  }

  if (errors.length > 0) {
    const response: ValidateBundleResponse = {
      valid: false,
      earned_tier: null,
      discount_rate: 0,
      validation_errors: errors,
    };
    res.json(response);
    return;
  }

  // Load tiers
  const tiers = await sql<BundleTierRow[]>`
    SELECT id, bundle_id, minimum_item_count, discount_rate, display_order, created_at, updated_at
    FROM bundle_tiers
    WHERE bundle_id = ${body.bundle_id}
    ORDER BY minimum_item_count DESC
  `;

  if (tiers.length === 0) {
    const response: ValidateBundleResponse = {
      valid: false,
      earned_tier: null,
      discount_rate: 0,
      validation_errors: ["Bundle has no discount tiers configured."],
    };
    res.json(response);
    return;
  }

  const selectedCount = body.selected_variant_ids.length;
  const earnedTierRow = computeEarnedTier(selectedCount, tiers);

  if (!earnedTierRow) {
    const lowestMinCount = tiers[tiers.length - 1]!.minimum_item_count;
    const response: ValidateBundleResponse = {
      valid: false,
      earned_tier: null,
      discount_rate: 0,
      validation_errors: [
        `You have selected ${selectedCount} item(s) but the minimum for any discount tier is ${lowestMinCount}.`,
      ],
    };
    res.json(response);
    return;
  }

  const earnedTier: BundleTierSummary = {
    id: earnedTierRow.id,
    bundle_id: earnedTierRow.bundle_id,
    minimum_item_count: earnedTierRow.minimum_item_count,
    discount_rate: earnedTierRow.discount_rate,
    display_order: earnedTierRow.display_order,
    created_at: earnedTierRow.created_at.toISOString(),
    updated_at: earnedTierRow.updated_at.toISOString(),
  };

  const response: ValidateBundleResponse = {
    valid: true,
    earned_tier: earnedTier,
    discount_rate: earnedTierRow.discount_rate,
    validation_errors: [],
  };
  res.json(response);
});

// ─── POST /widget/cart/add ────────────────────────────────────────────────────
widgetRouter.post("/widget/cart/add", async (req: Request, res: Response) => {
  const body = req.body as CartAddRequest;

  if (!body.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  if (!Array.isArray(body.selected_variant_ids) || body.selected_variant_ids.length === 0) {
    res.status(400).json({ error: "selected_variant_ids is required" });
    return;
  }
  if (!Array.isArray(body.quantities) || body.quantities.length !== body.selected_variant_ids.length) {
    res.status(400).json({ error: "quantities must match selected_variant_ids length" });
    return;
  }

  const errors: string[] = [];

  // Load and validate bundle
  const [bundle] = await sql<BundleRow[]>`
    SELECT id, mode, enabled, health_status FROM bundles WHERE id = ${body.bundle_id}
  `;
  if (!bundle) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }
  if (!bundle.enabled) {
    const response: CartAddResponse = {
      success: false,
      cart_external_id: null,
      applied_discount_rate: 0,
      errors: ["Bundle is not currently active."],
    };
    res.json(response);
    return;
  }

  // Validate all selected variants belong to bundle and are available
  const itemPool = await sql<Pick<BundleItemRow, "variant_external_id" | "observed_availability">[]>`
    SELECT variant_external_id, observed_availability
    FROM bundle_items
    WHERE bundle_id = ${body.bundle_id}
  `;

  const availableVariantSet = new Set(
    itemPool
      .filter((i) => i.observed_availability === "available")
      .map((i) => i.variant_external_id)
  );
  const allVariantSet = new Set(itemPool.map((i) => i.variant_external_id));

  for (const variantId of body.selected_variant_ids) {
    if (!allVariantSet.has(variantId as VariantExternalId)) {
      errors.push(`Variant ${variantId} is not part of this bundle.`);
    } else if (!availableVariantSet.has(variantId as VariantExternalId)) {
      errors.push(`Variant ${variantId} is currently out of stock or unavailable.`);
    }
  }

  if (errors.length > 0) {
    const response: CartAddResponse = {
      success: false,
      cart_external_id: null,
      applied_discount_rate: 0,
      errors,
    };
    res.json(response);
    return;
  }

  // Determine earned tier
  const tiers = await sql<BundleTierRow[]>`
    SELECT id, bundle_id, minimum_item_count, discount_rate, display_order, created_at, updated_at
    FROM bundle_tiers
    WHERE bundle_id = ${body.bundle_id}
    ORDER BY minimum_item_count DESC
  `;

  const selectedCount = body.selected_variant_ids.length;
  const earnedTier = computeEarnedTier(selectedCount, tiers);

  if (!earnedTier) {
    const lowestMinCount = tiers.length > 0 ? tiers[tiers.length - 1]!.minimum_item_count : 1;
    const response: CartAddResponse = {
      success: false,
      cart_external_id: null,
      applied_discount_rate: 0,
      errors: [
        `Selection does not meet the minimum item threshold (${lowestMinCount} items required).`,
      ],
    };
    res.json(response);
    return;
  }

  // Build the cart items for the Shopify Ajax API
  // The widget will use host.storefront to add to cart; we return the discount rate
  // The actual cart manipulation is handled client-side via host.storefront
  // Here we validate and return the approved discount rate
  const discountRateBasisPoints = earnedTier.discount_rate;
  const discountPct = discountRateBasisPoints / 100; // e.g. 1000 bp → 10.00%

  // Store the bundle_id on the cart note_attributes so the orders/paid webhook
  // can match the purchase to a bundle
  // We return the info the widget needs to perform the cart add
  const response: CartAddResponse = {
    success: true,
    cart_external_id: null, // cart ID is managed client-side
    applied_discount_rate: discountRateBasisPoints,
    errors: [],
  };

  console.log(
    {
      requestId: req.platform!.requestId,
      bundleId: body.bundle_id,
      selectedCount,
      discountBp: discountRateBasisPoints,
    },
    "bundle cart add validated"
  );

  res.json(response);
});
