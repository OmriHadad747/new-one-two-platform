import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import { money } from "../lib/money.js";
import { paginate } from "../lib/paginate.js";
import type {
  BundleId,
  BundleItemId,
  BundleRow,
  BundleItemRow,
  AdminListBundlesResponse,
  AdminBundleSummary,
  AdminCreateBundleRequest,
  AdminCreateBundleResponse,
  AdminUpdateBundleRequest,
  AdminUpdateBundleResponse,
  AdminDeleteBundleRequest,
  AdminDeleteBundleResponse,
  AdminProductSearchResponse,
  AdminProductShape,
  AdminProductVariantShape,
  DiscountTierInput,
  BundleItemInput,
  DiscountCodeBasicCreateResponse,
  DiscountCodeBxgyCreateResponse,
  DiscountCodeBasicUpdateResponse,
  DiscountCodeBxgyUpdateResponse,
  DiscountCodeDeleteResponse,
  ShopifyProductsQueryResponse,
  VariantMerchandiseGid,
} from "../types/contracts.js";

export const adminRouter = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateDiscountCode(bundleName: string): string {
  const safe = bundleName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `BUNDLE-${safe}-${rand}`;
}

/** Build the best-matching tier description for a Shopify discount title */
function bundleDiscountTitle(name: string): string {
  return `Bundle: ${name}`.replace(/\u0000/g, "");
}

/**
 * Create or update a Shopify discount code for percentage / flat bundle.
 * Returns { nodeId, codeString }.
 */
async function provisionBasicDiscount(
  shopify: Awaited<ReturnType<typeof shopifyClientFor>>,
  code: string,
  title: string,
  tiers: DiscountTierInput[],
  discountType: "percentage" | "flat"
): Promise<{ nodeId: string; codeString: string }> {
  // Use the highest-value tier as the Shopify code value (widget will show live price).
  // Best-match logic lives in widget/backend; here we provision the code that
  // stores the discount mechanism.
  const sortedTiers = [...tiers].sort((a, b) => b.min_item_count - a.min_item_count);
  const topTier = sortedTiers[0];
  if (!topTier) throw new Error("At least one discount tier is required");

  let customerGetsValue: Record<string, unknown>;
  if (discountType === "percentage") {
    const ratio = parseFloat(topTier.discount_ratio ?? "0");
    customerGetsValue = { percentage: ratio };
  } else {
    // flat — amount is already in minor units (cents). Shopify takes decimal string in major units.
    const amountMinor = topTier.discount_amount ?? 0;
    // Use money.format to convert minor units to a decimal string (e.g. "20.00").
    // We use USD as a safe default for formatting since Shopify processes in shop currency.
    const amountMajor = money.format(amountMinor, "USD");
    customerGetsValue = {
      discountAmount: { amount: amountMajor, appliesOnEachItem: false },
    };
  }

  const result = await shopify.graphql<DiscountCodeBasicCreateResponse>(
    `mutation CreateBundleDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
       discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
         codeDiscountNode {
           id
           codeDiscount {
             ... on DiscountCodeBasic {
               codes(first: 1) { nodes { code } }
             }
           }
         }
         userErrors { field message }
       }
     }`,
    {
      basicCodeDiscount: {
        title,
        code,
        startsAt: new Date().toISOString(),
        appliesOncePerCustomer: false,
        customerGets: {
          items: { all: true },
          value: customerGetsValue,
        },
        customerSelection: { all: true },
      },
    }
  );
  if (result.discountCodeBasicCreate.userErrors.length > 0) {
    throw new Error(
      result.discountCodeBasicCreate.userErrors.map((e) => e.message).join("; ")
    );
  }
  const node = result.discountCodeBasicCreate.codeDiscountNode;
  if (!node) throw new Error("discountCodeBasicCreate returned no node");
  const returnedCode =
    (node.codeDiscount as { codes?: { nodes: Array<{ code: string }> } }).codes
      ?.nodes[0]?.code ?? code;
  return { nodeId: node.id, codeString: returnedCode };
}

