import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import type {
  BundleId,
  BundleMode,
  BundleHealthStatus,
  ObservedAvailability,
  VariantExternalId,
  BundleRow,
  BundleItemRow,
  BundleTierRow,
  BundlePurchaseRecordRow,
  BundleSummary,
  BundleItemSummary,
  BundleTierSummary,
  PurchaseRecordSummary,
  ListBundlesResponse,
  CreateBundleRequest,
  CreateBundleResponse,
  UpdateBundleRequest,
  UpdateBundleResponse,
  RemoveBundleRequest,
  RemoveBundleResponse,
  CloneBundleRequest,
  CloneBundleResponse,
  BulkStatusRequest,
  BulkStatusResponse,
  ListBundleItemsResponse,
  SaveBundleItemsRequest,
  SaveBundleItemsResponse,
  ListBundleTiersResponse,
  TierInput,
  SaveBundleTiersRequest,
  SaveBundleTiersResponse,
  ListPurchaseHistoryResponse,
} from "../types/contracts.js";

export const adminRouter = Router();

// ─── GET /admin/bundles ───────────────────────────────────────────────────────
adminRouter.get("/admin/bundles", async (req: Request, res: Response) => {
  const query = req.query as Record<string, string>;
  const statusFilter = (query.status_filter as string) ?? "all";
  const healthFilter = (query.health_filter as string) ?? "all";
  const cursor = query.cursor ?? null;
  const pageSize = Math.min(parseInt(query.page_size ?? "20", 10), 100);

  const conditions: string[] = [];
  if (statusFilter === "enabled") conditions.push("b.enabled = true");
  else if (statusFilter === "disabled") conditions.push("b.enabled = false");
  if (healthFilter !== "all") conditions.push(`b.health_status = '${healthFilter}'`);
  if (cursor) conditions.push(`b.created_at < '${cursor}'`);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRows = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM bundles b
    ${sql.unsafe(whereClause)}
  `;
  const totalCount = parseInt(countRows[0]?.count ?? "0", 10);

  const bundleRows = await sql<(BundleRow & { tier_count: string; item_count: string })[]>`
    SELECT
      b.id, b.title, b.description, b.mode, b.enabled, b.health_status,
      b.created_at, b.updated_at,
      (SELECT COUNT(*) FROM bundle_tiers t WHERE t.bundle_id = b.id)::text AS tier_count,
      (SELECT COUNT(*) FROM bundle_items i WHERE i.bundle_id = b.id)::text AS item_count
    FROM bundles b
    ${sql.unsafe(whereClause)}
    ORDER BY b.created_at DESC
    LIMIT ${pageSize + 1}
  `;

  let nextCursor: string | null = null;
  if (bundleRows.length > pageSize) {
    bundleRows.pop();
    const last = bundleRows[bundleRows.length - 1];
    if (last) nextCursor = last.created_at.toISOString();
  }

  const bundles: BundleSummary[] = bundleRows.map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description,
    mode: b.mode as BundleMode,
    enabled: b.enabled,
    health_status: b.health_status as BundleHealthStatus,
    tier_count: parseInt(b.tier_count, 10),
    item_count: parseInt(b.item_count, 10),
    created_at: b.created_at.toISOString(),
    updated_at: b.updated_at.toISOString(),
  }));

  const response: ListBundlesResponse = { bundles, next_cursor: nextCursor, total_count: totalCount };
  res.json(response);
});

// ─── POST /admin/bundles/create ───────────────────────────────────────────────
adminRouter.post("/admin/bundles/create", async (req: Request, res: Response) => {
  const body = req.body as CreateBundleRequest;

  if (!body.title || !body.mode) {
    res.status(400).json({ error: "title and mode are required" });
    return;
  }
  if (body.mode !== "fixed" && body.mode !== "flexible") {
    res.status(400).json({ error: "mode must be fixed or flexible" });
    return;
  }

  const rows = await sql<{ id: BundleId }[]>`
    INSERT INTO bundles (title, description, mode, enabled, health_status)
    VALUES (
      ${body.title},
      ${body.description ?? null},
      ${body.mode},
      false,
      'healthy'
    )
    RETURNING id
  `;

  const bundleId = rows[0]?.id;
  if (!bundleId) {
    res.status(500).json({ error: "failed to create bundle" });
    return;
  }

  console.log({ requestId: req.platform!.requestId, bundleId }, "bundle created");
  const response: CreateBundleResponse = { bundle_id: bundleId, status: "created" };
  res.status(201).json(response);
});

// ─── PUT /admin/bundles/update ────────────────────────────────────────────────
adminRouter.put("/admin/bundles/update", async (req: Request, res: Response) => {
  const body = req.body as UpdateBundleRequest;

  if (!body.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const [existing] = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${body.bundle_id}
  `;
  if (!existing) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  // Block re-enabling an auto-disabled bundle that still has blocking variants
  if (body.enabled === true && existing.health_status === "auto_disabled") {
    const blockers = await sql<{ variant_external_id: VariantExternalId }[]>`
      SELECT variant_external_id FROM bundle_items
      WHERE bundle_id = ${body.bundle_id}
        AND observed_availability != 'available'
    `;
    if (blockers.length > 0) {
      res.status(422).json({
        error: "Cannot enable bundle: blocking variants exist",
        blocking_variants: blockers.map((r) => r.variant_external_id),
      });
      return;
    }
  }

  const newTitle = body.title ?? existing.title;
  const newDescription = body.description !== undefined ? body.description : existing.description;
  const newMode = body.mode ?? existing.mode;
  const newEnabled = body.enabled !== undefined ? body.enabled : existing.enabled;

  const updatedRows = await sql<{ id: BundleId; updated_at: Date }[]>`
    UPDATE bundles
    SET
      title = ${newTitle},
      description = ${newDescription},
      mode = ${newMode},
      enabled = ${newEnabled},
      updated_at = now()
    WHERE id = ${body.bundle_id}
    RETURNING id, updated_at
  `;

  const updated = updatedRows[0];
  if (!updated) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  const response: UpdateBundleResponse = {
    bundle_id: updated.id,
    updated_at: updated.updated_at.toISOString(),
  };
  res.json(response);
});

