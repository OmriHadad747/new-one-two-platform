import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import { paginate } from "../lib/paginate.js";
import { shopifyClientFor } from "../lib/shopify.js";

export const widgetRouter = Router();

// GET /bundle — bundle configuration, ordered tiers, and paginated items
widgetRouter.get("/bundle", async (req: Request, res: Response): Promise<void> => {
  const bundleId = req.query?.bundle_id as string;
  const page = req.query?.page;
  const pageSize = req.query?.page_size;

  // Fetch bundle header row — must be enabled
  const bundleRow = await sql<
    {
      id: string;
      title: string;
      description: string | null;
      mode: string;
      enabled: boolean;
      health_status: string;
    }[]
  >`
    SELECT id, title, description, mode, enabled, health_status
    FROM bundles
    WHERE id = ${bundleId} AND enabled = true
  `;

  // Return 404 if bundle not found or disabled
  if (bundleRow.length === 0) {
    res.status(404).json({ error: "bundle not found or not active" });
    return;
  }

  // Fetch all tiers ordered by display_order ascending (bounded inline list)
  const tiers = await sql<
    {
      id: string;
      minimum_item_count: number;
      discount_rate: number;
      display_order: number;
    }[]
  >`
    SELECT id, minimum_item_count, discount_rate, display_order
    FROM bundle_tiers
    WHERE bundle_id = ${bundleId}
    ORDER BY display_order ASC
    LIMIT 50
  `;

  // Select paginated bundle items with observed availability
  const rows = await paginate(
    sql,
    sql`
      SELECT id, variant_external_id, product_external_id, observed_availability
      FROM bundle_items
      WHERE bundle_id = ${bundleId}
      ORDER BY added_at ASC
    `,
    { page: page as any, page_size: pageSize as any },
  );

  res.status(200).json({
    bundle: bundleRow[0]!,
    tiers,
    items: rows.items,
    total: rows.total,
    page: rows.page,
    page_size: rows.page_size,
  });
  return;
});

// POST /bundle/validate — validate customer's variant selection
widgetRouter.post("/bundle/validate", async (req: Request, res: Response): Promise<void> => {
  const bundleId = req.body?.bundle_id;
  const selectedVariantIds: string[] = req.body?.selected_variant_ids ?? [];

  // Fetch bundle row — must be enabled
  const bundleRow = await sql<
    { id: string; mode: string; enabled: boolean; health_status: string }[]
  >`
    SELECT id, mode, enabled, health_status FROM bundles WHERE id = ${bundleId} AND enabled = true
  `;

  // Return invalid if bundle not active
  if (bundleRow.length === 0) {
    res.status(200).json({
      valid: false,
      earned_tier: null,
      discount_rate: null,
      validation_errors: ["Bundle is not active"],
    });
    return;
  }

  // Fetch bundle item pool
  const itemPool = await sql<
    { variant_external_id: string; observed_availability: string | null }[]
  >`
    SELECT variant_external_id, observed_availability FROM bundle_items WHERE bundle_id = ${bundleId}
  `;

  // Fetch all tiers ordered by minimum_item_count descending to find highest earned tier
  const tiers = await sql<
    { id: string; minimum_item_count: number; discount_rate: number }[]
  >`
    SELECT id, minimum_item_count, discount_rate FROM bundle_tiers WHERE bundle_id = ${bundleId} ORDER BY minimum_item_count DESC
  `;

  // Check all selected variants belong to the bundle's item pool
  const unknownVariants = selectedVariantIds.filter(
    (vid) =>
      !itemPool.some(
        (item) => String(item.variant_external_id) === String(vid),
      ),
  );

  // Return invalid if any selected variant is not in the bundle pool
  if (unknownVariants.length > 0) {
    res.status(200).json({
      valid: false,
      earned_tier: null,
      discount_rate: null,
      validation_errors: unknownVariants.map(
        (v) => `Variant ${v} is not in this bundle`,
      ),
    });
    return;
  }

  // Build GIDs for the selected variants for Storefront API availability query
  const selectedVariantGids = selectedVariantIds.map(
    (vid) => `gid://shopify/ProductVariant/${vid}`,
  );

  // Fetch live availability for selected variants from Storefront API
  const shopify = await shopifyClientFor(req.platform!);

  const liveNodes = await shopify.storefront<{
    nodes: Array<{
      id: string;
      availableForSale: boolean;
      quantityAvailable: number;
    } | null>;
  }>(
    `query GetVariantAvailability($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          availableForSale
          quantityAvailable
        }
      }
    }`,
    { ids: selectedVariantGids },
  );

  // Build a map of variantId -> availableForSale from Storefront response
  const availabilityMap = new Map(
    (liveNodes?.nodes ?? [])
      .filter((n) => n && n.id)
      .map((n) => [String(n!.id.split("/").pop()), n!.availableForSale]),
  );

  // Identify selected variants that are out of stock according to live Shopify data
  const unavailableSelected = selectedVariantIds.filter(
    (vid) => availabilityMap.get(String(vid)) === false,
  );

  // Return invalid if any selected variant is out of stock live
  if (unavailableSelected.length > 0) {
    res.status(200).json({
      valid: false,
      earned_tier: null,
      discount_rate: null,
      validation_errors: unavailableSelected.map(
        (v) => `Variant ${v} is currently out of stock`,
      ),
    });
    return;
  }

  // Determine the highest earned discount tier based on selection count
  const earnedTier =
    tiers.find((t) => selectedVariantIds.length >= t.minimum_item_count) ??
    null;

  // Return invalid if no tier is earned
  if (earnedTier === null) {
    res.status(200).json({
      valid: false,
      earned_tier: null,
      discount_rate: null,
      validation_errors: [
        "Selection does not meet the minimum item count for any discount tier",
      ],
    });
    return;
  }

  // Return successful validation with earned tier
  res.status(200).json({
    valid: true,
    earned_tier: earnedTier,
    discount_rate: earnedTier.discount_rate,
    validation_errors: [],
  });
  return;
});

