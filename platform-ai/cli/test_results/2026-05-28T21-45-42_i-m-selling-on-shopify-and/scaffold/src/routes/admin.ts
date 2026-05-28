import { Request, Response, Router } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import { money } from "../lib/money.js";
import { paginate } from "../lib/paginate.js";
import type {
  BundleId,
  BundleRow,
  BundleComponentRow,
  BundleTierRuleRow,
  BundleSummary,
  AdminCreateBundleRequest,
  AdminUpdateBundleRequest,
  AdminToggleBundleRequest,
  AdminDeleteBundleRequest,
  AdminSetComponentsRequest,
  ComponentInput,
  TierRuleInput,
  DiscountFunctionConfig,
  ProductBundleCreatePayload,
  ProductBundleUpdatePayload,
  DiscountAutomaticAppCreatePayload,
  DiscountAutomaticAppUpdatePayload,
  DiscountAutomaticActivatePayload,
  DiscountAutomaticDeactivatePayload,
  DiscountAutomaticDeletePayload,
} from "../types/contracts.js";

export const adminRouter = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateTierRules(
  tiers: TierRuleInput[],
  discountKind: string
): string[] {
  const errors: string[] = [];
  if (!tiers || tiers.length === 0) return errors;

  const sorted = [...tiers].sort((a, b) => a.min_quantity - b.min_quantity);

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (current !== undefined && next !== undefined && current.min_quantity >= next.min_quantity) {
      errors.push(
        `Tier ${i + 1} and tier ${i + 2} have overlapping or duplicate min_quantity values (${current.min_quantity} >= ${next.min_quantity}). Each tier must have a strictly larger min_quantity.`
      );
    }
  }

  if (discountKind === "percentage") {
    for (const tier of sorted) {
      if (tier.discount_value > 100) {
        errors.push(
          `Tier with min_quantity=${tier.min_quantity} has a percentage discount_value of ${tier.discount_value}, which exceeds 100%.`
        );
      }
    }
  }

  return errors;
}

function buildDiscountFunctionConfig(
  bundleId: BundleId,
  discountKind: string,
  discountValue: number | null | undefined,
  tiers: TierRuleInput[]
): DiscountFunctionConfig {
  return {
    bundle_id: bundleId,
    discount_kind: discountKind as DiscountFunctionConfig["discount_kind"],
    base_discount_value: discountValue ?? 0,
    tiers: tiers.map((t) => ({
      min_quantity: t.min_quantity,
      discount_value: t.discount_value,
    })),
    combines_with_order_discounts: false,
  };
}

// ─── GET /admin/bundles ───────────────────────────────────────────────────────

adminRouter.get("/admin/bundles", async (req: Request, res: Response) => {
  const pageRaw = typeof req.query.page === "string" ? parseInt(req.query.page, 10) : 1;
  const pageSizeRaw = typeof req.query.page_size === "string" ? parseInt(req.query.page_size, 10) : 20;
  const page = isNaN(pageRaw) || pageRaw < 1 ? 1 : pageRaw;
  const page_size = isNaN(pageSizeRaw) || pageSizeRaw < 1 ? 20 : pageSizeRaw;

  const statusFilter =
    typeof req.query.status_filter === "string" ? req.query.status_filter : null;
  const enabledFilter =
    typeof req.query.enabled_filter === "string"
      ? req.query.enabled_filter === "true"
      : null;

  const result = await paginate<BundleSummary>(
    sql,
    sql`
      SELECT
        id,
        title,
        bundle_type,
        discount_kind,
        enabled,
        availability_status,
        purchase_count,
        created_at,
        updated_at
      FROM bundles
      WHERE
        (${statusFilter} IS NULL OR availability_status = ${statusFilter})
        AND (${enabledFilter} IS NULL OR enabled = ${enabledFilter})
      ORDER BY created_at DESC
    `,
    { page, page_size }
  );

  res.json(result);
});

