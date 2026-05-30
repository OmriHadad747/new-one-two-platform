import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import { money } from "../lib/money.js";
import type {
  BundleId,
  BundleComponentId,
  BundleTierId,
  BundleDefinitionRow,
  BundleComponentRow,
  BundleDiscountTierRow,
  WidgetListBundlesRequest,
  WidgetListBundlesResponse,
  WidgetBundleSummary,
  WidgetBundleComponent,
  WidgetBundleTierSummary,
  WidgetAddToCartRequest,
  WidgetAddToCartResponse,
  WidgetPreviewTotalRequest,
  WidgetPreviewTotalResponse,
  CartLinesAddResult,
  CartDiscountCodesUpdateResult,
  ProductVariantQueryResult,
  ShopifyVariantExternalId,
  DiscountKind,
} from "../types/contracts.js";

export const widgetRouter = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a Shopify Storefront merchandise GID from a numeric variant external id */
function variantMerchandiseGid(variantExternalId: string): string {
  return `gid://shopify/ProductVariant/${variantExternalId}`;
}

/** Find the best matching tier for the given item count */
function selectTier(tiers: BundleDiscountTierRow[], itemCount: number): BundleDiscountTierRow | null {
  // Tiers ordered ascending by min_item_count; pick the highest applicable one
  const applicable = tiers.filter((t) => t.min_item_count <= itemCount);
  if (applicable.length === 0) return null;
  return applicable[applicable.length - 1] ?? null;
}

/** Calculate discounted total from tier and original total */
function applyTierDiscount(
  originalTotalMinor: number,
  tier: BundleDiscountTierRow,
  discountKind: DiscountKind,
  currency: string,
): { discountedTotal: number; discountAmount: number; tierLabel: string } {
  if (discountKind === "percentage" && tier.discount_value != null) {
    const basisPoints = parseInt(tier.discount_value, 10);
    const discountAmount = money.percentage(originalTotalMinor, basisPoints / 100);
    const discountedTotal = originalTotalMinor - discountAmount;
    const pct = (basisPoints / 100).toFixed(0);
    return {
      discountedTotal: Math.max(0, discountedTotal),
      discountAmount,
      tierLabel: `${pct}% off (${tier.min_item_count}+ items)`,
    };
  }

  if (discountKind === "flat-amount" && tier.discount_amount != null) {
    const flatAmount = parseInt(tier.discount_amount, 10);
    const discountedTotal = originalTotalMinor - flatAmount;
    return {
      discountedTotal: Math.max(0, discountedTotal),
      discountAmount: flatAmount,
      tierLabel: `${money.format(flatAmount, currency)} off (${tier.min_item_count}+ items)`,
    };
  }

  if (discountKind === "buy-x-get-y" && tier.free_item_count != null) {
    // Approximate: cheapest free_item_count items are free. We don't have per-item
    // prices here, so report 0 discount at preview level — accurate total comes
    // from cart at checkout. We surface the tier label for the UI.
    return {
      discountedTotal: originalTotalMinor,
      discountAmount: 0,
      tierLabel: `Buy ${tier.min_item_count - tier.free_item_count} get ${tier.free_item_count} free`,
    };
  }

  return { discountedTotal: originalTotalMinor, discountAmount: 0, tierLabel: "No discount" };
}

// ─── GET /widget/bundles ──────────────────────────────────────────────────────

