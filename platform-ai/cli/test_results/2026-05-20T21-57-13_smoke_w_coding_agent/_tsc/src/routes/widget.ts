import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import type {
  BundleId,
  BundleItemId,
  BundleTierId,
  VariantExternalId,
  ProductExternalId,
  BundleRow,
  BundleItemRow,
  BundleTierRow,
  GetWidgetBundleResponse,
  WidgetBundle,
  WidgetTier,
  WidgetItem,
  ValidateBundleRequest,
  ValidateBundleResponse,
  EarnedTier,
  CartAddRequest,
  CartAddResponse,
} from "../types/contracts.js";

export const widgetRouter = Router();

// ─── GET /widget/bundle ───────────────────────────────────────────────────────
widgetRouter.get("/widget/bundle", async (req: Request, res: Response) => {
  const bundleId =
    typeof req.query.bundle_id === "string" ? (req.query.bundle_id as BundleId) : null;
  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  const cursor =
    typeof req.query.cursor === "string" ? req.query.cursor : null;
  const PAGE_SIZE = 100;

  const bundleRows = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${bundleId}
  `;
  const b = bundleRows[0];
  if (!b) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  if (!b.enabled) {
    res.status(410).json({ error: "bundle is not active" });
    return;
  }

  // Fetch tiers ordered by display_order
  const tierRows = await sql<BundleTierRow[]>`
    SELECT * FROM bundle_tiers
    WHERE bundle_id = ${bundleId}
    ORDER BY display_order ASC
  `;

  // Fetch items paginated
  const itemRows = await sql<BundleItemRow[]>`
    SELECT * FROM bundle_items
    WHERE bundle_id = ${bundleId}
      AND (${cursor}::text IS NULL OR id::text > ${cursor}::text)
    ORDER BY added_at ASC, id ASC
    LIMIT ${PAGE_SIZE + 1}
  `;

  const hasMore = itemRows.length > PAGE_SIZE;
  const pageItems = hasMore ? itemRows.slice(0, PAGE_SIZE) : itemRows;
  const nextCursor: string | null = hasMore
    ? (pageItems[pageItems.length - 1]?.id ?? null)
    : null;

  const countRows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*)::text AS cnt FROM bundle_items WHERE bundle_id = ${bundleId}
  `;

  const bundle: WidgetBundle = {
    id: b.id,
    title: b.title,
    description: b.description,
    mode: b.mode,
    enabled: b.enabled,
    health_status: b.health_status,
  };

  const tiers: WidgetTier[] = tierRows.map((t) => ({
    id: t.id,
    minimum_item_count: t.minimum_item_count,
    discount_rate: t.discount_rate,
    display_order: t.display_order,
  }));

  const items: WidgetItem[] = pageItems.map((i) => ({
    id: i.id,
    variant_external_id: i.variant_external_id as unknown as VariantExternalId,
    product_external_id: i.product_external_id as unknown as ProductExternalId,
    observed_availability: i.observed_availability,
  }));

  const resp: GetWidgetBundleResponse = {
    bundle,
    tiers,
    items,
    next_cursor: nextCursor,
    total_count: parseInt(countRows[0]?.cnt ?? "0", 10),
  };
  res.json(resp);
});

