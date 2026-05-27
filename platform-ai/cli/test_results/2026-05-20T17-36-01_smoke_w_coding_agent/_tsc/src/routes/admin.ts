import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import type {
  BundleId,
  BundleRow,
  BundleItemRow,
  BundleTierRow,
  BundlePurchaseRecordRow,
  AdminListBundlesRequest,
  AdminListBundlesResponse,
  AdminBundleSummary,
  AdminCreateBundleRequest,
  AdminCreateBundleResponse,
  AdminUpdateBundleRequest,
  AdminUpdateBundleResponse,
  AdminRemoveBundleRequest,
  AdminRemoveBundleResponse,
  AdminCloneBundleRequest,
  AdminCloneBundleResponse,
  AdminBulkStatusRequest,
  AdminBulkStatusResponse,
  AdminListBundleItemsRequest,
  AdminListBundleItemsResponse,
  AdminBundleItemSummary,
  AdminSaveBundleItemsRequest,
  AdminSaveBundleItemsResponse,
  AdminListBundleTiersRequest,
  AdminListBundleTiersResponse,
  AdminBundleTierSummary,
  AdminSaveBundleTiersRequest,
  AdminSaveBundleTiersResponse,
  AdminPurchaseHistoryRequest,
  AdminPurchaseHistoryResponse,
  AdminPurchaseRecordSummary,
  BundleMode,
  TierInput,
} from "../types/contracts.js";

export const adminRouter = Router();

// ─── Cursor helpers ───────────────────────────────────────────────────────────

function encodeCursor(ts: Date, id: string): string {
  return Buffer.from(JSON.stringify({ created_at: ts.toISOString(), id })).toString("base64url");
}

function decodeCursor(cursor: string): { created_at: string; id: string } | null {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString()) as { created_at: string; id: string };
  } catch {
    return null;
  }
}

// ─── GET /admin/bundles ───────────────────────────────────────────────────────