widgetRouter.get("/widget/bundles", async (req: Request, res: Response) => {
  const rawProductId = typeof req.query.product_external_id === "string"
    ? req.query.product_external_id
    : null;
  if (!rawProductId || !/^\d+$/.test(rawProductId)) {
    res.status(400).json({ error: "product_external_id must be a numeric string" });
    return;
  }
  const rawCursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const cursorDate: string | null = rawCursor
    ? Buffer.from(rawCursor, "base64").toString("utf8")
    : null;

  const productExternalId = rawProductId;

  try {
    // Find bundles that are enabled, healthy, and contain this product
    type BundleWithCursor = BundleDefinitionRow;

    const bundleRows = await sql<BundleWithCursor[]>`
      SELECT DISTINCT b.*
      FROM bundle_definitions b
      JOIN bundle_components bc ON bc.bundle_id = b.id
      WHERE bc.product_external_id = ${productExternalId}
        AND b.enabled = true
        AND b.health_status = 'ok'
        ${cursorDate ? sql`AND b.created_at < ${cursorDate}` : sql``}
      ORDER BY b.created_at DESC
      LIMIT 11
    `;

    const hasMore = bundleRows.length > 10;
    const pageRows = hasMore ? bundleRows.slice(0, 10) : bundleRows;

    const lastPageRow = pageRows[pageRows.length - 1];
    const nextCursor: string | null = hasMore && lastPageRow
      ? Buffer.from(lastPageRow.created_at).toString("base64")
      : null;

    const [countRow] = await sql<{ count: string }[]>`
      SELECT COUNT(DISTINCT b.id) AS count
      FROM bundle_definitions b
      JOIN bundle_components bc ON bc.bundle_id = b.id
      WHERE bc.product_external_id = ${productExternalId}
        AND b.enabled = true
        AND b.health_status = 'ok'
    `;
    const totalCount = parseInt(countRow?.count ?? "0", 10);

    // Fetch components and tiers for each bundle
    const bundles: WidgetBundleSummary[] = [];

    for (const bundleRow of pageRows) {
      const componentRows = await sql<BundleComponentRow[]>`
        SELECT * FROM bundle_components WHERE bundle_id = ${bundleRow.id} ORDER BY position
      `;
      const tierRows = await sql<BundleDiscountTierRow[]>`
        SELECT * FROM bundle_discount_tiers WHERE bundle_id = ${bundleRow.id} ORDER BY min_item_count
      `;

      // Build live-resolved components — emit live_variant_gid for any pinned variant
      const components: WidgetBundleComponent[] = componentRows.map((c) => ({
        id: c.id as BundleComponentId,
        bundle_id: c.bundle_id as BundleId,
        product_external_id: c.product_external_id,
        variant_external_id: c.variant_external_id,
        quantity: c.quantity,
        position: c.position,
        // live_variant_gid: only set when variant_external_id is non-null
        // Widget MUST use live_variant_gid for cart operations, never build its own GID
        live_variant_gid: c.variant_external_id
          ? variantMerchandiseGid(c.variant_external_id)
          : null,
      }));

      const tiers: WidgetBundleTierSummary[] = tierRows.map((t) => ({
        id: t.id as BundleTierId,
        min_item_count: t.min_item_count,
        discount_value: t.discount_value,
        discount_amount: t.discount_amount,
        free_item_count: t.free_item_count,
        discount_code: t.discount_code,
      }));

      bundles.push({
        id: bundleRow.id,
        title: bundleRow.title,
        bundle_type: bundleRow.bundle_type,
        flexible_pick_count: bundleRow.flexible_pick_count,
        discount_kind: bundleRow.discount_kind,
        components,
        tiers,
      });
    }

    const response: WidgetListBundlesResponse = { bundles, next_cursor: nextCursor, total_count: totalCount };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "GET /widget/bundles failed");
    res.status(500).json({ error: "internal error" });
  }
});

// ─── POST /widget/bundle/add-to-cart ─────────────────────────────────────────

