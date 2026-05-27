import { Request, Response } from "express";
import { sql } from "../lib/db.js";
import { shopifyClientFor } from "../lib/shopify.js";
import {
  BundleId,
  BundleRow,
  BundleItemRow,
  BundleTierRow,
  BundlePurchaseRecordRow,
  BundleHealthEventRow,
  BundleMode,
  BundleHealthStatus,
  ObservedAvailability,
  ListBundlesRequest,
  ListBundlesResponse,
  BundleSummary,
  CreateBundleRequest,
  CreateBundleResponse,
  UpdateBundleRequest,
  UpdateBundleResponse,
  RemoveBundleRequest,
  RemoveBundleResponse,
  CloneBundleRequest,
  CloneBundleResponse,
  BulkSetStatusRequest,
  BulkSetStatusResponse,
  ListBundleItemsRequest,
  ListBundleItemsResponse,
  BundleItemSummary,
  SaveBundleItemsRequest,
  SaveBundleItemsResponse,
  ListBundleTiersRequest,
  ListBundleTiersResponse,
  BundleTierSummary,
  SaveBundleTiersRequest,
  SaveBundleTiersResponse,
  ListPurchaseHistoryRequest,
  ListPurchaseHistoryResponse,
  PurchaseRecordSummary,
} from "../types/contracts.js";
import { evaluateBundleHealth, getBlockingVariants } from "../lib/bundle-health.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cursorToOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    return parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10);
  } catch {
    return 0;
  }
}

function offsetToCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64");
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function resolvePageSize(requested: number | undefined): number {
  if (!requested) return DEFAULT_PAGE_SIZE;
  return Math.min(requested, MAX_PAGE_SIZE);
}

// ─── Route handlers ───────────────────────────────────────────────────────────

// GET /admin/bundles
export async function listBundles(req: Request, res: Response): Promise<void> {
  const q = req.query as Record<string, string>;
  const statusFilter = (q.status_filter as string) || "all";
  const healthFilter = (q.health_filter as string) || "all";
  const cursor = q.cursor;
  const pageSize = resolvePageSize(q.page_size ? parseInt(q.page_size, 10) : undefined);
  const offset = cursorToOffset(cursor);

  let whereClause = sql`WHERE 1=1`;
  if (statusFilter === "enabled") {
    whereClause = sql`WHERE b.enabled = true`;
  } else if (statusFilter === "disabled") {
    whereClause = sql`WHERE b.enabled = false`;
  }

  const rows = await sql<
    (BundleRow & { tier_count: number; item_count: number })[]
  >`
    SELECT
      b.*,
      COUNT(DISTINCT bt.id)::int AS tier_count,
      COUNT(DISTINCT bi.id)::int AS item_count
    FROM bundles b
    LEFT JOIN bundle_tiers bt ON bt.bundle_id = b.id
    LEFT JOIN bundle_items bi ON bi.bundle_id = b.id
    ${whereClause}
    ${healthFilter !== "all" ? sql`AND b.health_status = ${healthFilter}` : sql``}
    GROUP BY b.id
    ORDER BY b.created_at DESC
    LIMIT ${pageSize + 1}
    OFFSET ${offset}
  `;

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

  const countRows = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM bundles b
    ${whereClause}
    ${healthFilter !== "all" ? sql`AND b.health_status = ${healthFilter}` : sql``}
  `;
  const totalCount = countRows[0]?.count ?? 0;

  const bundles: BundleSummary[] = pageRows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    mode: r.mode,
    enabled: r.enabled,
    health_status: r.health_status,
    tier_count: r.tier_count,
    item_count: r.item_count,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }));

  const response: ListBundlesResponse = {
    bundles,
    next_cursor: hasMore ? offsetToCursor(offset + pageSize) : null,
    total_count: totalCount,
  };

  res.json(response);
}

// POST /admin/bundles/create
export async function createBundle(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateBundleRequest;

  if (!body.title || typeof body.title !== "string" || body.title.trim() === "") {
    res.status(400).json({ error: "title is required" });
    return;
  }
  if (!body.mode || (body.mode !== "fixed" && body.mode !== "flexible")) {
    res.status(400).json({ error: "mode must be 'fixed' or 'flexible'" });
    return;
  }

  const [row] = await sql<{ id: BundleId }[]>`
    INSERT INTO bundles (title, description, mode, enabled, health_status)
    VALUES (
      ${body.title.trim()},
      ${body.description ?? null},
      ${body.mode},
      false,
      'healthy'
    )
    RETURNING id
  `;

  const response: CreateBundleResponse = {
    bundle_id: row.id,
    status: "created",
  };
  res.status(201).json(response);
}

// PUT /admin/bundles/update
export async function updateBundle(req: Request, res: Response): Promise<void> {
  const body = req.body as UpdateBundleRequest;

  if (!body.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const [existing] = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${body.bundle_id}
  `;
  if (!existing) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }

  // Block re-enabling if the bundle is auto-disabled due to unavailable variants
  if (body.enabled === true && existing.health_status === "auto_disabled") {
    const items = await sql<Pick<BundleItemRow, "variant_external_id" | "observed_availability">[]>`
      SELECT variant_external_id, observed_availability FROM bundle_items WHERE bundle_id = ${body.bundle_id}
    `;
    const blocking = getBlockingVariants(items);
    if (blocking.length > 0) {
      res.status(409).json({
        error: "Cannot enable bundle: it is auto-disabled due to unavailable variants.",
        blocking_variants: blocking,
      });
      return;
    }
  }

  const newTitle = body.title !== undefined ? body.title.trim() : existing.title;
  const newDescription = body.description !== undefined ? body.description : existing.description;
  const newMode = body.mode !== undefined ? body.mode : existing.mode;
  const newEnabled = body.enabled !== undefined ? body.enabled : existing.enabled;

  const [updated] = await sql<{ id: BundleId; updated_at: Date }[]>`
    UPDATE bundles
    SET title = ${newTitle},
        description = ${newDescription},
        mode = ${newMode},
        enabled = ${newEnabled},
        updated_at = now()
    WHERE id = ${body.bundle_id}
    RETURNING id, updated_at
  `;

  const response: UpdateBundleResponse = {
    bundle_id: updated.id,
    updated_at: updated.updated_at.toISOString(),
  };
  res.json(response);
}