// ─── POST /admin/bundles/create ───────────────────────────────────────────────

adminRouter.post("/admin/bundles/create", async (req: Request, res: Response) => {
  const body = req.body as AdminCreateBundleRequest;

  const validationErrors: string[] = [];

  if (!body.title || typeof body.title !== "string" || body.title.trim() === "") {
    validationErrors.push("title is required.");
  }
  if (!body.bundle_type || !["fixed", "flexible"].includes(body.bundle_type)) {
    validationErrors.push("bundle_type must be 'fixed' or 'flexible'.");
  }
  if (!body.discount_kind || !["percentage", "flat_amount", "buy_x_get_y"].includes(body.discount_kind)) {
    validationErrors.push("discount_kind must be 'percentage', 'flat_amount', or 'buy_x_get_y'.");
  }
  if (body.bundle_type === "flexible" && (body.required_count == null || body.required_count < 1)) {
    validationErrors.push("required_count must be >= 1 for flexible bundles.");
  }

  const components: ComponentInput[] = Array.isArray(body.components) ? body.components : [];
  const tierRules: TierRuleInput[] = Array.isArray(body.tier_rules) ? body.tier_rules : [];

  if (body.bundle_type === "fixed" && components.length < 2) {
    validationErrors.push("Fixed bundles must have at least 2 component items.");
  }
  if (body.bundle_type === "flexible") {
    const requiredCount = body.required_count ?? 0;
    if (components.length <= requiredCount) {
      validationErrors.push(
        `Flexible bundle pool size (${components.length}) must be larger than required_count (${requiredCount}).`
      );
    }
  }

  const tierErrors = validateTierRules(tierRules, body.discount_kind ?? "");
  validationErrors.push(...tierErrors);

  if (validationErrors.length > 0) {
    res.status(400).json({ bundle_id: null, validation_errors: validationErrors });
    return;
  }

  const title = body.title.trim().replace(/\x00/g, "");
  const discountCurrency = body.discount_currency ?? null;
  let discountValueMinor: bigint | null = null;
  if (body.discount_value != null) {
    if (discountCurrency && body.discount_kind === "flat_amount") {
      discountValueMinor = BigInt(money.toMinorUnits(String(body.discount_value), discountCurrency));
    } else {
      discountValueMinor = BigInt(Math.round(body.discount_value));
    }
  }

  const discountValueParam = discountValueMinor !== null ? Number(discountValueMinor) : null;

  const [bundle] = await sql<BundleRow[]>`
    INSERT INTO bundles (
      title, bundle_type, required_count, discount_kind,
      discount_value, discount_currency, enabled, availability_status,
      purchase_count
    ) VALUES (
      ${title},
      ${body.bundle_type},
      ${body.required_count ?? null},
      ${body.discount_kind},
      ${discountValueParam},
      ${discountCurrency},
      ${body.enabled !== false},
      'active',
      0
    )
    RETURNING *
  `;

  if (!bundle) {
    res.status(500).json({ bundle_id: null, validation_errors: ["Failed to insert bundle."] });
    return;
  }

  const bundleId = bundle.id;

  // Insert components
  if (components.length > 0) {
    for (const comp of components) {
      await sql`
        INSERT INTO bundle_components (bundle_id, product_external_id, variant_external_id, position, is_available)
        VALUES (
          ${bundleId},
          ${comp.product_external_id},
          ${comp.variant_external_id ?? null},
          ${comp.position},
          true
        )
      `;
    }
  }

  // Insert tier rules
  if (tierRules.length > 0) {
    for (const tier of tierRules) {
      await sql`
        INSERT INTO bundle_tier_rules (bundle_id, min_quantity, discount_value, position)
        VALUES (
          ${bundleId},
          ${tier.min_quantity},
          ${Math.round(tier.discount_value)},
          ${tier.position}
        )
      `;
    }
  }

  // Create Shopify product bundle
  const shopify = await shopifyClientFor(req.platform!);
  let shopifyProductGid: string | null = null;
  let shopifyProductExternalId: number | null = null;

  try {
    const productBundleComponents = components.map((c) => ({
      productId: `gid://shopify/Product/${c.product_external_id}`,
      quantity: 1,
      optionSelections: [],
    }));

    const pbResult = await shopify.graphql<ProductBundleCreatePayload>(
      `mutation productBundleCreate($input: ProductBundleCreateInput!) {
        productBundleCreate(input: $input) {
          productBundleOperation {
            product {
              id
              legacyResourceId
            }
          }
          userErrors { field message }
        }
      }`,
      {
        input: {
          title,
          components: productBundleComponents,
        },
      }
    );

    const pbOp = pbResult.productBundleCreate;
    if (pbOp.userErrors.length > 0) {
      console.warn({ bundleId, errors: pbOp.userErrors }, "productBundleCreate userErrors");
    } else if (pbOp.productBundleOperation?.product) {
      shopifyProductGid = pbOp.productBundleOperation.product.id;
      shopifyProductExternalId = parseInt(pbOp.productBundleOperation.product.legacyResourceId, 10);
    }
  } catch (err) {
    console.error({ bundleId, err: String(err) }, "productBundleCreate failed");
  }

  // Create Shopify automatic app discount
  let shopifyDiscountGid: string | null = null;
  let shopifyDiscountExternalId: number | null = null;

  try {
    const functionConfig = buildDiscountFunctionConfig(
      bundleId,
      body.discount_kind,
      body.discount_value,
      tierRules
    );

    const discResult = await shopify.graphql<DiscountAutomaticAppCreatePayload>(
      `mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount {
            discountId
          }
          userErrors { field message }
        }
      }`,
      {
        automaticAppDiscount: {
          title: `Bundle: ${title}`,
          startsAt: new Date().toISOString(),
          combinesWith: {
            orderDiscounts: false,
            productDiscounts: false,
            shippingDiscounts: false,
          },
          metafields: [
            {
              namespace: "bundle_app",
              key: "function_config",
              type: "json",
              value: JSON.stringify(functionConfig),
            },
          ],
        },
      }
    );

    const da = discResult.discountAutomaticAppCreate;
    if (da.userErrors.length > 0) {
      console.warn({ bundleId, errors: da.userErrors }, "discountAutomaticAppCreate userErrors");
    } else if (da.automaticAppDiscount) {
      shopifyDiscountGid = da.automaticAppDiscount.discountId;
      const parts = shopifyDiscountGid.split("/");
      const numericPart = parts[parts.length - 1];
      if (numericPart) {
        shopifyDiscountExternalId = parseInt(numericPart, 10);
      }
    }
  } catch (err) {
    console.error({ bundleId, err: String(err) }, "discountAutomaticAppCreate failed");
  }

  const newAvailStatus = shopifyDiscountGid == null ? "degraded" : "active";

  await sql`
    UPDATE bundles
    SET
      shopify_product_gid = ${shopifyProductGid},
      shopify_product_external_id = ${shopifyProductExternalId},
      shopify_discount_gid = ${shopifyDiscountGid},
      shopify_discount_external_id = ${shopifyDiscountExternalId},
      availability_status = ${newAvailStatus},
      updated_at = now()
    WHERE id = ${bundleId}
  `;

  console.log({ requestId: req.platform!.requestId, bundleId }, "bundle created");
  res.status(201).json({ bundle_id: bundleId, validation_errors: [] });
});