async function provisionBxgyDiscount(
  shopify: Awaited<ReturnType<typeof shopifyClientFor>>,
  code: string,
  title: string,
  tiers: DiscountTierInput[]
): Promise<{ nodeId: string; codeString: string }> {
  const sortedTiers = [...tiers].sort((a, b) => a.min_item_count - b.min_item_count);
  const topTier = sortedTiers[sortedTiers.length - 1];
  if (!topTier) throw new Error("At least one discount tier is required");

  const buyQty = topTier.min_item_count > 1 ? topTier.min_item_count - 1 : 1;

  const result = await shopify.graphql<DiscountCodeBxgyCreateResponse>(
    `mutation CreateBxgyDiscount($bxgyCodeDiscount: DiscountCodeBxgyInput!) {
       discountCodeBxgyCreate(bxgyCodeDiscount: $bxgyCodeDiscount) {
         codeDiscountNode {
           id
           codeDiscount {
             ... on DiscountCodeBxgy {
               codes(first: 1) { nodes { code } }
             }
           }
         }
         userErrors { field message }
       }
     }`,
    {
      bxgyCodeDiscount: {
        title,
        code,
        startsAt: new Date().toISOString(),
        appliesOncePerCustomer: false,
        customerBuys: {
          value: { quantity: String(buyQty) },
          items: { all: true },
        },
        customerGets: {
          value: {
            discountOnQuantity: {
              quantity: "1",
              effect: { percentage: 1.0 },
            },
          },
          items: { all: true },
        },
        customerSelection: { all: true },
      },
    }
  );
  if (result.discountCodeBxgyCreate.userErrors.length > 0) {
    throw new Error(
      result.discountCodeBxgyCreate.userErrors.map((e) => e.message).join("; ")
    );
  }
  const node = result.discountCodeBxgyCreate.codeDiscountNode;
  if (!node) throw new Error("discountCodeBxgyCreate returned no node");
  const returnedCode =
    (node.codeDiscount as { codes?: { nodes: Array<{ code: string }> } }).codes
      ?.nodes[0]?.code ?? code;
  return { nodeId: node.id, codeString: returnedCode };
}

async function updateBasicDiscount(
  shopify: Awaited<ReturnType<typeof shopifyClientFor>>,
  nodeId: string,
  title: string,
  tiers: DiscountTierInput[],
  discountType: "percentage" | "flat"
): Promise<void> {
  const sortedTiers = [...tiers].sort((a, b) => b.min_item_count - a.min_item_count);
  const topTier = sortedTiers[0];
  if (!topTier) throw new Error("At least one discount tier is required");

  let customerGetsValue: Record<string, unknown>;
  if (discountType === "percentage") {
    const ratio = parseFloat(topTier.discount_ratio ?? "0");
    customerGetsValue = { percentage: ratio };
  } else {
    const amountMinor = topTier.discount_amount ?? 0;
    const amountMajor = money.format(amountMinor, "USD");
    customerGetsValue = {
      discountAmount: { amount: amountMajor, appliesOnEachItem: false },
    };
  }

  const result = await shopify.graphql<DiscountCodeBasicUpdateResponse>(
    `mutation UpdateBundleDiscount($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
       discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
         codeDiscountNode { id }
         userErrors { field message }
       }
     }`,
    {
      id: nodeId,
      basicCodeDiscount: {
        title,
        customerGets: {
          items: { all: true },
          value: customerGetsValue,
        },
      },
    }
  );
  if (result.discountCodeBasicUpdate.userErrors.length > 0) {
    throw new Error(
      result.discountCodeBasicUpdate.userErrors.map((e) => e.message).join("; ")
    );
  }
}

async function updateBxgyDiscount(
  shopify: Awaited<ReturnType<typeof shopifyClientFor>>,
  nodeId: string,
  title: string,
  tiers: DiscountTierInput[]
): Promise<void> {
  const sortedTiers = [...tiers].sort((a, b) => a.min_item_count - b.min_item_count);
  const topTier = sortedTiers[sortedTiers.length - 1];
  if (!topTier) throw new Error("At least one discount tier is required");

  const buyQty = topTier.min_item_count > 1 ? topTier.min_item_count - 1 : 1;

  const result = await shopify.graphql<DiscountCodeBxgyUpdateResponse>(
    `mutation UpdateBxgyDiscount($id: ID!, $bxgyCodeDiscount: DiscountCodeBxgyInput!) {
       discountCodeBxgyUpdate(id: $id, bxgyCodeDiscount: $bxgyCodeDiscount) {
         codeDiscountNode { id }
         userErrors { field message }
       }
     }`,
    {
      id: nodeId,
      bxgyCodeDiscount: {
        title,
        customerBuys: {
          value: { quantity: String(buyQty) },
          items: { all: true },
        },
        customerGets: {
          value: {
            discountOnQuantity: {
              quantity: "1",
              effect: { percentage: 1.0 },
            },
          },
          items: { all: true },
        },
      },
    }
  );
  if (result.discountCodeBxgyUpdate.userErrors.length > 0) {
    throw new Error(
      result.discountCodeBxgyUpdate.userErrors.map((e) => e.message).join("; ")
    );
  }
}

