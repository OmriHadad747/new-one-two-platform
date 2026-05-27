import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import { computeEarnedTier } from "../lib/bundle-health.js";
import type {
  BundleId,
  BundleRow,
  BundleItemRow,
  BundleTierRow,
  WidgetGetBundleRequest,
  WidgetGetBundleResponse,
  WidgetBundleDetail,
  WidgetTierDetail,
  WidgetItemDetail,
  WidgetValidateBundleRequest,
  WidgetValidateBundleResponse,
  WidgetEarnedTier,
  WidgetCartAddRequest,
  WidgetCartAddResponse,
} from "../types/contracts.js";

export const widgetRouter = Router();

// ─── Cursor helpers ───────────────────────────────────────────────────────────

function encodeCursor(addedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ created_at: addedAt.toISOString(), id })).toString("base64url");
}

function decodeCursor(cursor: string): { created_at: string; id: string } | null {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString()) as { created_at: string; id: string };
  } catch {
    return null;
  }
}

// ─── GET /widget/bundle ───────────────────────────────────────────────────────

widgetRouter.get("/widget/bundle", async (req: Request, res: Response) => {
  const query = req.query as WidgetGetBundleRequest;
  if (!query.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const pageSize = 100;
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  try {
    const [bundle] = await sql<BundleRow[]>`
      SELECT * FROM bundles WHERE id = ${query.bundle_id}
    `;
    if (!bundle) {
      res.status(404).json({ error: "bundle_not_found" });
      return;
    }
    if (!bundle.enabled) {
      res.status(404).json({ error: "bundle_not_active" });
      return;
    }

    const tiers = await sql<BundleTierRow[]>`
      SELECT * FROM bundle_tiers
      WHERE bundle_id = ${query.bundle_id}
      ORDER BY display_order ASC
    `;

    const cursorCondition = cursor
      ? sql`AND (bi.added_at, bi.id::text) < (${cursor.created_at}::timestamptz, ${cursor.id})`
      : sql``;

    const itemRows = await sql<BundleItemRow[]>`
      SELECT bi.*
      FROM bundle_items bi
      WHERE bi.bundle_id = ${query.bundle_id}
        ${cursorCondition}
      ORDER BY bi.added_at ASC, bi.id ASC
      LIMIT ${pageSize + 1}
    `;

    const [countRow] = await sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM bundle_items WHERE bundle_id = ${query.bundle_id}
    `;

    const hasMore = itemRows.length > pageSize;
    const page = hasMore ? itemRows.slice(0, pageSize) : itemRows;
    const nextCursor =
      hasMore ? encodeCursor(page[page.length - 1].added_at, page[page.length - 1].id) : null;

    const bundleDetail: WidgetBundleDetail = {
      id: bundle.id,
      title: bundle.title,
      description: bundle.description,
      mode: bundle.mode,
      enabled: bundle.enabled,
      health_status: bundle.health_status,
    };

    const tierDetails: WidgetTierDetail[] = tiers.map((t) => ({
      id: t.id,
      minimum_item_count: t.minimum_item_count,
      discount_rate: t.discount_rate,
      display_order: t.display_order,
    }));

    const itemDetails: WidgetItemDetail[] = page.map((i) => ({
      id: i.id,
      variant_external_id: i.variant_external_id,
      product_external_id: i.product_external_id,
      observed_availability: i.observed_availability,
    }));

    const response: WidgetGetBundleResponse = {
      bundle: bundleDetail,
      tiers: tierDetails,
      items: itemDetails,
      next_cursor: nextCursor,
      total_count: countRow.total,
    };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "widget-get-bundle failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── POST /widget/bundle/validate ────────────────────────────────────────────

widgetRouter.post("/widget/bundle/validate", async (req: Request, res: Response) => {
  const body = req.body as WidgetValidateBundleRequest;
  if (!body.bundle_id || !Array.isArray(body.selected_variant_ids)) {
    res.status(400).json({ error: "bundle_id and selected_variant_ids are required" });
    return;
  }

  try {
    const [bundle] = await sql<BundleRow[]>`
      SELECT * FROM bundles WHERE id = ${body.bundle_id}
    `;
    if (!bundle || !bundle.enabled) {
      res.status(404).json({ error: "bundle_not_found_or_inactive" });
      return;
    }

    const items = await sql<BundleItemRow[]>`
      SELECT * FROM bundle_items WHERE bundle_id = ${body.bundle_id}
    `;

    const tiers = await sql<BundleTierRow[]>`
      SELECT * FROM bundle_tiers
      WHERE bundle_id = ${body.bundle_id}
      ORDER BY minimum_item_count DESC
    `;

    const errors: string[] = [];

    // Build a map of variant availability from DB
    const itemMap = new Map<number, BundleItemRow>();
    for (const item of items) {
      itemMap.set(item.variant_external_id, item);
    }

    // Validate all selected variants are in the bundle pool
    for (const varId of body.selected_variant_ids) {
      if (!itemMap.has(varId)) {
        errors.push(`Variant ${varId} is not part of this bundle.`);
      }
    }

    // Validate availability for each selected variant
    for (const varId of body.selected_variant_ids) {
      const item = itemMap.get(varId);
      if (!item) continue;
      if (item.observed_availability === "deleted") {
        errors.push(`Variant ${varId} has been removed and is no longer available.`);
      } else if (item.observed_availability === "out_of_stock") {
        errors.push(`Variant ${varId} is currently out of stock.`);
      }
    }

    const selectedCount = body.selected_variant_ids.length;

    // Validate minimum tier threshold
    const sortedTiersAsc = [...tiers].sort((a, b) => a.minimum_item_count - b.minimum_item_count);
    const lowestMin = sortedTiersAsc.length > 0 ? sortedTiersAsc[0].minimum_item_count : 1;
    if (selectedCount < lowestMin) {
      errors.push(
        `You need at least ${lowestMin} item(s) to qualify for a discount. You have selected ${selectedCount}.`
      );
    }

    const { tier: earnedTier, discount_rate } = computeEarnedTier(selectedCount, tiers);

    const earnedTierDetail: WidgetEarnedTier | null = earnedTier
      ? {
          id: earnedTier.id,
          minimum_item_count: earnedTier.minimum_item_count,
          discount_rate: earnedTier.discount_rate,
          display_order: earnedTier.display_order,
        }
      : null;

    const response: WidgetValidateBundleResponse = {
      valid: errors.length === 0,
      earned_tier: earnedTierDetail,
      discount_rate,
      validation_errors: errors,
    };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "validate-bundle failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── POST /widget/cart/add ────────────────────────────────────────────────────

widgetRouter.post("/widget/cart/add", async (req: Request, res: Response) => {
  const body = req.body as WidgetCartAddRequest;
  if (
    !body.bundle_id ||
    !Array.isArray(body.selected_variant_ids) ||
    !Array.isArray(body.quantities)
  ) {
    res.status(400).json({ error: "bundle_id, selected_variant_ids, and quantities are required" });
    return;
  }

  try {
    const [bundle] = await sql<BundleRow[]>`
      SELECT * FROM bundles WHERE id = ${body.bundle_id}
    `;
    if (!bundle || !bundle.enabled) {
      const response: WidgetCartAddResponse = {
        success: false,
        cart_external_id: null,
        applied_discount_rate: 0,
        errors: ["Bundle is not available."],
      };
      res.status(400).json(response);
      return;
    }

    const items = await sql<BundleItemRow[]>`
      SELECT * FROM bundle_items WHERE bundle_id = ${body.bundle_id}
    `;

    const tiers = await sql<BundleTierRow[]>`
      SELECT * FROM bundle_tiers
      WHERE bundle_id = ${body.bundle_id}
      ORDER BY minimum_item_count DESC
    `;

    const errors: string[] = [];
    const itemMap = new Map<number, BundleItemRow>();
    for (const item of items) {
      itemMap.set(item.variant_external_id, item);
    }

    // Server-side validation (catches race conditions between widget render and confirm)
    for (const varId of body.selected_variant_ids) {
      if (!itemMap.has(varId)) {
        errors.push(`Variant ${varId} is not part of this bundle.`);
        continue;
      }
      const item = itemMap.get(varId)!;
      if (item.observed_availability === "deleted") {
        errors.push(`Variant ${varId} is no longer available (deleted).`);
      } else if (item.observed_availability === "out_of_stock") {
        errors.push(`Variant ${varId} is out of stock.`);
      }
    }

    const selectedCount = body.selected_variant_ids.length;
    const sortedTiersAsc = [...tiers].sort((a, b) => a.minimum_item_count - b.minimum_item_count);
    const lowestMin = sortedTiersAsc.length > 0 ? sortedTiersAsc[0].minimum_item_count : 1;
    if (selectedCount < lowestMin) {
      errors.push(`Selection does not meet minimum tier of ${lowestMin} items.`);
    }

    if (errors.length > 0) {
      const response: WidgetCartAddResponse = {
        success: false,
        cart_external_id: null,
        applied_discount_rate: 0,
        errors,
      };
      res.status(400).json(response);
      return;
    }

    const { discount_rate } = computeEarnedTier(selectedCount, tiers);

    // Return success with the earned discount rate
    // The actual Shopify cart mutation is done client-side via the Ajax API
    const response: WidgetCartAddResponse = {
      success: true,
      cart_external_id: null,
      applied_discount_rate: discount_rate,
      errors: [],
    };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "cart-add failed");
    res.status(500).json({ error: "internal_error" });
  }
});