// ─── PUT /admin/bundles/update ────────────────────────────────────────────────

adminRouter.put("/admin/bundles/update", async (req: Request, res: Response) => {
  const body = req.body as AdminUpdateBundleRequest;

  if (!body.bundle_id || typeof body.bundle_id !== "string") {
    res.status(400).json({ success: false, validation_errors: ["bundle_id is required."] });
    return;
  }

  const bundleId = body.bundle_id as BundleId;

  const [existing] = await sql<BundleRow[]>`SELECT * FROM bundles WHERE id = ${bundleId}`;
  if (!existing) {
    res.status(404).json({ success: false, validation_errors: ["Bundle not found."] });
    return;
  }

  const validationErrors: string[] = [];
  const bundleType = body.bundle_type ?? existing.bundle_type;
  const discountKind = body.discount_kind ?? existing.discount_kind;

  if (body.bundle_type && !["fixed", "flexible"].includes(body.bundle_type)) {
    validationErrors.push("bundle_type must be 'fixed' or 'flexible'.");
  }
  if (body.discount_kind && !["percentage", "flat_amount", "buy_x_get_y"].includes(body.discount_kind)) {
    validationErrors.push("discount_kind must be 'percentage', 'flat_amount', or 'buy_x_get_y'.");
  }
  if (bundleType === "flexible") {
    const reqCount = body.required_count !== undefined ? body.required_count : existing.required_count;
    if (reqCount == null || reqCount < 1) {
      validationErrors.push("required_count must be >= 1 for flexible bundles.");
    }
  }

  const tierRules: TierRuleInput[] | null = Array.isArray(body.tier_rules) ? body.tier_rules : null;
  const components: ComponentInput[] | null = Array.isArray(body.components) ? body.components : null;

  if (components !== null) {
    if (bundleType === "fixed" && components.length < 2) {
      validationErrors.push("Fixed bundles must have at least 2 component items.");
    }
    if (bundleType === "flexible") {
      const reqCount = body.required_count !== undefined
        ? (body.required_count ?? 0)
        : (existing.required_count ?? 0);
      if (components.length <= reqCount) {
        validationErrors.push(
          `Flexible bundle pool size (${components.length}) must be larger than required_count (${reqCount}).`
        );
      }
    }
  }

  if (tierRules !== null) {
    const tierErrors = validateTierRules(tierRules, discountKind);
    validationErrors.push(...tierErrors);
  }

  if (validationErrors.length > 0) {
    res.status(400).json({ success: false, validation_errors: validationErrors });
    return;
  }

  const title = body.title != null ? body.title.trim().replace(/\x00/g, "") : null;
  const discountCurrency = body.discount_currency !== undefined ? body.discount_currency : existing.discount_currency;

  let discountValueParam: number | null = null;
  if (body.discount_value != null) {
    if (discountCurrency && discountKind === "flat_amount") {
      discountValueParam = money.toMinorUnits(String(body.discount_value), discountCurrency);
    } else {
      discountValueParam = Math.round(body.discount_value);
    }
  }

  const hasRequiredCountUpdate = body.required_count !== undefined;
  const hasDiscountValueUpdate = body.discount_value !== undefined;

  await sql`
    UPDATE bundles SET
      title = COALESCE(${title}, title),
      bundle_type = COALESCE(${body.bundle_type ?? null}, bundle_type),
      required_count = CASE WHEN ${hasRequiredCountUpdate} THEN ${body.required_count ?? null} ELSE required_count END,
      discount_kind = COALESCE(${body.discount_kind ?? null}, discount_kind),
      discount_value = CASE WHEN ${hasDiscountValueUpdate} THEN ${discountValueParam} ELSE discount_value END,
      discount_currency = COALESCE(${discountCurrency ?? null}, discount_currency),
      enabled = COALESCE(${body.enabled ?? null}, enabled),
      updated_at = now()
    WHERE id = ${bundleId}
  `;

  // Replace components if provided
  if (components !== null) {
    await sql`DELETE FROM bundle_components WHERE bundle_id = ${bundleId}`;
    for (const comp of components) {
      await sql`
        INSERT INTO bundle_components (bundle_id, product_external_id, variant_external_id, position, is_available)
        VALUES (
          ${bundleId},
          ${comp.product_external_id},
          ${comp.variant_external_id ?? null},
          ${comp.position},
          true
        )
      `;
    }
  }

  // Replace tier rules if provided
  if (tierRules !== null) {
    await sql`DELETE FROM bundle_tier_rules WHERE bundle_id = ${bundleId}`;
    for (const tier of tierRules) {
      await sql`
        INSERT INTO bundle_tier_rules (bundle_id, min_quantity, discount_value, position)
        VALUES (
          ${bundleId},
          ${tier.min_quantity},
          ${Math.round(tier.discount_value)},
          ${tier.position}
        )
      `;
    }
  }

  const shopify = await shopifyClientFor(req.platform!);

  // Sync Shopify product bundle if components changed or title changed
  if ((components !== null || title !== null) && existing.shopify_product_gid) {
    try {
      let currentComponents: ComponentInput[];
      if (components !== null) {
        currentComponents = components;
      } else {
        const rows = await sql<BundleComponentRow[]>`
          SELECT * FROM bundle_components WHERE bundle_id = ${bundleId} ORDER BY position
        `;
        currentComponents = rows.map((r) => ({
          product_external_id: Number(r.product_external_id),
          variant_external_id: r.variant_external_id != null ? Number(r.variant_external_id) : null,
          position: r.position,
        }));
      }

      const pbComponents = currentComponents.map((c) => ({
        productId: `gid://shopify/Product/${c.product_external_id}`,
        quantity: 1,
        optionSelections: [],
      }));

      const pbResult = await shopify.graphql<ProductBundleUpdatePayload>(
        `mutation productBundleUpdate($input: ProductBundleUpdateInput!) {
          productBundleUpdate(input: $input) {
            productBundleOperation {
              product { id legacyResourceId }
            }
            userErrors { field message }
          }
        }`,
        {
          input: {
            productId: existing.shopify_product_gid,
            title: title ?? existing.title,
            components: pbComponents,
          },
        }
      );

      if (pbResult.productBundleUpdate.userErrors.length > 0) {
        console.warn({ bundleId, errors: pbResult.productBundleUpdate.userErrors }, "productBundleUpdate userErrors");
      }
    } catch (err) {
      console.error({ bundleId, err: String(err) }, "productBundleUpdate failed");
    }
  }

  // Sync Shopify discount if discount config changed
  const discountConfigChanged =
    body.discount_kind != null ||
    body.discount_value != null ||
    tierRules !== null ||
    title !== null;

  if (discountConfigChanged && existing.shopify_discount_gid) {
    try {
      let effectiveTierInputs: TierRuleInput[];
      if (tierRules !== null) {
        effectiveTierInputs = tierRules;
      } else {
        const rows = await sql<BundleTierRuleRow[]>`
          SELECT * FROM bundle_tier_rules WHERE bundle_id = ${bundleId} ORDER BY position
        `;
        effectiveTierInputs = rows.map((t) => ({
          min_quantity: t.min_quantity,
          discount_value: Number(t.discount_value),
          position: t.position,
        }));
      }

      const effectiveDiscountValue = body.discount_value != null
        ? body.discount_value
        : (existing.discount_value != null ? Number(existing.discount_value) : null);

      const functionConfig = buildDiscountFunctionConfig(
        bundleId,
        discountKind,
        effectiveDiscountValue,
        effectiveTierInputs
      );

      const effectiveTitle = title ?? existing.title;

      const discResult = await shopify.graphql<DiscountAutomaticAppUpdatePayload>(
        `mutation discountAutomaticAppUpdate($automaticAppDiscount: DiscountAutomaticAppInput!, $id: ID!) {
          discountAutomaticAppUpdate(automaticAppDiscount: $automaticAppDiscount, id: $id) {
            automaticAppDiscount { title }
            userErrors { field message }
          }
        }`,
        {
          id: existing.shopify_discount_gid,
          automaticAppDiscount: {
            title: `Bundle: ${effectiveTitle}`,
            metafields: [
              {
                namespace: "bundle_app",
                key: "function_config",
                type: "json",
                value: JSON.stringify(functionConfig),
              },
            ],
          },
        }
      );

      if (discResult.discountAutomaticAppUpdate.userErrors.length > 0) {
        console.warn({ bundleId, errors: discResult.discountAutomaticAppUpdate.userErrors }, "discountAutomaticAppUpdate userErrors");
      }
    } catch (err) {
      console.error({ bundleId, err: String(err) }, "discountAutomaticAppUpdate failed");
    }
  }

  console.log({ requestId: req.platform!.requestId, bundleId }, "bundle updated");
  res.json({ success: true, validation_errors: [] });
});

