import { Router } from "express";
import type { Request, Response } from "express";
import { sql } from "../lib/db.js";
import { paginate } from "../lib/paginate.js";
import { shopifyClientFor } from "../lib/shopify.js";

export const widgetRouter = Router();

// GET /bundle — bundle config, ordered tiers, and paginated items for storefront widget
widgetRouter.get("/bundle", async (req: Request, res: Response) => {
  const bundleId: string = req.query?.bundle_id as string;
  const page = req.query?.page as unknown as number;
  const pageSize = req.query?.page_size as unknown as number;

  // Load the bundle record (only enabled bundles)
  const bundleRow = await sql<{ id: string; title: string; description: string | null; mode: string; enabled: boolean; health_status: string }[]>`SELECT id, title, description, mode, enabled, health_status FROM bundles WHERE id = ${bundleId} AND enabled = true`;

  // Return 404 if bundle is not found or disabled
  if (bundleRow.length === 0) {
    res.status(404).json({ error: "bundle not found or not enabled" });
    return;
  }

  // Load all tiers for the bundle ordered by display_order ascending
  const tierRows = await sql<{ id: string; minimum_item_count: number; discount_rate: number; display_order: number }[]>`SELECT id, minimum_item_count, discount_rate, display_order FROM bundle_tiers WHERE bundle_id = ${bundleId} ORDER BY display_order ASC`;

  // Select items for the bundle with pagination
  const itemRows = await paginate(
    sql,
    sql`SELECT id, variant_external_id, product_external_id, observed_availability FROM bundle_items WHERE bundle_id = ${bundleId} ORDER BY added_at ASC`,
    { page, page_size: pageSize },
  );

  res.status(200).json({
    bundle: bundleRow[0]!,
    tiers: tierRows,
    items: itemRows.items,
    total: itemRows.total,
    page: itemRows.page,
    page_size: itemRows.page_size,
  });
  return;
});

// POST /bundle/validate — validate customer variant selection and return earned discount tier
widgetRouter.post("/bundle/validate", async (req: Request, res: Response) => {
  const bundleId: string = req.body?.bundle_id;
  const selectedVariantIds: string[] = req.body?.selected_variant_ids;

  // Load bundle config and item pool for validation
  const bundleRow = await sql<{ id: string; mode: string; enabled: boolean }[]>`SELECT id, mode, enabled FROM bundles WHERE id = ${bundleId} AND enabled = true`;

  // Reject if bundle is not found or disabled
  if (bundleRow.length === 0) {
    res.status(404).json({ error: "bundle not found or not enabled" });
    return;
  }

  // Load item pool for this bundle
  const itemPool = await sql<{ variant_external_id: bigint; observed_availability: string }[]>`SELECT variant_external_id, observed_availability FROM bundle_items WHERE bundle_id = ${bundleId}`;

  // Load tiers ordered by minimum_item_count descending to determine earned tier
  const tierRows = await sql<{ id: string; minimum_item_count: number; discount_rate: number }[]>`SELECT id, minimum_item_count, discount_rate FROM bundle_tiers WHERE bundle_id = ${bundleId} ORDER BY minimum_item_count DESC`;

  // Extract numeric variant IDs from item pool (as strings for comparison)
  const poolVariantIdStrings = itemPool.map((i: any) => String(i.variant_external_id));

  // Check that all selected variant IDs are in the bundle item pool
  const outOfPoolIds = selectedVariantIds.filter((vid: string) => !poolVariantIdStrings.includes(vid));

  // Build Shopify GIDs for the selected variants to query live availability
  const variantGids = selectedVariantIds.map((vid: string) => `gid://shopify/ProductVariant/${vid}`);

  // Fetch live availability for selected variants from Storefront API
  const shopify = await shopifyClientFor(req.platform!);
  const liveVariantNodes = await shopify.storefront<{
    nodes: ({ id: string; availableForSale: boolean; quantityAvailable: number } | null)[];
  }>(
    `query GetVariantAvailability($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id availableForSale quantityAvailable } } }`,
    { ids: variantGids },
  );

  // Build a map of variantId string -> availableForSale from Storefront response
  const availabilityMap = Object.fromEntries(
    (liveVariantNodes?.nodes ?? []).filter((n: any) => n).map((n: any) => [n.id.split("/").pop(), n.availableForSale]),
  );

  // Find selected variants that are not available for sale according to Storefront
  const unavailableSelectedIds = selectedVariantIds.filter((vid: string) => availabilityMap[vid] === false);

  // Assemble all validation errors
  const validationErrors = [
    ...outOfPoolIds.map((vid: string) => `variant ${vid} is not part of this bundle`),
    ...unavailableSelectedIds.map((vid: string) => `variant ${vid} is currently out of stock`),
  ];

  // Determine if selection is valid: no errors and meets minimum tier threshold
  const isValid =
    validationErrors.length === 0 &&
    tierRows.length > 0 &&
    selectedVariantIds.length >= tierRows[tierRows.length - 1]!.minimum_item_count;

  // Find the earned tier: highest tier whose minimum_item_count <= selected count
  const earnedTier = isValid ? (tierRows.find((t: any) => selectedVariantIds.length >= t.minimum_item_count) ?? null) : null;

  res.status(200).json({
    valid: isValid,
    earned_tier: earnedTier,
    discount_rate: earnedTier?.discount_rate ?? null,
    validation_errors: validationErrors,
  });
  return;
});