// POST /admin/bundles/remove
export async function removeBundle(req: Request, res: Response): Promise<void> {
  const body = req.body as RemoveBundleRequest;

  if (!body.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const result = await sql`
    DELETE FROM bundles WHERE id = ${body.bundle_id}
  `;

  const response: RemoveBundleResponse = {
    success: (result as unknown as { count: number }).count > 0,
  };
  res.json(response);
}

// POST /admin/bundles/clone
export async function cloneBundle(req: Request, res: Response): Promise<void> {
  const body = req.body as CloneBundleRequest;

  if (!body.source_bundle_id) {
    res.status(400).json({ error: "source_bundle_id is required" });
    return;
  }

  const [source] = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${body.source_bundle_id}
  `;
  if (!source) {
    res.status(404).json({ error: "Source bundle not found" });
    return;
  }

  const sourceItems = await sql<BundleItemRow[]>`
    SELECT * FROM bundle_items WHERE bundle_id = ${body.source_bundle_id}
  `;
  const sourceTiers = await sql<BundleTierRow[]>`
    SELECT * FROM bundle_tiers WHERE bundle_id = ${body.source_bundle_id}
  `;

  let newBundleId: BundleId;

  await sql.begin(async (tx) => {
    const [newBundle] = await tx<{ id: BundleId }[]>`
      INSERT INTO bundles (title, description, mode, enabled, health_status)
      VALUES (
        ${"Copy of " + source.title},
        ${source.description},
        ${source.mode},
        false,
        'healthy'
      )
      RETURNING id
    `;
    newBundleId = newBundle.id;

    if (sourceItems.length > 0) {
      for (const item of sourceItems) {
        await tx`
          INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability)
          VALUES (${newBundleId!}, ${item.variant_external_id}, ${item.product_external_id}, 'available')
        `;
      }
    }

    if (sourceTiers.length > 0) {
      for (const tier of sourceTiers) {
        await tx`
          INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order)
          VALUES (${newBundleId!}, ${tier.minimum_item_count}, ${tier.discount_rate}, ${tier.display_order})
        `;
      }
    }
  });

  const response: CloneBundleResponse = {
    new_bundle_id: newBundleId!,
    status: "created",
  };
  res.status(201).json(response);
}

// POST /admin/bundles/bulk-status
export async function bulkSetStatus(req: Request, res: Response): Promise<void> {
  const body = req.body as BulkSetStatusRequest;

  if (!Array.isArray(body.bundle_ids) || body.bundle_ids.length === 0) {
    res.status(400).json({ error: "bundle_ids must be a non-empty array" });
    return;
  }
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }

  // If trying to enable, check for auto-disabled bundles
  let skippedCount = 0;
  let eligibleIds = body.bundle_ids as BundleId[];

  if (body.enabled) {
    const autoDisabled = await sql<{ id: BundleId }[]>`
      SELECT id FROM bundles
      WHERE id = ANY(${body.bundle_ids}::uuid[])
        AND health_status = 'auto_disabled'
    `;
    const blockedIds = new Set(autoDisabled.map((r) => r.id));
    eligibleIds = body.bundle_ids.filter((id) => !blockedIds.has(id as BundleId));
    skippedCount = blockedIds.size;
  }

  let updatedCount = 0;
  if (eligibleIds.length > 0) {
    const result = await sql`
      UPDATE bundles
      SET enabled = ${body.enabled}, updated_at = now()
      WHERE id = ANY(${eligibleIds}::uuid[])
    `;
    updatedCount = (result as unknown as { count: number }).count;
  }

  const response: BulkSetStatusResponse = {
    updated_count: updatedCount,
    skipped_count: skippedCount,
  };
  res.json(response);
}

// GET /admin/bundles/items
export async function listBundleItems(req: Request, res: Response): Promise<void> {
  const q = req.query as Record<string, string>;
  const bundleId = q.bundle_id as BundleId | undefined;

  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const pageSize = resolvePageSize(q.page_size ? parseInt(q.page_size, 10) : undefined);
  const offset = cursorToOffset(q.cursor);

  const rows = await sql<BundleItemRow[]>`
    SELECT * FROM bundle_items
    WHERE bundle_id = ${bundleId}
    ORDER BY added_at ASC
    LIMIT ${pageSize + 1}
    OFFSET ${offset}
  `;

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM bundle_items WHERE bundle_id = ${bundleId}
  `;

  const items: BundleItemSummary[] = pageRows.map((r) => ({
    id: r.id,
    bundle_id: r.bundle_id,
    variant_external_id: r.variant_external_id,
    product_external_id: r.product_external_id,
    observed_availability: r.observed_availability,
    added_at: r.added_at.toISOString(),
  }));

  const response: ListBundleItemsResponse = {
    items,
    next_cursor: hasMore ? offsetToCursor(offset + pageSize) : null,
    total_count: countRow?.count ?? 0,
  };
  res.json(response);
}