// ─── POST /admin/bundles/toggle ───────────────────────────────────────────────

adminRouter.post("/admin/bundles/toggle", async (req: Request, res: Response) => {
  const body = req.body as AdminToggleBundleRequest;

  if (!body.bundle_id || typeof body.bundle_id !== "string") {
    res.status(400).json({ success: false });
    return;
  }
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ success: false });
    return;
  }

  const bundleId = body.bundle_id as BundleId;
  const [bundle] = await sql<BundleRow[]>`SELECT * FROM bundles WHERE id = ${bundleId}`;
  if (!bundle) {
    res.status(404).json({ success: false });
    return;
  }

  await sql`
    UPDATE bundles SET enabled = ${body.enabled}, updated_at = now()
    WHERE id = ${bundleId}
  `;

  if (bundle.shopify_discount_gid) {
    const discountGid = bundle.shopify_discount_gid;
    const shopify = await shopifyClientFor(req.platform!);

    try {
      if (body.enabled) {
        const result = await shopify.graphql<DiscountAutomaticActivatePayload>(
          `mutation discountAutomaticActivate($id: ID!) {
            discountAutomaticActivate(id: $id) {
              automaticDiscountNode { id }
              userErrors { field message }
            }
          }`,
          { id: discountGid }
        );
        if (result.discountAutomaticActivate.userErrors.length > 0) {
          console.warn({ bundleId, errors: result.discountAutomaticActivate.userErrors }, "discountAutomaticActivate userErrors");
        }
      } else {
        const result = await shopify.graphql<DiscountAutomaticDeactivatePayload>(
          `mutation discountAutomaticDeactivate($id: ID!) {
            discountAutomaticDeactivate(id: $id) {
              automaticDiscountNode { id }
              userErrors { field message }
            }
          }`,
          { id: discountGid }
        );
        if (result.discountAutomaticDeactivate.userErrors.length > 0) {
          console.warn({ bundleId, errors: result.discountAutomaticDeactivate.userErrors }, "discountAutomaticDeactivate userErrors");
        }
      }
    } catch (err) {
      console.error({ bundleId, err: String(err) }, "discount toggle failed");
    }
  }

  console.log({ requestId: req.platform!.requestId, bundleId, enabled: body.enabled }, "bundle toggled");
  res.json({ success: true });
});