// POST /cart/add — add validated bundle selection to Shopify cart with discount
widgetRouter.post("/cart/add", async (req: Request, res: Response): Promise<void> => {
  const bundleId = req.body?.bundle_id;
  const selectedVariantIds: string[] = req.body?.selected_variant_ids ?? [];
  const quantities: number[] = req.body?.quantities ?? [];

  // Fetch bundle — must be enabled
  const bundleRow = await sql<
    { id: string; mode: string; enabled: boolean; health_status: string }[]
  >`
    SELECT id, mode, enabled, health_status FROM bundles WHERE id = ${bundleId} AND enabled = true
  `;

  // Return error if bundle is not active
  if (bundleRow.length === 0) {
    res.status(400).json({
      success: false,
      cart_external_id: null,
      applied_discount_rate: null,
      errors: ["Bundle is not active"],
    });
    return;
  }

  // Fetch bundle item pool
  const itemPool = await sql<
    { variant_external_id: string; observed_availability: string | null }[]
  >`
    SELECT variant_external_id, observed_availability FROM bundle_items WHERE bundle_id = ${bundleId}
  `;

  // Fetch tiers ordered by minimum_item_count descending
  const tiers = await sql<
    { id: string; minimum_item_count: number; discount_rate: number }[]
  >`
    SELECT id, minimum_item_count, discount_rate FROM bundle_tiers WHERE bundle_id = ${bundleId} ORDER BY minimum_item_count DESC
  `;

  // Validate selected variants belong to bundle pool
  const unknownVariants = selectedVariantIds.filter(
    (vid) =>
      !itemPool.some(
        (item) => String(item.variant_external_id) === String(vid),
      ),
  );

  // Return error if selection contains variants not in bundle
  if (unknownVariants.length > 0) {
    res.status(400).json({
      success: false,
      cart_external_id: null,
      applied_discount_rate: null,
      errors: unknownVariants.map((v) => `Variant ${v} is not in this bundle`),
    });
    return;
  }

  // Build GIDs for Storefront live availability check
  const selectedVariantGids = selectedVariantIds.map(
    (vid) => `gid://shopify/ProductVariant/${vid}`,
  );

  // Live availability check for selected variants via Storefront API
  const shopify = await shopifyClientFor(req.platform!);

  const liveNodes = await shopify.storefront<{
    nodes: Array<{ id: string; availableForSale: boolean } | null>;
  }>(
    `query GetVariantAvailability($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          availableForSale
        }
      }
    }`,
    { ids: selectedVariantGids },
  );

  // Build availability map from Storefront response
  const availabilityMap = new Map(
    (liveNodes?.nodes ?? [])
      .filter((n) => n && n.id)
      .map((n) => [String(n!.id.split("/").pop()), n!.availableForSale]),
  );

  // Find out-of-stock variants in the selection
  const unavailableVariants = selectedVariantIds.filter(
    (vid) => availabilityMap.get(String(vid)) === false,
  );

  // Return error if any selected variant is out of stock
  if (unavailableVariants.length > 0) {
    res.status(400).json({
      success: false,
      cart_external_id: null,
      applied_discount_rate: null,
      errors: unavailableVariants.map(
        (v) => `Variant ${v} is currently out of stock`,
      ),
    });
    return;
  }

  // Determine highest earned tier
  const earnedTier =
    tiers.find((t) => selectedVariantIds.length >= t.minimum_item_count) ??
    null;

  // Return error if selection does not meet any tier threshold
  if (earnedTier === null) {
    res.status(400).json({
      success: false,
      cart_external_id: null,
      applied_discount_rate: null,
      errors: [
        "Selection does not meet the minimum item count for any discount tier",
      ],
    });
    return;
  }

  // Build the CartInput object with lines array
  const cartInput = {
    lines: selectedVariantIds.map((vid, i) => ({
      merchandiseId: `gid://shopify/ProductVariant/${vid}`,
      quantity: quantities[i] ?? 1,
    })),
  };

  // Build the discount code string encoding bundleId and earned discount rate
  const discountCode = `BUNDLE_${bundleId}_${earnedTier.discount_rate}`;

  // Create Shopify cart and apply discount code; return errors on failure
  try {
    // Create a new Shopify cart with the selected bundle lines via Storefront API
    const createdCart = await shopify.storefront<{
      cartCreate: {
        cart: { id: string; checkoutUrl: string } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      `mutation CartCreate($input: CartInput!) {
        cartCreate(input: $input) {
          cart {
            id
            checkoutUrl
          }
          userErrors {
            field
            message
          }
        }
      }`,
      { input: cartInput },
    );

    if (createdCart.cartCreate.userErrors.length > 0) {
      throw new Error(
        `cartCreate failed: ${createdCart.cartCreate.userErrors.map((e) => e.message).join("; ")}`,
      );
    }

    // Apply the bundle discount code to the newly created cart via Storefront API
    const updatedCart = await shopify.storefront<{
      cartDiscountCodesUpdate: {
        cart: {
          id: string;
          discountCodes: { code: string }[];
        } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      `mutation CartDiscountCodesUpdate($cartId: ID!, $discountCodes: [String!]!) {
        cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) {
          cart {
            id
            discountCodes {
              code
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        cartId: createdCart.cartCreate.cart!.id,
        discountCodes: [discountCode],
      },
    );

    if (updatedCart.cartDiscountCodesUpdate.userErrors.length > 0) {
      throw new Error(
        `cartDiscountCodesUpdate failed: ${updatedCart.cartDiscountCodesUpdate.userErrors.map((e) => e.message).join("; ")}`,
      );
    }

    // Extract raw cart id from GID
    const cartExternalId =
      createdCart?.cartCreate?.cart?.id
        ? String(createdCart.cartCreate.cart.id.split("/").pop())
        : null;

    res.status(200).json({
      success: true,
      cart_external_id: cartExternalId,
      applied_discount_rate: earnedTier.discount_rate,
      errors: [],
    });
    return;
  } catch (cartError: any) {
    console.error(
      {
        requestId: req.platform!.requestId,
        bundle_id: bundleId,
        error: cartError.message,
      },
      "cart-add: Shopify cart operation failed",
    );

    res.status(500).json({
      success: false,
      cart_external_id: null,
      applied_discount_rate: null,
      errors: [cartError.message],
    });
    return;
  }
});