// POST /admin/bundles/items/save
export async function saveBundleItems(req: Request, res: Response): Promise<void> {
  const body = req.body as SaveBundleItemsRequest;

  if (!body.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  if (!Array.isArray(body.variant_product_pairs)) {
    res.status(400).json({ error: "variant_product_pairs must be an array" });
    return;
  }

  const [bundle] = await sql<Pick<BundleRow, "id">[]>`
    SELECT id FROM bundles WHERE id = ${body.bundle_id}
  `;
  if (!bundle) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }

  await sql.begin(async (tx) => {
    // Delete all existing items
    await tx`DELETE FROM bundle_items WHERE bundle_id = ${body.bundle_id}`;

    // Insert new items
    for (const pair of body.variant_product_pairs) {
      await tx`
        INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability)
        VALUES (${body.bundle_id}, ${pair.variant_external_id}, ${pair.product_external_id}, 'available')
        ON CONFLICT (bundle_id, variant_external_id) DO NOTHING
      `;
    }
  });

  const savedCount = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM bundle_items WHERE bundle_id = ${body.bundle_id}
  `;

  const response: SaveBundleItemsResponse = {
    saved_count: savedCount[0]?.count ?? 0,
    unavailable_variants: [],
  };
  res.json(response);
}

// GET /admin/bundles/tiers
export async function listBundleTiers(req: Request, res: Response): Promise<void> {
  const q = req.query as Record<string, string>;
  const bundleId = q.bundle_id as BundleId | undefined;

  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const pageSize = resolvePageSize(q.page_size ? parseInt(q.page_size, 10) : undefined);
  const offset = cursorToOffset(q.cursor);

  const rows = await sql<BundleTierRow[]>`
    SELECT * FROM bundle_tiers
    WHERE bundle_id = ${bundleId}
    ORDER BY display_order ASC
    LIMIT ${pageSize + 1}
    OFFSET ${offset}
  `;

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM bundle_tiers WHERE bundle_id = ${bundleId}
  `;

  const tiers: BundleTierSummary[] = pageRows.map((r) => ({
    id: r.id,
    bundle_id: r.bundle_id,
    minimum_item_count: r.minimum_item_count,
    discount_rate: r.discount_rate,
    display_order: r.display_order,
  }));

  const response: ListBundleTiersResponse = {
    tiers,
    next_cursor: hasMore ? offsetToCursor(offset + pageSize) : null,
    total_count: countRow?.count ?? 0,
  };
  res.json(response);
}