// ─── POST /admin/bundles/remove ───────────────────────────────────────────────
adminRouter.post("/admin/bundles/remove", async (req: Request, res: Response) => {
  const body = req.body as RemoveBundleRequest;

  if (!body.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const result = await sql`
    DELETE FROM bundles WHERE id = ${body.bundle_id}
  `;
  const deleted = (result as unknown as { count: number }).count > 0;

  const response: RemoveBundleResponse = { success: deleted };
  res.json(response);
});

// ─── POST /admin/bundles/clone ────────────────────────────────────────────────
adminRouter.post("/admin/bundles/clone", async (req: Request, res: Response) => {
  const body = req.body as CloneBundleRequest;

  if (!body.source_bundle_id) {
    res.status(400).json({ error: "source_bundle_id is required" });
    return;
  }

  const [source] = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${body.source_bundle_id}
  `;
  if (!source) {
    res.status(404).json({ error: "source bundle not found" });
    return;
  }

  let newBundleId!: BundleId;

  await sql.begin(async (tx) => {
    const newBundleRows = await tx<{ id: BundleId }[]>`
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
    const newBundle = newBundleRows[0];
    if (!newBundle) throw new Error("failed to insert cloned bundle");
    newBundleId = newBundle.id;

    // Clone items, resetting availability to available
    await tx`
      INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability)
      SELECT ${newBundleId}, variant_external_id, product_external_id, 'available'
      FROM bundle_items
      WHERE bundle_id = ${body.source_bundle_id}
    `;

    // Clone tiers
    await tx`
      INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order)
      SELECT ${newBundleId}, minimum_item_count, discount_rate, display_order
      FROM bundle_tiers
      WHERE bundle_id = ${body.source_bundle_id}
      ORDER BY display_order ASC
    `;
  });

  console.log(
    { requestId: req.platform!.requestId, sourceBundleId: body.source_bundle_id, newBundleId },
    "bundle cloned"
  );
  const response: CloneBundleResponse = { new_bundle_id: newBundleId, status: "created" };
  res.status(201).json(response);
});

// ─── POST /admin/bundles/bulk-status ─────────────────────────────────────────
adminRouter.post("/admin/bundles/bulk-status", async (req: Request, res: Response) => {
  const body = req.body as BulkStatusRequest;

  if (!Array.isArray(body.bundle_ids) || body.bundle_ids.length === 0) {
    res.status(400).json({ error: "bundle_ids must be a non-empty array" });
    return;
  }
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }

  if (body.enabled) {
    // When enabling, exclude auto-disabled bundles with blocking variants
    const result = await sql<{ id: BundleId }[]>`
      UPDATE bundles
      SET enabled = true, updated_at = now()
      WHERE id = ANY(${body.bundle_ids}::uuid[])
        AND NOT (
          health_status = 'auto_disabled'
          AND EXISTS (
            SELECT 1 FROM bundle_items bi
            WHERE bi.bundle_id = bundles.id
              AND bi.observed_availability != 'available'
          )
        )
      RETURNING id
    `;
    const updatedCount = result.length;
    const skippedCount = body.bundle_ids.length - updatedCount;
    const response: BulkStatusResponse = { updated_count: updatedCount, skipped_count: skippedCount };
    res.json(response);
  } else {
    const result = await sql<{ id: BundleId }[]>`
      UPDATE bundles
      SET enabled = false, updated_at = now()
      WHERE id = ANY(${body.bundle_ids}::uuid[])
      RETURNING id
    `;
    const response: BulkStatusResponse = {
      updated_count: result.length,
      skipped_count: body.bundle_ids.length - result.length,
    };
    res.json(response);
  }
});