// POST /cart/add — add validated bundle selection to cart with discount applied
widgetRouter.post("/cart/add", async (req: Request, res: Response) => {
  const bundleId: string = req.body?.bundle_id;
  const selectedVariantIds: string[] = req.body?.selected_variant_ids;
  const quantities: number[] = req.body?.quantities;

  // Load bundle and its item pool and tiers for server-side validation
  const bundleRow = await sql<{ id: string; mode: string; enabled: boolean }[]>`SELECT id, mode, enabled FROM bundles WHERE id = ${bundleId} AND enabled = true`;

  // Reject if bundle is not enabled
  if (bundleRow.length === 0) {
    res.status(404).json({
      success: false,
      cart_external_id: null,
      applied_discount_rate: null,
      errors: ["bundle not found or not enabled"],
    });
    return;
  }

  // Load item pool
  const itemPool = await sql<{ variant_external_id: bigint }[]>`SELECT variant_external_id FROM bundle_items WHERE bundle_id = ${bundleId}`;

  // Load tiers ordered by minimum_item_count descending
  const tierRows = await sql<{ id: string; minimum_item_count: number; discount_rate: number }[]>`SELECT id, minimum_item_count, discount_rate FROM bundle_tiers WHERE bundle_id = ${bundleId} ORDER BY minimum_item_count DESC`;

  // Check pool membership of all selected variants
  const outOfPoolIds = selectedVariantIds.filter((vid: string) => !itemPool.some((i: any) => String(i.variant_external_id) === vid));

  // Build GIDs for Storefront live availability check
  const variantGids = selectedVariantIds.map((vid: string) => `gid://shopify/ProductVariant/${vid}`);

  // Fetch live availability for all selected variants
  const shopify = await shopifyClientFor(req.platform!);
  const liveNodes = await shopify.storefront<{
    nodes: ({ id: string; availableForSale: boolean } | null)[];
  }>(
    `query GetVariantAvailability($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id availableForSale } } }`,
    { ids: variantGids },
  );

  // Build availability map from Storefront response
  const availabilityMap = Object.fromEntries(
    (liveNodes?.nodes ?? []).filter((n: any) => n).map((n: any) => [n.id.split("/").pop(), n.availableForSale]),
  );

  // Find selected variants not available for sale
  const unavailableIds = selectedVariantIds.filter((vid: string) => availabilityMap[vid] === false);

  // Assemble all validation errors
  const cartValidationErrors = [
    ...outOfPoolIds.map((vid: string) => `variant ${vid} not in bundle`),
    ...unavailableIds.map((vid: string) => `variant ${vid} is out of stock`),
  ];

  // Return 422 if validation fails
  if (cartValidationErrors.length > 0 || selectedVariantIds.length === 0) {
    res.status(422).json({
      success: false,
      cart_external_id: null,
      applied_discount_rate: null,
      errors: cartValidationErrors,
    });
    return;
  }

  // Determine earned tier from selection count
  const earnedTier = tierRows.find((t: any) => selectedVariantIds.length >= t.minimum_item_count) ?? null;

  // Reject if selection count does not meet the minimum tier threshold
  if (earnedTier === null) {
    res.status(422).json({
      success: false,
      cart_external_id: null,
      applied_discount_rate: null,
      errors: ["selection does not meet minimum bundle tier threshold"],
    });
    return;
  }

  // Build discount code string from earned tier discount rate in basis points
  const discountCode = `BUNDLE-${bundleId.slice(0, 8).toUpperCase()}-${earnedTier.discount_rate}`;

  // Build cart line items array mapping selectedVariantIds and quantities to Storefront line format with GIDs
  const cartLines = selectedVariantIds.map((vid: string, i: number) => ({
    merchandiseId: `gid://shopify/ProductVariant/${vid}`,
    quantity: quantities[i] ?? 1,
  }));

  // Construct the full CartInput object combining lines and discount code
  const cartInput = { lines: cartLines, discountCodes: [discountCode] };

  // Create the Shopify cart with selected variants and earned discount code applied
  const cartCreateResult = await shopify.storefront<{
    cartCreate: {
      cart: { id: string; checkoutUrl: string } | null;
      userErrors: { field: string[]; message: string }[];
    };
  }>(
    `mutation CartCreate($input: CartInput!) { cartCreate(input: $input) { cart { id checkoutUrl } userErrors { field message } } }`,
    { input: cartInput },
  );

  if (cartCreateResult?.cartCreate?.userErrors?.length > 0) {
    throw new Error(
      `cartCreate userErrors: ${cartCreateResult.cartCreate.userErrors.map((e: any) => e.message).join("; ")}`,
    );
  }

  // Extract the cart external ID from the GID
  const cartExternalId = cartCreateResult.cartCreate.cart!.id.split("/").pop()!;

  res.status(200).json({
    success: true,
    cart_external_id: cartExternalId,
    applied_discount_rate: earnedTier.discount_rate,
    errors: [],
  });
  return;
});