// ─── GET /admin/bundles ────────────────────────────────────────────────────────
adminRouter.get("/admin/bundles", async (req: Request, res: Response) => {
  const pageNum =
    typeof req.query.page === "string" ? parseInt(req.query.page, 10) : 1;
  const pageSizeNum =
    typeof req.query.page_size === "string"
      ? parseInt(req.query.page_size, 10)
      : 20;

  const result = await paginate(
    sql,
    sql`
      SELECT id, name, bundle_type, enabled, required_item_count,
             discount_type, shopify_discount_external_id, discount_code_string,
             purchase_count, created_at, updated_at
      FROM bundles
      ORDER BY created_at DESC, id DESC
    `,
    { page: pageNum, page_size: pageSizeNum }
  );

  const bundles: AdminBundleSummary[] = (result.items as BundleRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    bundle_type: r.bundle_type,
    enabled: r.enabled,
    purchase_count: r.purchase_count,
  }));

  const response: AdminListBundlesResponse = {
    bundles,
    total: result.total,
    page: result.page,
    page_size: result.page_size,
  };
  res.json(response);
});

// ─── GET /admin/bundles/detail ────────────────────────────────────────────────
adminRouter.get("/admin/bundles/detail", async (req: Request, res: Response) => {
  const bundleId =
    typeof req.query.bundle_id === "string"
      ? (req.query.bundle_id as BundleId)
      : null;
  if (!bundleId) {
    res.status(400).json({ bundle: null });
    return;
  }

  const [bundleRow] = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${bundleId}
  `;
  if (!bundleRow) {
    res.status(404).json({ bundle: null });
    return;
  }

  // Fetch items
  const itemRows = await sql<BundleItemRow[]>`
    SELECT id, bundle_id, product_external_id, variant_mode, available
    FROM bundle_items WHERE bundle_id = ${bundleId}
  `;

  const itemsWithVariants = await Promise.all(
    itemRows.map(async (item) => {
      let variants: { variant_external_id: string; live_variant_gid: string }[] = [];
      if (item.variant_mode === "specific") {
        const variantRows = await sql<{ id: string; bundle_item_id: string; variant_external_id: string; variant_gid: string }[]>`
          SELECT id, bundle_item_id, variant_external_id, variant_gid
          FROM bundle_item_variants WHERE bundle_item_id = ${item.id}
        `;
        variants = variantRows.map((vr) => ({
          variant_external_id: String(vr.variant_external_id),
          live_variant_gid: vr.variant_gid,
        }));
      }
      return {
        id: item.id,
        bundle_id: item.bundle_id,
        product_external_id: String(item.product_external_id),
        variant_mode: item.variant_mode,
        available: item.available,
        variants,
      };
    })
  );

  // Fetch tiers
  const tierRows = await sql<{ id: string; bundle_id: string; min_item_count: number; discount_ratio: string | null; discount_amount: string | null; is_bxgy: boolean }[]>`
    SELECT id, bundle_id, min_item_count, discount_ratio, discount_amount, is_bxgy
    FROM bundle_discount_tiers WHERE bundle_id = ${bundleId}
    ORDER BY min_item_count ASC
  `;

  const discountTiers = tierRows.map((t) => ({
    min_item_count: t.min_item_count,
    discount_ratio: t.discount_ratio,
    discount_amount: t.discount_amount,
    is_bxgy: t.is_bxgy,
  }));

  res.json({
    bundle: {
      ...bundleRow,
      items: itemsWithVariants,
      discount_tiers: discountTiers,
    },
  });
});

// ─── GET /admin/products/search ───────────────────────────────────────────────
adminRouter.get("/admin/products/search", async (req: Request, res: Response) => {
  const query = typeof req.query.query === "string" ? req.query.query : "";
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;

  const shopify = await shopifyClientFor(req.platform!);

  const gqlResult = await shopify.graphql<ShopifyProductsQueryResponse>(
    `query SearchProducts($query: String!, $cursor: String) {
       products(first: 20, query: $query, after: $cursor) {
         edges {
           node {
             id
             title
             variants(first: 50) {
               edges {
                 node {
                   id
                   title
                 }
               }
             }
           }
           cursor
         }
         pageInfo {
           hasNextPage
           endCursor
         }
       }
     }`,
    { query, cursor: cursor ?? undefined }
  );

  const edges = gqlResult.products.edges;
  const products: AdminProductShape[] = edges.map((edge) => {
    // Shopify GID: "gid://shopify/Product/123456" — extract numeric id
    const gidParts = edge.node.id.split("/");
    const numericId = gidParts[gidParts.length - 1] ?? "";

    const variants: AdminProductVariantShape[] = edge.node.variants.edges.map(
      (ve) => {
        const vGidParts = ve.node.id.split("/");
        const vNumericId = vGidParts[vGidParts.length - 1] ?? "";
        return {
          id: vNumericId,
          title: ve.node.title,
          gid: ve.node.id as VariantMerchandiseGid,
        };
      }
    );

    return {
      id: numericId,
      title: edge.node.title,
      gid: edge.node.id,
      variants,
    };
  });

  const response: AdminProductSearchResponse = {
    products,
    total: products.length,
    page: 1,
    page_size: 20,
  };
  res.json(response);
});

// ─── POST /admin/bundles/create ───────────────────────────────────────────────
adminRouter.post("/admin/bundles/create", async (req: Request, res: Response) => {
  const body = req.body as AdminCreateBundleRequest;

  if (!body.name || !body.bundle_type || !body.discount_type) {
    res.status(400).json({ bundle_id: null, status: "error", error: "Missing required fields" });
    return;
  }
  if (!body.items || body.items.length === 0) {
    res.status(400).json({ bundle_id: null, status: "error", error: "At least one item is required" });
    return;
  }
  if (!body.discount_tiers || body.discount_tiers.length === 0) {
    res.status(400).json({ bundle_id: null, status: "error", error: "At least one discount tier is required" });
    return;
  }

  const shopify = await shopifyClientFor(req.platform!);
  const safeName = body.name.replace(/\u0000/g, "");
  const code = generateDiscountCode(safeName);
  const title = bundleDiscountTitle(safeName);

  // Provision Shopify discount BEFORE writing to DB so we can fail fast.
  let shopifyNodeId: string;
  let discountCodeStr: string;
  try {
    if (body.discount_type === "bxgy") {
      const r = await provisionBxgyDiscount(shopify, code, title, body.discount_tiers);
      shopifyNodeId = r.nodeId;
      discountCodeStr = r.codeString;
    } else {
      const r = await provisionBasicDiscount(
        shopify,
        code,
        title,
        body.discount_tiers,
        body.discount_type as "percentage" | "flat"
      );
      shopifyNodeId = r.nodeId;
      discountCodeStr = r.codeString;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const resp: AdminCreateBundleResponse = { bundle_id: "" as BundleId, status: "error", error: msg };
    res.status(422).json(resp);
    return;
  }

  // Write to DB in a transaction.
  let newBundleId: BundleId;
  try {
    await sql.begin(async (tx) => {
      const bundleRows = await tx`
        INSERT INTO bundles
          (name, bundle_type, enabled, required_item_count, discount_type,
           shopify_discount_external_id, discount_code_string, purchase_count)
        VALUES (
          ${safeName},
          ${body.bundle_type},
          ${body.enabled},
          ${body.required_item_count ?? null},
          ${body.discount_type},
          ${shopifyNodeId},
          ${discountCodeStr},
          0
        )
        RETURNING *
      ` as unknown as BundleRow[];
      const bundleRow = bundleRows[0];
      if (!bundleRow) throw new Error("Failed to insert bundle");
      newBundleId = bundleRow.id;

      for (const item of body.items) {
        const safeProductId = String(item.product_external_id).replace(/\u0000/g, "");
        const itemRows = await tx`
          INSERT INTO bundle_items (bundle_id, product_external_id, variant_mode, available)
          VALUES (${newBundleId}, ${parseInt(safeProductId, 10)}, ${item.variant_mode}, true)
          ON CONFLICT (bundle_id, product_external_id) DO UPDATE
            SET variant_mode = EXCLUDED.variant_mode
          RETURNING *
        ` as unknown as BundleItemRow[];
        const itemRow = itemRows[0];
        if (!itemRow) throw new Error("Failed to insert bundle item");

        if (item.variant_mode === "specific" && item.variant_external_ids?.length) {
          for (let vi = 0; vi < item.variant_external_ids.length; vi++) {
            const vid = item.variant_external_ids[vi];
            if (!vid) continue;
            // Use provided GID if available, otherwise build from numeric id.
            const gid =
              (item.variant_gids && item.variant_gids[vi])
                ? item.variant_gids[vi]!
                : `gid://shopify/ProductVariant/${vid}`;
            await tx`
              INSERT INTO bundle_item_variants (bundle_item_id, variant_external_id, variant_gid)
              VALUES (${itemRow.id}, ${parseInt(vid, 10)}, ${gid})
              ON CONFLICT (bundle_item_id, variant_external_id) DO NOTHING
            `;
          }
        }
      }

      for (const tier of body.discount_tiers) {
        const discountRatio = tier.discount_ratio ?? null;
        const discountAmount =
          tier.discount_amount != null ? tier.discount_amount : null;
        const isBxgy = tier.is_bxgy ?? false;
        await tx`
          INSERT INTO bundle_discount_tiers
            (bundle_id, min_item_count, discount_ratio, discount_amount, is_bxgy)
          VALUES (
            ${newBundleId},
            ${tier.min_item_count},
            ${discountRatio},
            ${discountAmount},
            ${isBxgy}
          )
          ON CONFLICT (bundle_id, min_item_count) DO UPDATE
            SET discount_ratio = EXCLUDED.discount_ratio,
                discount_amount = EXCLUDED.discount_amount,
                is_bxgy = EXCLUDED.is_bxgy
        `;
      }
    });
  } catch (err: unknown) {
    // Best effort: delete the Shopify discount we just created to avoid orphans.
    try {
      await shopify.graphql<DiscountCodeDeleteResponse>(
        `mutation DeleteBundleDiscount($id: ID!) {
           discountCodeDelete(id: $id) {
             deletedCodeDiscountId
             userErrors { field message }
           }
         }`,
        { id: shopifyNodeId }
      );
    } catch {
      // log but do not throw — we want the original error surfaced
      console.log({ requestId: req.platform!.requestId, shopifyNodeId }, "Failed to rollback Shopify discount after DB error");
    }
    const msg = err instanceof Error ? err.message : String(err);
    const resp: AdminCreateBundleResponse = { bundle_id: "" as BundleId, status: "error", error: msg };
    res.status(500).json(resp);
    return;
  }

  console.log({ requestId: req.platform!.requestId, bundleId: newBundleId! }, "Bundle created");
  const resp: AdminCreateBundleResponse = { bundle_id: newBundleId!, status: "ok" };
  res.status(201).json(resp);
});