// ─── DELETE /admin/bundles/delete ─────────────────────────────────────────────

adminRouter.delete("/admin/bundles/delete", async (req: Request, res: Response) => {
  const bundleIdBody = req.body && typeof (req.body as AdminDeleteBundleRequest).bundle_id === "string"
    ? (req.body as AdminDeleteBundleRequest).bundle_id
    : null;
  const bundleIdQuery = typeof req.query.bundle_id === "string" ? req.query.bundle_id : null;
  const bundleIdStr = bundleIdBody ?? bundleIdQuery;

  if (!bundleIdStr) {
    res.status(400).json({ success: false });
    return;
  }

  const bundleId = bundleIdStr as BundleId;
  const [bundle] = await sql<BundleRow[]>`SELECT * FROM bundles WHERE id = ${bundleId}`;
  if (!bundle) {
    res.status(404).json({ success: false });
    return;
  }

  if (bundle.shopify_discount_gid) {
    const discountGid = bundle.shopify_discount_gid;
    const shopify = await shopifyClientFor(req.platform!);
    try {
      const result = await shopify.graphql<DiscountAutomaticDeletePayload>(
        `mutation discountAutomaticDelete($id: ID!) {
          discountAutomaticDelete(id: $id) {
            deletedAutomaticDiscountId
            userErrors { field message }
          }
        }`,
        { id: discountGid }
      );
      if (result.discountAutomaticDelete.userErrors.length > 0) {
        console.warn({ bundleId, errors: result.discountAutomaticDelete.userErrors }, "discountAutomaticDelete userErrors");
      }
    } catch (err) {
      console.error({ bundleId, err: String(err) }, "discountAutomaticDelete failed");
    }
  }

  await sql`DELETE FROM bundles WHERE id = ${bundleId}`;

  console.log({ requestId: req.platform!.requestId, bundleId }, "bundle deleted");
  res.json({ success: true });
});