// POST /admin/bundles/tiers/save
export async function saveBundleTiers(req: Request, res: Response): Promise<void> {
  const body = req.body as SaveBundleTiersRequest;

  if (!body.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  if (!Array.isArray(body.tiers)) {
    res.status(400).json({ error: "tiers must be an array" });
    return;
  }

  const [bundle] = await sql<Pick<BundleRow, "id">[]>`
    SELECT id FROM bundles WHERE id = ${body.bundle_id}
  `;
  if (!bundle) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }

  await sql.begin(async (tx) => {
    await tx`DELETE FROM bundle_tiers WHERE bundle_id = ${body.bundle_id}`;

    for (let i = 0; i < body.tiers.length; i++) {
      const tier = body.tiers[i];
      await tx`
        INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order)
        VALUES (${body.bundle_id}, ${tier.minimum_item_count}, ${tier.discount_rate}, ${i})
        ON CONFLICT (bundle_id, minimum_item_count) DO UPDATE
          SET discount_rate = EXCLUDED.discount_rate,
              display_order = EXCLUDED.display_order,
              updated_at = now()
      `;
    }
  });

  const savedCount = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM bundle_tiers WHERE bundle_id = ${body.bundle_id}
  `;

  const response: SaveBundleTiersResponse = {
    saved_count: savedCount[0]?.count ?? 0,
  };
  res.json(response);
}

// GET /admin/purchase-history
export async function listPurchaseHistory(req: Request, res: Response): Promise<void> {
  const q = req.query as Record<string, string>;
  const bundleId = q.bundle_id as BundleId | undefined;
  const dateFrom = q.date_from;
  const dateTo = q.date_to;
  const pageSize = resolvePageSize(q.page_size ? parseInt(q.page_size, 10) : undefined);
  const offset = cursorToOffset(q.cursor);

  const rows = await sql<BundlePurchaseRecordRow[]>`
    SELECT * FROM bundle_purchase_records
    WHERE 1=1
    ${bundleId ? sql`AND bundle_id = ${bundleId}` : sql``}
    ${dateFrom ? sql`AND order_placed_at >= ${new Date(dateFrom)}` : sql``}
    ${dateTo ? sql`AND order_placed_at <= ${new Date(dateTo)}` : sql``}
    ORDER BY order_placed_at DESC
    LIMIT ${pageSize + 1}
    OFFSET ${offset}
  `;

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM bundle_purchase_records
    WHERE 1=1
    ${bundleId ? sql`AND bundle_id = ${bundleId}` : sql``}
    ${dateFrom ? sql`AND order_placed_at >= ${new Date(dateFrom)}` : sql``}
    ${dateTo ? sql`AND order_placed_at <= ${new Date(dateTo)}` : sql``}
  `;

  const records: PurchaseRecordSummary[] = pageRows.map((r) => ({
    id: r.id,
    bundle_id: r.bundle_id,
    order_external_id: r.order_external_id,
    order_placed_at: r.order_placed_at.toISOString(),
    variant_external_ids: JSON.parse(r.variant_external_ids) as number[],
    item_count: r.item_count,
    discount_rate_applied: r.discount_rate_applied,
    order_total: r.order_total,
    currency_code: r.currency_code,
    recorded_at: r.recorded_at.toISOString(),
  }));

  const response: ListPurchaseHistoryResponse = {
    records,
    next_cursor: hasMore ? offsetToCursor(offset + pageSize) : null,
    total_count: countRow?.count ?? 0,
  };
  res.json(response);
}

// ─── Router registration ─────────────────────────────────────────────────────

import { Router } from "express";
export const adminRouter = Router();

adminRouter.get("/admin/bundles", listBundles);
adminRouter.post("/admin/bundles/create", createBundle);
adminRouter.put("/admin/bundles/update", updateBundle);
adminRouter.post("/admin/bundles/remove", removeBundle);
adminRouter.post("/admin/bundles/clone", cloneBundle);
adminRouter.post("/admin/bundles/bulk-status", bulkSetStatus);
adminRouter.get("/admin/bundles/items", listBundleItems);
adminRouter.post("/admin/bundles/items/save", saveBundleItems);
adminRouter.get("/admin/bundles/tiers", listBundleTiers);
adminRouter.post("/admin/bundles/tiers/save", saveBundleTiers);
adminRouter.get("/admin/purchase-history", listPurchaseHistory);