adminRouter.get("/admin/bundles", async (req: Request, res: Response) => {
  const query = req.query as AdminListBundlesRequest;
  const pageSize = Math.min(Number(query.page_size) || 20, 100);
  const statusFilter = query.status_filter ?? "all";
  const healthFilter = query.health_filter ?? "all";
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  try {
    const enabledCondition =
      statusFilter === "enabled"
        ? sql`AND b.enabled = true`
        : statusFilter === "disabled"
        ? sql`AND b.enabled = false`
        : sql``;

    const healthCondition =
      healthFilter !== "all"
        ? sql`AND b.health_status = ${healthFilter}`
        : sql``;

    const cursorCondition = cursor
      ? sql`AND (b.created_at, b.id::text) < (${cursor.created_at}::timestamptz, ${cursor.id})`
      : sql``;

    const rows = await sql<
      (BundleRow & { tier_count: number; item_count: number })[]
    >`
      SELECT
        b.*,
        COALESCE(tc.cnt, 0)::int AS tier_count,
        COALESCE(ic.cnt, 0)::int AS item_count
      FROM bundles b
      LEFT JOIN (
        SELECT bundle_id, COUNT(*)::int AS cnt FROM bundle_tiers GROUP BY bundle_id
      ) tc ON tc.bundle_id = b.id
      LEFT JOIN (
        SELECT bundle_id, COUNT(*)::int AS cnt FROM bundle_items GROUP BY bundle_id
      ) ic ON ic.bundle_id = b.id
      WHERE 1=1
        ${enabledCondition}
        ${healthCondition}
        ${cursorCondition}
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ${pageSize + 1}
    `;

    const [countRow] = await sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM bundles b
      WHERE 1=1
        ${enabledCondition}
        ${healthCondition}
    `;

    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor =
      hasMore
        ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id)
        : null;

    const bundles: AdminBundleSummary[] = page.map((r) => ({
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

    const response: AdminListBundlesResponse = {
      bundles,
      next_cursor: nextCursor,
      total_count: countRow.total,
    };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "list-bundles failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── POST /admin/bundles/create ───────────────────────────────────────────────

adminRouter.post("/admin/bundles/create", async (req: Request, res: Response) => {
  const body = req.body as AdminCreateBundleRequest;
  if (!body.title || !body.mode) {
    res.status(400).json({ error: "title and mode are required" });
    return;
  }
  if (body.mode !== "fixed" && body.mode !== "flexible") {
    res.status(400).json({ error: "mode must be fixed or flexible" });
    return;
  }

  try {
    const [row] = await sql<{ id: BundleId }[]>`
      INSERT INTO bundles (title, description, mode, enabled, health_status)
      VALUES (
        ${body.title},
        ${body.description ?? null},
        ${body.mode as string},
        false,
        'healthy'
      )
      RETURNING id
    `;
    const response: AdminCreateBundleResponse = { bundle_id: row.id, status: "created" };
    res.status(201).json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "create-bundle failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── PUT /admin/bundles/update ────────────────────────────────────────────────

adminRouter.put("/admin/bundles/update", async (req: Request, res: Response) => {
  const body = req.body as AdminUpdateBundleRequest;
  if (!body.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  try {
    // Fetch current bundle
    const [existing] = await sql<BundleRow[]>`
      SELECT * FROM bundles WHERE id = ${body.bundle_id}
    `;
    if (!existing) {
      res.status(404).json({ error: "bundle_not_found" });
      return;
    }

    // Guard: block re-enabling an auto-disabled bundle with still-blocking items
    if (body.enabled === true && existing.health_status === "auto_disabled") {
      const blockingItems = await sql<{ variant_external_id: number }[]>`
        SELECT variant_external_id
        FROM bundle_items
        WHERE bundle_id = ${body.bundle_id}
          AND observed_availability IN ('out_of_stock', 'deleted')
      `;
      if (blockingItems.length > 0) {
        res.status(409).json({
          error: "cannot_enable_auto_disabled_bundle",
          blocking_variant_ids: blockingItems.map((r) => r.variant_external_id),
        });
        return;
      }
    }

    // Merge fields
    const newTitle = body.title !== undefined ? body.title : existing.title;
    const newDescription = body.description !== undefined ? body.description : existing.description;
    const newMode: BundleMode = body.mode !== undefined ? body.mode : existing.mode;
    const newEnabled = body.enabled !== undefined ? body.enabled : existing.enabled;

    const [updated] = await sql<{ id: BundleId; updated_at: Date }[]>`
      UPDATE bundles
      SET
        title       = ${newTitle},
        description = ${newDescription},
        mode        = ${newMode as string},
        enabled     = ${newEnabled},
        updated_at  = now()
      WHERE id = ${body.bundle_id}
      RETURNING id, updated_at
    `;

    const response: AdminUpdateBundleResponse = {
      bundle_id: updated.id,
      updated_at: updated.updated_at.toISOString(),
    };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "update-bundle failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── POST /admin/bundles/remove ───────────────────────────────────────────────

adminRouter.post("/admin/bundles/remove", async (req: Request, res: Response) => {
  const body = req.body as AdminRemoveBundleRequest;
  if (!body.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  try {
    const deleted = await sql<{ id: BundleId }[]>`
      DELETE FROM bundles WHERE id = ${body.bundle_id} RETURNING id
    `;
    const response: AdminRemoveBundleResponse = { success: deleted.length > 0 };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "remove-bundle failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── POST /admin/bundles/clone ────────────────────────────────────────────────

adminRouter.post("/admin/bundles/clone", async (req: Request, res: Response) => {
  const body = req.body as AdminCloneBundleRequest;
  if (!body.source_bundle_id) {
    res.status(400).json({ error: "source_bundle_id is required" });
    return;
  }

  try {
    const newBundleId = await sql.begin(async (tx) => {
      const [source] = await tx<BundleRow[]>`
        SELECT * FROM bundles WHERE id = ${body.source_bundle_id}
      `;
      if (!source) throw new Error("source_bundle_not_found");

      const [newBundle] = await tx<{ id: BundleId }[]>`
        INSERT INTO bundles (title, description, mode, enabled, health_status)
        VALUES (
          ${`${source.title} (Copy)`},
          ${source.description},
          ${source.mode as string},
          false,
          'healthy'
        )
        RETURNING id
      `;

      // Clone items (reset availability to available)
      await tx`
        INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability)
        SELECT ${newBundle.id}::uuid, variant_external_id, product_external_id, 'available'
        FROM bundle_items
        WHERE bundle_id = ${body.source_bundle_id}
      `;

      // Clone tiers
      await tx`
        INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order)
        SELECT ${newBundle.id}::uuid, minimum_item_count, discount_rate, display_order
        FROM bundle_tiers
        WHERE bundle_id = ${body.source_bundle_id}
        ORDER BY display_order
      `;

      return newBundle.id;
    });

    const response: AdminCloneBundleResponse = {
      new_bundle_id: newBundleId,
      status: "created",
    };
    res.status(201).json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "source_bundle_not_found") {
      res.status(404).json({ error: "source_bundle_not_found" });
      return;
    }
    console.error({ requestId: req.platform!.requestId, err: msg }, "clone-bundle failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── POST /admin/bundles/bulk-status ─────────────────────────────────────────

adminRouter.post("/admin/bundles/bulk-status", async (req: Request, res: Response) => {
  const body = req.body as AdminBulkStatusRequest;
  if (!Array.isArray(body.bundle_ids) || body.bundle_ids.length === 0) {
    res.status(400).json({ error: "bundle_ids must be a non-empty array" });
    return;
  }
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }

  try {
    let updatedCount = 0;
    let skippedCount = 0;
    const idStrings = body.bundle_ids as string[];

    if (body.enabled) {
      // Find auto-disabled bundles with still-blocking items
      const blockedBundles = await sql<{ bundle_id: string }[]>`
        SELECT DISTINCT bi.bundle_id::text AS bundle_id
        FROM bundle_items bi
        JOIN bundles b ON b.id = bi.bundle_id
        WHERE bi.bundle_id = ANY(${idStrings}::uuid[])
          AND b.health_status = 'auto_disabled'
          AND bi.observed_availability IN ('out_of_stock', 'deleted')
      `;
      const blockedSet = new Set(blockedBundles.map((r) => r.bundle_id));
      const eligibleIds = idStrings.filter((id) => !blockedSet.has(id));
      skippedCount = blockedSet.size;

      if (eligibleIds.length > 0) {
        const updated = await sql<{ id: string }[]>`
          UPDATE bundles
          SET enabled = true, updated_at = now()
          WHERE id = ANY(${eligibleIds}::uuid[])
            AND enabled = false
          RETURNING id
        `;
        updatedCount = updated.length;
      }
    } else {
      const updated = await sql<{ id: string }[]>`
        UPDATE bundles
        SET enabled = false, updated_at = now()
        WHERE id = ANY(${idStrings}::uuid[])
          AND enabled = true
        RETURNING id
      `;
      updatedCount = updated.length;
      skippedCount = idStrings.length - updatedCount;
    }

    const response: AdminBulkStatusResponse = {
      updated_count: updatedCount,
      skipped_count: skippedCount,
    };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "bulk-status failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── GET /admin/bundles/items ─────────────────────────────────────────────────

adminRouter.get("/admin/bundles/items", async (req: Request, res: Response) => {
  const query = req.query as AdminListBundleItemsRequest;
  if (!query.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const pageSize = Math.min(Number(query.page_size) || 50, 200);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  try {
    const cursorCondition = cursor
      ? sql`AND (bi.added_at, bi.id::text) < (${cursor.created_at}::timestamptz, ${cursor.id})`
      : sql``;

    const rows = await sql<BundleItemRow[]>`
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

    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor =
      hasMore ? encodeCursor(page[page.length - 1].added_at, page[page.length - 1].id) : null;

    const items: AdminBundleItemSummary[] = page.map((r) => ({
      id: r.id,
      bundle_id: r.bundle_id,
      variant_external_id: r.variant_external_id,
      product_external_id: r.product_external_id,
      observed_availability: r.observed_availability,
      added_at: r.added_at.toISOString(),
    }));

    const response: AdminListBundleItemsResponse = {
      items,
      next_cursor: nextCursor,
      total_count: countRow.total,
    };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "list-bundle-items failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── POST /admin/bundles/items/save ──────────────────────────────────────────

adminRouter.post("/admin/bundles/items/save", async (req: Request, res: Response) => {
  const body = req.body as AdminSaveBundleItemsRequest;
  if (!body.bundle_id || !Array.isArray(body.variant_items)) {
    res.status(400).json({ error: "bundle_id and variant_items are required" });
    return;
  }

  try {
    let savedCount = 0;

    await sql.begin(async (tx) => {
      const [bundle] = await tx<{ id: BundleId }[]>`
        SELECT id FROM bundles WHERE id = ${body.bundle_id}
      `;
      if (!bundle) throw new Error("bundle_not_found");

      // Replace all items
      await tx`DELETE FROM bundle_items WHERE bundle_id = ${body.bundle_id}`;

      for (const item of body.variant_items) {
        await tx`
          INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability)
          VALUES (${body.bundle_id}, ${item.variant_external_id}, ${item.product_external_id}, 'available')
          ON CONFLICT (bundle_id, variant_external_id) DO NOTHING
        `;
        savedCount++;
      }
    });

    const response: AdminSaveBundleItemsResponse = {
      saved_count: savedCount,
      unavailable_variants: [],
    };
    res.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "bundle_not_found") {
      res.status(404).json({ error: "bundle_not_found" });
      return;
    }
    console.error({ requestId: req.platform!.requestId, err: msg }, "save-bundle-items failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── GET /admin/bundles/tiers ─────────────────────────────────────────────────

adminRouter.get("/admin/bundles/tiers", async (req: Request, res: Response) => {
  const query = req.query as AdminListBundleTiersRequest;
  if (!query.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  try {
    const rows = await sql<BundleTierRow[]>`
      SELECT * FROM bundle_tiers
      WHERE bundle_id = ${query.bundle_id}
      ORDER BY display_order ASC
    `;

    const [countRow] = await sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total FROM bundle_tiers WHERE bundle_id = ${query.bundle_id}
    `;

    const tiers: AdminBundleTierSummary[] = rows.map((r) => ({
      id: r.id,
      bundle_id: r.bundle_id,
      minimum_item_count: r.minimum_item_count,
      discount_rate: r.discount_rate,
      display_order: r.display_order,
    }));

    const response: AdminListBundleTiersResponse = {
      tiers,
      next_cursor: null,
      total_count: countRow.total,
    };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "list-bundle-tiers failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── POST /admin/bundles/tiers/save ──────────────────────────────────────────

adminRouter.post("/admin/bundles/tiers/save", async (req: Request, res: Response) => {
  const body = req.body as AdminSaveBundleTiersRequest;
  if (!body.bundle_id || !Array.isArray(body.tiers)) {
    res.status(400).json({ error: "bundle_id and tiers are required" });
    return;
  }

  for (const tier of body.tiers) {
    if (typeof tier.minimum_item_count !== "number" || tier.minimum_item_count < 1) {
      res.status(400).json({ error: "each tier must have a positive minimum_item_count" });
      return;
    }
    if (typeof tier.discount_rate !== "number" || tier.discount_rate < 0 || tier.discount_rate > 10000) {
      res.status(400).json({ error: "discount_rate must be 0-10000 basis points" });
      return;
    }
  }

  try {
    await sql.begin(async (tx) => {
      const [bundle] = await tx<{ id: BundleId }[]>`
        SELECT id FROM bundles WHERE id = ${body.bundle_id}
      `;
      if (!bundle) throw new Error("bundle_not_found");

      await tx`DELETE FROM bundle_tiers WHERE bundle_id = ${body.bundle_id}`;

      for (let i = 0; i < body.tiers.length; i++) {
        const tier = body.tiers[i] as TierInput;
        await tx`
          INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order)
          VALUES (${body.bundle_id}, ${tier.minimum_item_count}, ${tier.discount_rate}, ${i + 1})
        `;
      }
    });

    const response: AdminSaveBundleTiersResponse = { saved_count: body.tiers.length };
    res.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "bundle_not_found") {
      res.status(404).json({ error: "bundle_not_found" });
      return;
    }
    console.error({ requestId: req.platform!.requestId, err: msg }, "save-bundle-tiers failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// ─── GET /admin/purchase-history ─────────────────────────────────────────────

adminRouter.get("/admin/purchase-history", async (req: Request, res: Response) => {
  const query = req.query as AdminPurchaseHistoryRequest;
  const pageSize = Math.min(Number(query.page_size) || 50, 500);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  try {
    const bundleCondition = query.bundle_id
      ? sql`AND pr.bundle_id = ${query.bundle_id}`
      : sql``;

    const dateFromCondition = query.date_from
      ? sql`AND pr.order_placed_at >= ${query.date_from}::timestamptz`
      : sql``;

    const dateToCondition = query.date_to
      ? sql`AND pr.order_placed_at <= ${query.date_to}::timestamptz`
      : sql``;

    const cursorCondition = cursor
      ? sql`AND (pr.order_placed_at, pr.id::text) < (${cursor.created_at}::timestamptz, ${cursor.id})`
      : sql``;

    const rows = await sql<BundlePurchaseRecordRow[]>`
      SELECT pr.*
      FROM bundle_purchase_records pr
      WHERE 1=1
        ${bundleCondition}
        ${dateFromCondition}
        ${dateToCondition}
        ${cursorCondition}
      ORDER BY pr.order_placed_at DESC, pr.id DESC
      LIMIT ${pageSize + 1}
    `;

    const [countRow] = await sql<{ total: number }[]>`
      SELECT COUNT(*)::int AS total
      FROM bundle_purchase_records pr
      WHERE 1=1
        ${bundleCondition}
        ${dateFromCondition}
        ${dateToCondition}
    `;

    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor =
      hasMore
        ? encodeCursor(page[page.length - 1].order_placed_at, page[page.length - 1].id)
        : null;

    const records: AdminPurchaseRecordSummary[] = page.map((r) => ({
      id: r.id,
      bundle_id: r.bundle_id,
      order_external_id: r.order_external_id,
      order_placed_at: r.order_placed_at.toISOString(),
      variant_external_ids: JSON.parse(r.variant_external_ids) as number[],
      item_count: r.item_count,
      discount_rate_applied: r.discount_rate_applied,
      order_total: r.order_total,
      order_currency: r.order_currency,
      recorded_at: r.recorded_at.toISOString(),
    }));

    const response: AdminPurchaseHistoryResponse = {
      records,
      next_cursor: nextCursor,
      total_count: countRow.total,
    };
    res.json(response);
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "purchase-history failed");
    res.status(500).json({ error: "internal_error" });
  }
});