// ─── POST /widget/bundle/validate ────────────────────────────────────────────
widgetRouter.post("/widget/bundle/validate", async (req: Request, res: Response) => {
  const body = req.body as ValidateBundleRequest;
  if (!body.bundle_id || typeof body.bundle_id !== "string") {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  if (!Array.isArray(body.selected_variant_ids) || body.selected_variant_ids.length === 0) {
    res.status(400).json({ error: "selected_variant_ids must be a non-empty array" });
    return;
  }

  const bundleRows = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${body.bundle_id}
  `;
  const bundle = bundleRows[0];
  if (!bundle) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }
  if (!bundle.enabled) {
    const resp: ValidateBundleResponse = {
      valid: false,
      earned_tier: null,
      discount_rate: 0,
      validation_errors: ["bundle is not active"],
    };
    res.json(resp);
    return;
  }

  const errors: string[] = [];

  // Fetch bundle items
  const itemRows = await sql<BundleItemRow[]>`
    SELECT * FROM bundle_items WHERE bundle_id = ${body.bundle_id}
  `;

  const itemPoolIds = new Set(itemRows.map((i) => String(i.variant_external_id)));
  const availabilityMap = new Map<string, string>(
    itemRows.map((i) => [String(i.variant_external_id), i.observed_availability])
  );

  // Check that all selected variants are in the bundle pool
  for (const variantId of body.selected_variant_ids) {
    if (!itemPoolIds.has(String(variantId))) {
      errors.push(`Variant ${variantId} is not part of this bundle`);
    }
  }

  // Check live availability via Shopify storefront
  const shopify = await shopifyClientFor(req.platform!);
  const gids = body.selected_variant_ids.map(
    (id) => `gid://shopify/ProductVariant/${id}`
  );

  const availabilityData = await shopify.storefront<{
    nodes: Array<{
      id: string;
      availableForSale: boolean;
      quantityAvailable: number | null;
    } | null>;
  }>(
    `query CheckVariantAvailability($ids: [ID!]!) {
       nodes(ids: $ids) {
         ... on ProductVariant {
           id
           availableForSale
           quantityAvailable
         }
       }
     }`,
    { ids: gids }
  );

  const liveAvailMap = new Map<string, boolean>();
  if (availabilityData.nodes) {
    for (const node of availabilityData.nodes) {
      if (node) {
        const numericId = node.id.replace("gid://shopify/ProductVariant/", "");
        liveAvailMap.set(numericId, node.availableForSale);
      }
    }
  }

  // Check each selected variant availability
  for (const variantId of body.selected_variant_ids) {
    const vidStr = String(variantId);
    const dbAvail = availabilityMap.get(vidStr);
    if (dbAvail === "deleted") {
      errors.push(`Variant ${variantId} has been deleted`);
      continue;
    }
    if (dbAvail === "out_of_stock") {
      errors.push(`Variant ${variantId} is out of stock`);
      continue;
    }
    const isLiveAvail = liveAvailMap.get(vidStr);
    if (isLiveAvail === false) {
      errors.push(`Variant ${variantId} is not available for sale`);
    }
  }

  // Fetch tiers ordered by minimum_item_count descending to find highest earned tier
  const tierRows = await sql<BundleTierRow[]>`
    SELECT * FROM bundle_tiers
    WHERE bundle_id = ${body.bundle_id}
    ORDER BY minimum_item_count DESC
  `;

  const selectionCount = body.selected_variant_ids.length;

  // Validate minimum tier threshold
  const sortedAsc = [...tierRows].sort((a, b) => a.minimum_item_count - b.minimum_item_count);
  const lowestThreshold = sortedAsc.length > 0 ? (sortedAsc[0]?.minimum_item_count ?? Infinity) : Infinity;

  if (selectionCount < lowestThreshold) {
    errors.push(
      `Selection of ${selectionCount} item(s) does not meet the minimum threshold of ${lowestThreshold}`
    );
  }

  // Determine earned tier (highest qualifying tier — first in DESC order)
  let earnedTier: EarnedTier | null = null;
  for (const tier of tierRows) {
    if (selectionCount >= tier.minimum_item_count) {
      earnedTier = {
        id: tier.id,
        minimum_item_count: tier.minimum_item_count,
        discount_rate: tier.discount_rate,
      };
      break;
    }
  }

  const resp: ValidateBundleResponse = {
    valid: errors.length === 0 && earnedTier !== null,
    earned_tier: earnedTier,
    discount_rate: earnedTier ? earnedTier.discount_rate : 0,
    validation_errors: errors,
  };
  res.json(resp);
});