// ─── PUT /admin/bundles/update ────────────────────────────────────────────────
adminRouter.put("/admin/bundles/update", async (req: Request, res: Response) => {
  const body = req.body as AdminUpdateBundleRequest;

  if (!body.bundle_id) {
    res.status(400).json({ status: "error", error: "Missing bundle_id" });
    return;
  }

  // Fetch existing bundle to get the Shopify node id.
  const [existing] = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${body.bundle_id}
  `;
  if (!existing) {
    res.status(404).json({ status: "error", error: "Bundle not found" });
    return;
  }

  const shopify = await shopifyClientFor(req.platform!);
  const safeName = body.name.replace(/\u0000/g, "");
  const title = bundleDiscountTitle(safeName);

  // Update Shopify discount if it exists.
  if (existing.shopify_discount_external_id) {
    try {
      if (body.discount_type === "bxgy") {
        await updateBxgyDiscount(
          shopify,
          existing.shopify_discount_external_id,
          title,
          body.discount_tiers
        );
      } else {
        await updateBasicDiscount(
          shopify,
          existing.shopify_discount_external_id,
          title,
          body.discount_tiers,
          body.discount_type as "percentage" | "flat"
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const resp: AdminUpdateBundleResponse = { status: "error", error: msg };
      res.status(422).json(resp);
      return;
    }
  }

  // Update DB in transaction.
  try {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE bundles SET
          name                        = ${safeName},
          bundle_type                 = ${body.bundle_type},
          enabled                     = ${body.enabled},
          required_item_count         = ${body.required_item_count ?? null},
          discount_type               = ${body.discount_type},
          updated_at                  = now()
        WHERE id = ${body.bundle_id}
      `;

      // Replace items: delete and re-insert.
      await tx`DELETE FROM bundle_items WHERE bundle_id = ${body.bundle_id}`;

      for (const item of body.items) {
        const safeProductId = String(item.product_external_id).replace(/\u0000/g, "");
        const itemRows = await tx`
          INSERT INTO bundle_items (bundle_id, product_external_id, variant_mode, available)
          VALUES (${body.bundle_id}, ${parseInt(safeProductId, 10)}, ${item.variant_mode}, true)
          RETURNING *
        ` as unknown as BundleItemRow[];
        const itemRow = itemRows[0];
        if (!itemRow) throw new Error("Failed to insert bundle item");

        if (item.variant_mode === "specific" && item.variant_external_ids?.length) {
          for (let vi = 0; vi < item.variant_external_ids.length; vi++) {
            const vid = item.variant_external_ids[vi];
            if (!vid) continue;
            const gid =
              (item.variant_gids && item.variant_gids[vi])
                ? item.variant_gids[vi]!
                : `gid://shopify/ProductVariant/${vid}`;
            await tx`
              INSERT INTO bundle_item_variants (bundle_item_id, variant_external_id, variant_gid)
              VALUES (${itemRow.id}, ${parseInt(vid, 10)}, ${gid})
              ON CONFLICT (bundle_item_id, variant_external_id) DO NOTHING
            `;
          }
        }
      }

      // Replace tiers.
      await tx`DELETE FROM bundle_discount_tiers WHERE bundle_id = ${body.bundle_id}`;
      for (const tier of body.discount_tiers) {
        const discountRatio = tier.discount_ratio ?? null;
        const discountAmount =
          tier.discount_amount != null ? tier.discount_amount : null;
        const isBxgy = tier.is_bxgy ?? false;
        await tx`
          INSERT INTO bundle_discount_tiers
            (bundle_id, min_item_count, discount_ratio, discount_amount, is_bxgy)
          VALUES (
            ${body.bundle_id},
            ${tier.min_item_count},
            ${discountRatio},
            ${discountAmount},
            ${isBxgy}
          )
        `;
      }
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const resp: AdminUpdateBundleResponse = { status: "error", error: msg };
    res.status(500).json(resp);
    return;
  }

  console.log({ requestId: req.platform!.requestId, bundleId: body.bundle_id }, "Bundle updated");
  const resp: AdminUpdateBundleResponse = { status: "ok" };
  res.json(resp);
});