// ─── POST /admin/bundles/components ──────────────────────────────────────────

adminRouter.post("/admin/bundles/components", async (req: Request, res: Response) => {
  const body = req.body as AdminSetComponentsRequest;

  if (!body.bundle_id || typeof body.bundle_id !== "string") {
    res.status(400).json({ success: false, validation_errors: ["bundle_id is required."] });
    return;
  }
  if (!Array.isArray(body.components)) {
    res.status(400).json({ success: false, validation_errors: ["components must be an array."] });
    return;
  }

  const bundleId = body.bundle_id as BundleId;
  const [bundle] = await sql<BundleRow[]>`SELECT * FROM bundles WHERE id = ${bundleId}`;
  if (!bundle) {
    res.status(404).json({ success: false, validation_errors: ["Bundle not found."] });
    return;
  }

  const components = body.components;
  const validationErrors: string[] = [];

  if (bundle.bundle_type === "fixed" && components.length < 2) {
    validationErrors.push("Fixed bundles must have at least 2 component items.");
  }
  if (bundle.bundle_type === "flexible") {
    const reqCount = bundle.required_count ?? 0;
    if (components.length <= reqCount) {
      validationErrors.push(
        `Flexible bundle pool size (${components.length}) must be larger than required_count (${reqCount}).`
      );
    }
  }

  if (validationErrors.length > 0) {
    res.status(400).json({ success: false, validation_errors: validationErrors });
    return;
  }

  await sql`DELETE FROM bundle_components WHERE bundle_id = ${bundleId}`;
  for (const comp of components) {
    await sql`
      INSERT INTO bundle_components (bundle_id, product_external_id, variant_external_id, position, is_available)
      VALUES (
        ${bundleId},
        ${comp.product_external_id},
        ${comp.variant_external_id ?? null},
        ${comp.position},
        true
      )
    `;
  }

  await sql`UPDATE bundles SET updated_at = now() WHERE id = ${bundleId}`;

  if (bundle.shopify_product_gid && components.length > 0) {
    const shopify = await shopifyClientFor(req.platform!);
    try {
      const pbComponents = components.map((c) => ({
        productId: `gid://shopify/Product/${c.product_external_id}`,
        quantity: 1,
        optionSelections: [],
      }));

      const pbResult = await shopify.graphql<ProductBundleUpdatePayload>(
        `mutation productBundleUpdate($input: ProductBundleUpdateInput!) {
          productBundleUpdate(input: $input) {
            productBundleOperation { product { id } }
            userErrors { field message }
          }
        }`,
        {
          input: {
            productId: bundle.shopify_product_gid,
            components: pbComponents,
          },
        }
      );
      if (pbResult.productBundleUpdate.userErrors.length > 0) {
        console.warn({ bundleId, errors: pbResult.productBundleUpdate.userErrors }, "productBundleUpdate userErrors");
      }
    } catch (err) {
      console.error({ bundleId, err: String(err) }, "productBundleUpdate failed");
    }
  }

  console.log({ requestId: req.platform!.requestId, bundleId, count: components.length }, "bundle components updated");
  res.json({ success: true, validation_errors: [] });
});
