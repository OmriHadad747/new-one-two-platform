import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import { paginate } from "../lib/paginate.js";
import { shopifyClientFor } from "../lib/shopify.js";

const widgetRouter = Router();

// GET /bundle — initial render
widgetRouter.get("/bundle", async (req: Request, res: Response): Promise<void> => {
  const bundleId = req.query?.bundle_id as string;
  const page = req.query?.page;
  const pageSize = req.query?.page_size;

  // Step: Fetch bundle header row (must be enabled)
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

  // Step: Return 404 if bundle not found or disabled
  if (bundleRow.length === 0) {
    res.status(404).json({ error: "bundle not found or not active" });
    return;
  }

  // Step: Fetch all tiers ordered by display_order (bounded inline)
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

  // Step: Select paginated bundle items
  const rows = await paginate(
    sql,
    sql`
      SELECT id, variant_external_id, product_external_id, observed_availability
      FROM bundle_items
      WHERE bundle_id = ${bundleId}
      ORDER BY added_at ASC
    `,
    { page: Number(page), page_size: Number(pageSize) },
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

// POST /bundle/validate
widgetRouter.post("/bundle/validate", async (req: Request, res: Response): Promise<void> => {
  const bundleId = req.body?.bundle_id;
  const selectedVariantIds: string[] = req.body?.selected_variant_ids ?? [];

  // Step: Fetch bundle row — must be enabled
  const bundleRow = await sql<
    { id: string; mode: string; enabled: boolean; health_status: string }[]
  >`
    SELECT id, mode, enabled, health_status
    FROM bundles
    WHERE id = ${bundleId} AND enabled = true
  `;

  // Step: Return invalid if bundle not active
  if (bundleRow.length === 0) {
    res.status(200).json({
      valid: false,
      earned_tier: null,
      discount_rate: null,
      validation_errors: ["Bundle is not active"],
    });
    return;
  }

  // Step: Fetch bundle item pool
  const itemPool = await sql<
    { variant_external_id: string; observed_availability: string }[]
  >`
    SELECT variant_external_id, observed_availability
    FROM bundle_items
    WHERE bundle_id = ${bundleId}
  `;

  // Step: Fetch all tiers ordered by minimum_item_count descending
  const tiers = await sql<
    { id: string; minimum_item_count: number; discount_rate: number }[]
  >`
    SELECT id, minimum_item_count, discount_rate
    FROM bundle_tiers
    WHERE bundle_id = ${bundleId}
    ORDER BY minimum_item_count DESC
  `;

  // Step: Check all selected variants belong to bundle's item pool
  const unknownVariants = selectedVariantIds.filter(
    (vid) =>
      !itemPool.some(
        (item) => String(item.variant_external_id) === String(vid),
      ),
  );

  // Step: Return invalid if unknown variants
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

  // Step: Build GIDs for Storefront API availability query
  const selectedVariantGids = selectedVariantIds.map(
    (vid) => `gid://shopify/ProductVariant/${vid}`,
  );

  // Step: Fetch live availability for selected variants from Storefront API
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

  // Step: Build availability map from Storefront response
  const availabilityMap = new Map(
    (liveNodes?.nodes ?? [])
      .filter((n): n is NonNullable<typeof n> => n !== null && !!n.id)
      .map((n) => [String(n.id.split("/").pop()), n.availableForSale]),
  );

  // Step: Identify out-of-stock variants in selection
  const unavailableSelected = selectedVariantIds.filter(
    (vid) => availabilityMap.get(String(vid)) === false,
  );

  // Step: Return invalid if any selected variant is out of stock
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

  // Step: Determine highest earned discount tier
  const earnedTier =
    tiers.find((t) => selectedVariantIds.length >= t.minimum_item_count) ??
    null;

  // Step: Return invalid if no tier earned
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

  res.status(200).json({
    valid: true,
    earned_tier: earnedTier,
    discount_rate: earnedTier.discount_rate,
    validation_errors: [],
  });
  return;
});

// POST /cart/add
widgetRouter.post("/cart/add", async (req: Request, res: Response): Promise<void> => {
  const bundleId = req.body?.bundle_id;
  const selectedVariantIds: string[] = req.body?.selected_variant_ids ?? [];
  const quantities: number[] = req.body?.quantities ?? [];

  // Step: Fetch bundle — must be enabled
  const bundleRow = await sql<
    { id: string; mode: string; enabled: boolean; health_status: string }[]
  >`
    SELECT id, mode, enabled, health_status
    FROM bundles
    WHERE id = ${bundleId} AND enabled = true
  `;

  // Step: Return error if bundle not active
  if (bundleRow.length === 0) {
    res.status(400).json({
      success: false,
      cart_external_id: null,
      applied_discount_rate: null,
      errors: ["Bundle is not active"],
    });
    return;
  }

  // Step: Fetch bundle item pool
  const itemPool = await sql<
    { variant_external_id: string; observed_availability: string }[]
  >`
    SELECT variant_external_id, observed_availability
    FROM bundle_items
    WHERE bundle_id = ${bundleId}
  `;

  // Step: Fetch tiers ordered by minimum_item_count descending
  const tiers = await sql<
    { id: string; minimum_item_count: number; discount_rate: number }[]
  >`
    SELECT id, minimum_item_count, discount_rate
    FROM bundle_tiers
    WHERE bundle_id = ${bundleId}
    ORDER BY minimum_item_count DESC
  `;

  // Step: Validate selected variants belong to bundle pool
  const unknownVariants = selectedVariantIds.filter(
    (vid) =>
      !itemPool.some(
        (item) => String(item.variant_external_id) === String(vid),
      ),
  );

  if (unknownVariants.length > 0) {
    res.status(400).json({
      success: false,
      cart_external_id: null,
      applied_discount_rate: null,
      errors: unknownVariants.map((v) => `Variant ${v} is not in this bundle`),
    });
    return;
  }

  // Step: Build GIDs for Storefront live availability check
  const selectedVariantGids = selectedVariantIds.map(
    (vid) => `gid://shopify/ProductVariant/${vid}`,
  );

  // Step: Live availability check via Storefront API
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

  // Step: Build availability map
  const availabilityMap = new Map(
    (liveNodes?.nodes ?? [])
      .filter((n): n is NonNullable<typeof n> => n !== null && !!n.id)
      .map((n) => [String(n.id.split("/").pop()), n.availableForSale]),
  );

  // Step: Find out-of-stock variants
  const unavailableVariants = selectedVariantIds.filter(
    (vid) => availabilityMap.get(String(vid)) === false,
  );

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

  // Step: Determine highest earned tier
  const earnedTier =
    tiers.find((t) => selectedVariantIds.length >= t.minimum_item_count) ??
    null;

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

  // Step: Build CartInput object
  const cartInput = {
    lines: selectedVariantIds.map((vid, i) => ({
      merchandiseId: `gid://shopify/ProductVariant/${vid}`,
      quantity: quantities[i] ?? 1,
    })),
  };

  // Step: Build discount code string
  const discountCode = `BUNDLE_${bundleId}_${earnedTier.discount_rate}`;

  // Step: Create Shopify cart and apply discount code via Storefront API
  try {
    // Step: Create cart via Storefront API
    const createdCart = await shopify.storefront<{
      cartCreate: {
        cart: { id: string; checkoutUrl: string } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      `mutation CartCreate($input: CartInput!) {
         cartCreate(input: $input) {
           cart { id checkoutUrl }
           userErrors { field message }
         }
       }`,
      { input: cartInput },
    );

    if (createdCart.cartCreate.userErrors.length > 0) {
      throw new Error(
        `cartCreate failed: ${createdCart.cartCreate.userErrors.map((e) => e.message).join("; ")}`,
      );
    }

    // Step: Apply discount code to cart via Storefront API
    const updatedCart = await shopify.storefront<{
      cartDiscountCodesUpdate: {
        cart: { id: string; discountCodes: { code: string }[] } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      `mutation CartDiscountCodesUpdate($cartId: ID!, $discountCodes: [String!]!) {
         cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) {
           cart { id discountCodes { code } }
           userErrors { field message }
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

    // Step: Extract raw cart id from GID
    const cartExternalId = createdCart?.cartCreate?.cart?.id
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

export { widgetRouter };