widgetRouter.post("/widget/bundle/add-to-cart", async (req: Request, res: Response) => {
  const body = req.body as WidgetAddToCartRequest;
  const { bundle_id, cart_external_id, selected_variant_external_ids, item_count } = body;

  if (!bundle_id) {
    res.status(400).json({ error: "bundle_id required" });
    return;
  }
  if (!cart_external_id) {
    res.status(400).json({ error: "cart_external_id required" });
    return;
  }
  if (!Array.isArray(selected_variant_external_ids) || selected_variant_external_ids.length === 0) {
    res.status(400).json({ error: "selected_variant_external_ids must be a non-empty array" });
    return;
  }
  if (typeof item_count !== "number" || item_count < 1) {
    res.status(400).json({ error: "item_count must be a positive number" });
    return;
  }

  // Validate variant ids are numeric strings
  for (const vid of selected_variant_external_ids) {
    if (typeof vid !== "string" || !/^\d+$/.test(vid)) {
      res.status(400).json({ error: `invalid variant id: ${vid} — must be a numeric string` });
      return;
    }
  }

  // Fetch bundle
  const [bundleRow] = await sql<BundleDefinitionRow[]>`
    SELECT * FROM bundle_definitions WHERE id = ${bundle_id} AND enabled = true AND health_status = 'ok'
  `;
  if (!bundleRow) {
    res.status(404).json({ error: "bundle not found, disabled, or degraded" });
    return;
  }

  // Validate flexible pick count
  if (bundleRow.bundle_type === "flexible" && bundleRow.flexible_pick_count != null) {
    if (selected_variant_external_ids.length !== bundleRow.flexible_pick_count) {
      res.status(400).json({
        error: `flexible bundle requires exactly ${bundleRow.flexible_pick_count} items; got ${selected_variant_external_ids.length}`,
      });
      return;
    }
  }

  // Fetch tiers
  const tiers = await sql<BundleDiscountTierRow[]>`
    SELECT * FROM bundle_discount_tiers WHERE bundle_id = ${bundle_id} ORDER BY min_item_count
  `;

  const matchedTier = selectTier(tiers, item_count);
  if (!matchedTier) {
    res.status(400).json({ error: "no discount tier applies for this item count" });
    return;
  }

  // Fetch variant prices for discounted total computation
  const shopify = await shopifyClientFor(req.platform!);
  const warnings: string[] = [];

  // Resolve variant prices for preview total computation
  let originalTotalMinor = 0;
  let currency = "USD";

  for (const variantId of selected_variant_external_ids) {
    try {
      const variantGid = `gid://shopify/ProductVariant/${variantId}`;
      const variantData = await shopify.graphql<ProductVariantQueryResult>(
        `query GetVariant($id: ID!) {
           productVariant(id: $id) {
             id
             price
             availableForSale
             legacyResourceId
           }
         }`,
        { id: variantGid },
      );

      if (!variantData.productVariant) {
        warnings.push(`variant ${variantId} not found in Shopify`);
        continue;
      }
      if (!variantData.productVariant.availableForSale) {
        warnings.push(`variant ${variantId} is not available for sale`);
      }

      originalTotalMinor += money.toMinorUnits(variantData.productVariant.price, currency);
    } catch (err) {
      warnings.push(`could not fetch price for variant ${variantId}: ${String(err)}`);
    }
  }

  // Build cart line inputs using merchandise GIDs — always from variant external ids as numeric strings
  const cartLines = selected_variant_external_ids.map((vid: ShopifyVariantExternalId) => ({
    merchandiseId: variantMerchandiseGid(vid),
    quantity: 1,
  }));

  // Step 1: Add lines to cart via Storefront API
  const addResult = await shopify.storefront<CartLinesAddResult>(
    `mutation AddLines($cartId: ID!, $lines: [CartLineInput!]!) {
       cartLinesAdd(cartId: $cartId, lines: $lines) {
         cart {
           id
           discountCodes { code applicable }
         }
         userErrors { field message }
       }
     }`,
    { cartId: cart_external_id, lines: cartLines },
  );

  if (addResult.cartLinesAdd.userErrors.length > 0) {
    const msgs = addResult.cartLinesAdd.userErrors.map((e) => e.message).join("; ");
    res.status(400).json({ error: `cartLinesAdd failed: ${msgs}` });
    return;
  }

  const updatedCartId = addResult.cartLinesAdd.cart?.id ?? cart_external_id;

  // Check if the bundle's discount code is already applied (edge case: duplicate bundle add)
  const existingDiscountCodes = addResult.cartLinesAdd.cart?.discountCodes ?? [];
  const codeAlreadyApplied = existingDiscountCodes.some((dc) => dc.code === matchedTier.discount_code);

  if (codeAlreadyApplied) {
    warnings.push("Bundle discount code is already applied to this cart. A second discount will not stack.");
  }

  // Step 2: Apply tier discount code to cart (skip if already applied)
  if (!codeAlreadyApplied) {
    const existingCodes = existingDiscountCodes.map((dc) => dc.code);
    const updatedCodes = [...existingCodes, matchedTier.discount_code];

    const discountResult = await shopify.storefront<CartDiscountCodesUpdateResult>(
      `mutation ApplyDiscount($cartId: ID!, $codes: [String!]!) {
         cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $codes) {
           cart {
             id
             discountCodes { code applicable }
           }
           userErrors { field message }
         }
       }`,
      { cartId: updatedCartId, discountCodes: updatedCodes },
    );

    if (discountResult.cartDiscountCodesUpdate.userErrors.length > 0) {
      const msgs = discountResult.cartDiscountCodesUpdate.userErrors.map((e) => e.message).join("; ");
      warnings.push(`cartDiscountCodesUpdate warning: ${msgs}. Cart lines were added but discount may not be applied. Please re-sync bundle discount codes from the admin.`);
    }
  }

  // Compute discounted total
  const { discountedTotal } = applyTierDiscount(
    originalTotalMinor,
    matchedTier,
    bundleRow.discount_kind,
    currency,
  );

  const response: WidgetAddToCartResponse = {
    cart_external_id: updatedCartId,
    discount_code: matchedTier.discount_code,
    discounted_total: discountedTotal,
    warnings,
  };
  res.json(response);
});