// ─── DELETE /admin/bundles/delete ─────────────────────────────────────────────
adminRouter.delete("/admin/bundles/delete", async (req: Request, res: Response) => {
  const bundleId =
    typeof req.query.bundle_id === "string"
      ? (req.query.bundle_id as BundleId)
      : typeof (req.body as AdminDeleteBundleRequest).bundle_id === "string"
      ? (req.body as AdminDeleteBundleRequest).bundle_id
      : null;

  if (!bundleId) {
    res.status(400).json({ status: "error", error: "Missing bundle_id" });
    return;
  }

  const [existing] = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${bundleId}
  `;
  if (!existing) {
    res.status(404).json({ status: "error", error: "Bundle not found" });
    return;
  }

  // Delete Shopify discount first.
  if (existing.shopify_discount_external_id) {
    const shopify = await shopifyClientFor(req.platform!);
    try {
      const result = await shopify.graphql<DiscountCodeDeleteResponse>(
        `mutation DeleteBundleDiscount($id: ID!) {
           discountCodeDelete(id: $id) {
             deletedCodeDiscountId
             userErrors { field message }
           }
         }`,
        { id: existing.shopify_discount_external_id }
      );
      if (result.discountCodeDelete.userErrors.length > 0) {
        throw new Error(
          result.discountCodeDelete.userErrors.map((e) => e.message).join("; ")
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const resp: AdminDeleteBundleResponse = { status: "error", error: msg };
      res.status(422).json(resp);
      return;
    }
  }

  await sql`DELETE FROM bundles WHERE id = ${bundleId}`;

  console.log({ requestId: req.platform!.requestId, bundleId }, "Bundle deleted");
  const resp: AdminDeleteBundleResponse = { status: "ok" };
  res.json(resp);
});