// ─── GET /admin/bundles/items ─────────────────────────────────────────────────
adminRouter.get("/admin/bundles/items", async (req: Request, res: Response) => {
  const query = req.query as Record<string, string>;
  const bundleId = query.bundle_id as BundleId | undefined;

  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const cursor = query.cursor ?? null;
  const pageSize = Math.min(parseInt(query.page_size ?? "20", 10), 100);

  const cursorClause = cursor ? sql`AND i.added_at < ${new Date(cursor)}` : sql``;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM bundle_items i
    WHERE i.bundle_id = ${bundleId}
  `;
  const totalCount = parseInt(countRow?.count ?? "0", 10);

  const rows = await sql<BundleItemRow[]>`
    SELECT id, bundle_id, variant_external_id, product_external_id, observed_availability, added_at
    FROM bundle_items i
    WHERE i.bundle_id = ${bundleId}
    ${cursorClause}
    ORDER BY i.added_at ASC
    LIMIT ${pageSize + 1}
  `;

  let nextCursor: string | null = null;
  if (rows.length > pageSize) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last) nextCursor = last.added_at.toISOString();
  }

  const items: BundleItemSummary[] = rows.map((r) => ({
    id: r.id,
    bundle_id: r.bundle_id,
    variant_external_id: r.variant_external_id,
    product_external_id: r.product_external_id,
    observed_availability: r.observed_availability,
    added_at: r.added_at.toISOString(),
  }));

  const response: ListBundleItemsResponse = { items, next_cursor: nextCursor, total_count: totalCount };
  res.json(response);
});

// ─── POST /admin/bundles/items/save ──────────────────────────────────────────
adminRouter.post("/admin/bundles/items/save", async (req: Request, res: Response) => {
  const body = req.body as SaveBundleItemsRequest;

  if (!body.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  if (!Array.isArray(body.variant_external_ids) || !Array.isArray(body.product_external_ids)) {
    res.status(400).json({ error: "variant_external_ids and product_external_ids must be arrays" });
    return;
  }
  if (body.variant_external_ids.length !== body.product_external_ids.length) {
    res.status(400).json({ error: "variant_external_ids and product_external_ids must have the same length" });
    return;
  }

  const [bundle] = await sql<{ id: BundleId }[]>`
    SELECT id FROM bundles WHERE id = ${body.bundle_id}
  `;
  if (!bundle) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  await sql.begin(async (tx) => {
    await tx`DELETE FROM bundle_items WHERE bundle_id = ${body.bundle_id}`;

    if (body.variant_external_ids.length > 0) {
      const insertValues = body.variant_external_ids.map((vid, i) => ({
        bundle_id: body.bundle_id,
        variant_external_id: vid,
        product_external_id: body.product_external_ids[i],
        observed_availability: "available" as ObservedAvailability,
      }));
      await tx`
        INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability)
        SELECT * FROM ${tx(insertValues, "bundle_id", "variant_external_id", "product_external_id", "observed_availability")}
        ON CONFLICT (bundle_id, variant_external_id) DO NOTHING
      `;
    }

    await tx`
      UPDATE bundles SET health_status = 'healthy', updated_at = now()
      WHERE id = ${body.bundle_id}
    `;
  });

  const [savedCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM bundle_items WHERE bundle_id = ${body.bundle_id}
  `;

  const response: SaveBundleItemsResponse = {
    saved_count: parseInt(savedCount?.count ?? "0", 10),
    unavailable_variants: [],
  };
  res.json(response);
});