// ─── POST /widget/bundle/preview-total ───────────────────────────────────────

widgetRouter.post("/widget/bundle/preview-total", async (req: Request, res: Response) => {
  const body = req.body as WidgetPreviewTotalRequest;
  const { bundle_id, selected_variant_external_ids, item_count } = body;

  if (!bundle_id) {
    res.status(400).json({ error: "bundle_id required" });
    return;
  }
  if (!Array.isArray(selected_variant_external_ids) || selected_variant_external_ids.length === 0) {
    res.status(400).json({ error: "selected_variant_external_ids must be non-empty" });
    return;
  }
  if (typeof item_count !== "number" || item_count < 1) {
    res.status(400).json({ error: "item_count must be a positive number" });
    return;
  }

  // Validate variant ids
  for (const vid of selected_variant_external_ids) {
    if (typeof vid !== "string" || !/^\d+$/.test(vid)) {
      res.status(400).json({ error: `invalid variant id: ${vid} — must be a numeric string` });
      return;
    }
  }

  // Fetch bundle
  const [bundleRow] = await sql<BundleDefinitionRow[]>`
    SELECT * FROM bundle_definitions WHERE id = ${bundle_id} AND enabled = true AND health_status = 'ok'
  `;
  if (!bundleRow) {
    res.status(404).json({ error: "bundle not found, disabled, or degraded" });
    return;
  }

  // Fetch tiers
  const tiers = await sql<BundleDiscountTierRow[]>`
    SELECT * FROM bundle_discount_tiers WHERE bundle_id = ${bundle_id} ORDER BY min_item_count
  `;

  const matchedTier = selectTier(tiers, item_count);

  // Resolve variant prices from Shopify Admin API
  const shopify = await shopifyClientFor(req.platform!);
  let originalTotalMinor = 0;
  const currency = "USD";

  for (const variantId of selected_variant_external_ids) {
    try {
      const variantGid = `gid://shopify/ProductVariant/${variantId}`;
      const variantData = await shopify.graphql<ProductVariantQueryResult>(
        `query GetVariant($id: ID!) {
           productVariant(id: $id) {
             id
             price
             availableForSale
             legacyResourceId
           }
         }`,
        { id: variantGid },
      );
      if (variantData.productVariant) {
        originalTotalMinor += money.toMinorUnits(variantData.productVariant.price, currency);
      }
    } catch (_err) {
      // best-effort; proceed with partial total
    }
  }

  if (!matchedTier) {
    const response: WidgetPreviewTotalResponse = {
      original_total: originalTotalMinor,
      discounted_total: originalTotalMinor,
      tier_label: "No tier applies for this item count",
      discount_amount: 0,
    };
    res.json(response);
    return;
  }

  const { discountedTotal, discountAmount, tierLabel } = applyTierDiscount(
    originalTotalMinor,
    matchedTier,
    bundleRow.discount_kind,
    currency,
  );

  const response: WidgetPreviewTotalResponse = {
    original_total: originalTotalMinor,
    discounted_total: discountedTotal,
    tier_label: tierLabel,
    discount_amount: discountAmount,
  };
  res.json(response);
});

// Satisfy unused import references
type _DiscountKind = DiscountKind;
