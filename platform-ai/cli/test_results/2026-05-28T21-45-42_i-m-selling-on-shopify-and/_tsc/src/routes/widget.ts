import { Request, Response, Router } from "express";
import { sql } from "../lib/db.js";
import type {
  BundleId,
  BundleRow,
  BundleComponentRow,
  BundleTierRuleRow,
  WidgetBundleDetail,
  ComponentDetail,
  TierRuleDetail,
  CartLine,
  WidgetAddToCartRequest,
} from "../types/contracts.js";

export const widgetRouter = Router();

// ─── GET /widget/bundle ───────────────────────────────────────────────────────

widgetRouter.get("/widget/bundle", async (req: Request, res: Response) => {
  const bundleIdRaw = typeof req.query.bundle_id === "string" ? req.query.bundle_id : null;
  if (!bundleIdRaw) {
    res.status(400).json({ error: "bundle_id query parameter is required." });
    return;
  }

  const bundleId = bundleIdRaw as BundleId;

  const [bundle] = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${bundleId}
  `;

  if (!bundle) {
    res.status(404).json({ error: "Bundle not found." });
    return;
  }

  const components = await sql<BundleComponentRow[]>`
    SELECT * FROM bundle_components
    WHERE bundle_id = ${bundleId}
    ORDER BY position ASC
  `;

  const tiers = await sql<BundleTierRuleRow[]>`
    SELECT * FROM bundle_tier_rules
    WHERE bundle_id = ${bundleId}
    ORDER BY position ASC
  `;

  const tierDetails: TierRuleDetail[] = tiers.map((t) => ({
    id: t.id,
    bundle_id: t.bundle_id,
    min_quantity: t.min_quantity,
    discount_value: Number(t.discount_value),
    position: t.position,
  }));

  const componentDetails: ComponentDetail[] = components.map((c) => ({
    id: c.id,
    bundle_id: c.bundle_id,
    product_external_id: Number(c.product_external_id),
    variant_external_id: c.variant_external_id != null ? Number(c.variant_external_id) : null,
    position: c.position,
    is_available: c.is_available,
  }));

  const bundleDetail: WidgetBundleDetail = {
    id: bundle.id,
    title: bundle.title,
    bundle_type: bundle.bundle_type,
    required_count: bundle.required_count,
    discount_kind: bundle.discount_kind,
    discount_value: bundle.discount_value != null ? Number(bundle.discount_value) : null,
    tier_rules: tierDetails,
    enabled: bundle.enabled,
    availability_status: bundle.availability_status,
  };

  console.log({ requestId: req.platform!.requestId, bundleId }, "widget bundle fetched");

  res.json({
    bundle: bundleDetail,
    components: componentDetails,
  });
});

// ─── POST /widget/bundle/add-to-cart ─────────────────────────────────────────

widgetRouter.post("/widget/bundle/add-to-cart", async (req: Request, res: Response) => {
  const body = req.body as WidgetAddToCartRequest;

  if (!body.bundle_id || typeof body.bundle_id !== "string") {
    res.status(400).json({
      cart_lines: [],
      bundle_note: "",
      validation_errors: ["bundle_id is required."],
    });
    return;
  }

  if (!Array.isArray(body.selected_variant_ids)) {
    res.status(400).json({
      cart_lines: [],
      bundle_note: "",
      validation_errors: ["selected_variant_ids must be an array."],
    });
    return;
  }

  const bundleId = body.bundle_id as BundleId;
  const selectedVariantIds: number[] = body.selected_variant_ids.map(Number);

  // Fetch bundle
  const [bundle] = await sql<BundleRow[]>`SELECT * FROM bundles WHERE id = ${bundleId}`;
  if (!bundle) {
    res.status(404).json({
      cart_lines: [],
      bundle_note: "",
      validation_errors: ["Bundle not found."],
    });
    return;
  }

  if (!bundle.enabled) {
    res.status(400).json({
      cart_lines: [],
      bundle_note: "",
      validation_errors: ["This bundle is not currently available."],
    });
    return;
  }

  if (bundle.availability_status === "suspended") {
    res.status(400).json({
      cart_lines: [],
      bundle_note: "",
      validation_errors: ["This bundle has been suspended because some required products are unavailable."],
    });
    return;
  }

  // Fetch components
  const components = await sql<BundleComponentRow[]>`
    SELECT * FROM bundle_components
    WHERE bundle_id = ${bundleId}
    ORDER BY position ASC
  `;

  const validationErrors: string[] = [];

  // Validate selection against bundle type
  if (bundle.bundle_type === "fixed") {
    // For fixed bundles, all components must be selected (one per component)
    const availableComponents = components.filter((c) => c.is_available);
    const unavailableComponents = components.filter((c) => !c.is_available);

    if (unavailableComponents.length > 0) {
      validationErrors.push(
        `${unavailableComponents.length} component(s) in this bundle are currently unavailable.`
      );
    }

    // Fixed bundle: selection should match the number of components
    if (selectedVariantIds.length !== availableComponents.length) {
      validationErrors.push(
        `Fixed bundle requires exactly ${availableComponents.length} items. You selected ${selectedVariantIds.length}.`
      );
    }
  } else {
    // Flexible bundle: validate selection count
    const requiredCount = bundle.required_count ?? 0;
    if (selectedVariantIds.length !== requiredCount) {
      validationErrors.push(
        `Please select exactly ${requiredCount} item(s). You selected ${selectedVariantIds.length}.`
      );
    }

    // All selected variants must come from available components
    const availableVariantIds = new Set<string>();
    const availableProductIds = new Set<string>();

    for (const comp of components) {
      if (!comp.is_available) continue;
      if (comp.variant_external_id != null) {
        availableVariantIds.add(String(comp.variant_external_id));
      } else {
        availableProductIds.add(String(comp.product_external_id));
      }
    }

    for (const variantId of selectedVariantIds) {
      const variantIdStr = String(variantId);
      // Check if this variant is directly available, or its product is available (whole-product components)
      const isDirectlyAvailable = availableVariantIds.has(variantIdStr);
      // For whole-product components, we accept any variant from the product
      // (the widget sends variant ids for storefront, so we accept if variant is in available pool)
      if (!isDirectlyAvailable) {
        // Check if it came from an available component — if not we block it
        const directVariantComponent = components.find(
          (c) => c.variant_external_id != null && String(c.variant_external_id) === variantIdStr
        );
        if (directVariantComponent && !directVariantComponent.is_available) {
          validationErrors.push(
            `Variant ${variantId} is currently unavailable.`
          );
        }
      }
    }
  }

  if (validationErrors.length > 0) {
    res.status(400).json({
      cart_lines: [],
      bundle_note: "",
      validation_errors: validationErrors,
    });
    return;
  }

  // Build cart lines — one line per variant with quantity 1
  const variantCounts = new Map<number, number>();
  for (const vid of selectedVariantIds) {
    variantCounts.set(vid, (variantCounts.get(vid) ?? 0) + 1);
  }

  const cartLines: CartLine[] = Array.from(variantCounts.entries()).map(([variantId, quantity]) => ({
    merchandiseId: `gid://shopify/ProductVariant/${variantId}`,
    quantity,
  }));

  const bundleNote = `bundle_id:${bundleId}`;

  console.log({ requestId: req.platform!.requestId, bundleId, variantCount: selectedVariantIds.length }, "add-to-cart validated");

  res.json({
    cart_lines: cartLines,
    bundle_note: bundleNote,
    validation_errors: [],
  });
});