// ─── POST /widget/cart/add ────────────────────────────────────────────────────
widgetRouter.post("/widget/cart/add", async (req: Request, res: Response) => {
  const body = req.body as CartAddRequest;
  if (!body.bundle_id || typeof body.bundle_id !== "string") {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  if (!Array.isArray(body.selected_variant_ids) || body.selected_variant_ids.length === 0) {
    res.status(400).json({ error: "selected_variant_ids must be a non-empty array" });
    return;
  }
  if (!Array.isArray(body.quantities) || body.quantities.length !== body.selected_variant_ids.length) {
    res.status(400).json({ error: "quantities must match selected_variant_ids length" });
    return;
  }

  const bundleRows = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${body.bundle_id}
  `;
  const bundleRow = bundleRows[0];
  if (!bundleRow || !bundleRow.enabled) {
    const resp: CartAddResponse = {
      success: false,
      cart_external_id: null,
      applied_discount_rate: 0,
      errors: ["bundle is not active"],
    };
    res.status(400).json(resp);
    return;
  }

  // Re-validate selection before applying
  const itemRows = await sql<BundleItemRow[]>`
    SELECT * FROM bundle_items WHERE bundle_id = ${body.bundle_id}
  `;

  const itemPoolIds = new Set(itemRows.map((i) => String(i.variant_external_id)));
  const availabilityMap = new Map<string, string>(
    itemRows.map((i) => [String(i.variant_external_id), i.observed_availability])
  );

  const validationErrors: string[] = [];

  for (const variantId of body.selected_variant_ids) {
    if (!itemPoolIds.has(String(variantId))) {
      validationErrors.push(`Variant ${variantId} is not part of this bundle`);
    }
    const avail = availabilityMap.get(String(variantId));
    if (avail === "deleted") {
      validationErrors.push(`Variant ${variantId} has been deleted`);
    } else if (avail === "out_of_stock") {
      validationErrors.push(`Variant ${variantId} is out of stock`);
    }
  }

  // Check live Shopify availability
  const shopify = await shopifyClientFor(req.platform!);
  const gids = body.selected_variant_ids.map(
    (id) => `gid://shopify/ProductVariant/${id}`
  );

  const liveData = await shopify.storefront<{
    nodes: Array<{
      id: string;
      availableForSale: boolean;
    } | null>;
  }>(
    `query CheckVariantAvailability($ids: [ID!]!) {
       nodes(ids: $ids) {
         ... on ProductVariant {
           id
           availableForSale
         }
       }
     }`,
    { ids: gids }
  );

  if (liveData.nodes) {
    for (const node of liveData.nodes) {
      if (node && !node.availableForSale) {
        const numericId = node.id.replace("gid://shopify/ProductVariant/", "");
        validationErrors.push(`Variant ${numericId} is no longer available for sale`);
      }
    }
  }

  if (validationErrors.length > 0) {
    const resp: CartAddResponse = {
      success: false,
      cart_external_id: null,
      applied_discount_rate: 0,
      errors: validationErrors,
    };
    res.status(422).json(resp);
    return;
  }

  // Find earned tier
  const tierRows = await sql<BundleTierRow[]>`
    SELECT * FROM bundle_tiers
    WHERE bundle_id = ${body.bundle_id}
    ORDER BY minimum_item_count DESC
  `;

  const selectionCount = body.selected_variant_ids.length;
  let earnedTier: BundleTierRow | null = null;
  for (const tier of tierRows) {
    if (selectionCount >= tier.minimum_item_count) {
      earnedTier = tier;
      break;
    }
  }

  if (!earnedTier) {
    const resp: CartAddResponse = {
      success: false,
      cart_external_id: null,
      applied_discount_rate: 0,
      errors: ["Selection does not meet any tier threshold"],
    };
    res.status(422).json(resp);
    return;
  }

  // Build line items for the widget to use with Ajax API
  const lineItems = body.selected_variant_ids.map((variantId, idx) => ({
    id: Number(variantId),
    quantity: body.quantities[idx] ?? 1,
    properties: {
      _bundle_id: body.bundle_id,
      _discount_rate: String(earnedTier!.discount_rate),
    },
  }));

  const resp: CartAddResponse = {
    success: true,
    cart_external_id: null,
    applied_discount_rate: earnedTier.discount_rate,
    errors: [],
  };

  res.json({ ...resp, line_items: lineItems });
});