// ─── GET /admin/bundles/tiers ─────────────────────────────────────────────────
adminRouter.get("/admin/bundles/tiers", async (req: Request, res: Response) => {
  const query = req.query as Record<string, string>;
  const bundleId = query.bundle_id as BundleId | undefined;

  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const cursor = query.cursor ?? null;
  const pageSize = Math.min(parseInt(query.page_size ?? "50", 10), 200);
  const cursorClause = cursor ? sql`AND t.display_order > ${parseInt(cursor, 10)}` : sql``;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM bundle_tiers t
    WHERE t.bundle_id = ${bundleId}
  `;
  const totalCount = parseInt(countRow?.count ?? "0", 10);

  const rows = await sql<BundleTierRow[]>`
    SELECT id, bundle_id, minimum_item_count, discount_rate, display_order, created_at, updated_at
    FROM bundle_tiers t
    WHERE t.bundle_id = ${bundleId}
    ${cursorClause}
    ORDER BY t.display_order ASC
    LIMIT ${pageSize + 1}
  `;

  let nextCursor: string | null = null;
  if (rows.length > pageSize) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last) nextCursor = String(last.display_order);
  }

  const tiers: BundleTierSummary[] = rows.map((r) => ({
    id: r.id,
    bundle_id: r.bundle_id,
    minimum_item_count: r.minimum_item_count,
    discount_rate: r.discount_rate,
    display_order: r.display_order,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }));

  const response: ListBundleTiersResponse = { tiers, next_cursor: nextCursor, total_count: totalCount };
  res.json(response);
});

// ─── POST /admin/bundles/tiers/save ──────────────────────────────────────────
adminRouter.post("/admin/bundles/tiers/save", async (req: Request, res: Response) => {
  const body = req.body as SaveBundleTiersRequest;

  if (!body.bundle_id) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  if (!Array.isArray(body.tiers)) {
    res.status(400).json({ error: "tiers must be an array" });
    return;
  }

  const [bundle] = await sql<{ id: BundleId }[]>`
    SELECT id FROM bundles WHERE id = ${body.bundle_id}
  `;
  if (!bundle) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  await sql.begin(async (tx) => {
    await tx`DELETE FROM bundle_tiers WHERE bundle_id = ${body.bundle_id}`;

    if (body.tiers.length > 0) {
      const insertValues = body.tiers.map((tier: TierInput, idx: number) => ({
        bundle_id: body.bundle_id,
        minimum_item_count: tier.minimum_item_count,
        discount_rate: tier.discount_rate,
        display_order: idx,
      }));
      await tx`
        INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order)
        SELECT * FROM ${tx(insertValues, "bundle_id", "minimum_item_count", "discount_rate", "display_order")}
        ON CONFLICT (bundle_id, minimum_item_count) DO UPDATE
          SET discount_rate = EXCLUDED.discount_rate,
              display_order = EXCLUDED.display_order,
              updated_at = now()
      `;
    }

    await tx`UPDATE bundles SET updated_at = now() WHERE id = ${body.bundle_id}`;
  });

  const [savedCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM bundle_tiers WHERE bundle_id = ${body.bundle_id}
  `;

  const response: SaveBundleTiersResponse = { saved_count: parseInt(savedCount?.count ?? "0", 10) };
  res.json(response);
});

// ─── GET /admin/purchase-history ─────────────────────────────────────────────
adminRouter.get("/admin/purchase-history", async (req: Request, res: Response) => {
  const query = req.query as Record<string, string>;
  const bundleId = (query.bundle_id as BundleId) ?? null;
  const dateFrom = query.date_from ?? null;
  const dateTo = query.date_to ?? null;
  const cursor = query.cursor ?? null;
  const pageSize = Math.min(parseInt(query.page_size ?? "20", 10), 100);

  const conditions: ReturnType<typeof sql>[] = [];
  if (bundleId) conditions.push(sql`pr.bundle_id = ${bundleId}`);
  if (dateFrom) conditions.push(sql`pr.order_placed_at >= ${new Date(dateFrom)}`);
  if (dateTo) conditions.push(sql`pr.order_placed_at <= ${new Date(dateTo)}`);
  if (cursor) conditions.push(sql`pr.order_placed_at < ${new Date(cursor)}`);

  const whereClause =
    conditions.length > 0
      ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
      : sql``;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM bundle_purchase_records pr ${whereClause}
  `;
  const totalCount = parseInt(countRow?.count ?? "0", 10);

  const rows = await sql<(BundlePurchaseRecordRow & { bundle_title: string })[]>`
    SELECT
      pr.id, pr.bundle_id, pr.order_external_id, pr.order_placed_at,
      pr.variant_external_ids, pr.item_count, pr.discount_rate_applied,
      pr.order_total, pr.currency_code, pr.recorded_at,
      b.title AS bundle_title
    FROM bundle_purchase_records pr
    JOIN bundles b ON b.id = pr.bundle_id
    ${whereClause}
    ORDER BY pr.order_placed_at DESC
    LIMIT ${pageSize + 1}
  `;

  let nextCursor: string | null = null;
  if (rows.length > pageSize) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last) nextCursor = last.order_placed_at.toISOString();
  }

  const records: PurchaseRecordSummary[] = rows.map((r) => ({
    id: r.id,
    bundle_id: r.bundle_id,
    bundle_title: r.bundle_title,
    order_external_id: r.order_external_id,
    order_placed_at: r.order_placed_at.toISOString(),
    variant_external_ids: r.variant_external_ids,
    item_count: r.item_count,
    discount_rate_applied: r.discount_rate_applied,
    order_total: r.order_total,
    currency_code: r.currency_code,
    recorded_at: r.recorded_at.toISOString(),
  }));

  const response: ListPurchaseHistoryResponse = { records, next_cursor: nextCursor, total_count: totalCount };
  res.json(response);
});
