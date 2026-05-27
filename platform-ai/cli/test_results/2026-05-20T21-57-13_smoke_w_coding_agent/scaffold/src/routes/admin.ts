import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import { checkEnableBlockers } from "../lib/bundle-health.js";
import type {
  BundleId,
  BundleItemId,
  BundleTierId,
  VariantExternalId,
  ProductExternalId,
  BundleMode,
  BundleRow,
  BundleItemRow,
  BundleTierRow,
  BundlePurchaseRecordRow,
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
  ListBundleItemsResponse,
  BundleItemSummary,
  SaveBundleItemsRequest,
  SaveBundleItemsResponse,
  ListBundleTiersResponse,
  BundleTierSummary,
  TierInput,
  SaveBundleTiersRequest,
  SaveBundleTiersResponse,
  ListPurchaseHistoryResponse,
  PurchaseRecordSummary,
  OrderExternalId,
} from "../types/contracts.js";

export const adminRouter = Router();

// ─── GET /admin/bundles ────────────────────────────────────────────────────────
adminRouter.get("/admin/bundles", async (req: Request, res: Response) => {
  const statusFilter =
    typeof req.query.status_filter === "string" ? req.query.status_filter : "all";
  const healthFilter =
    typeof req.query.health_filter === "string" ? req.query.health_filter : null;
  const cursor =
    typeof req.query.cursor === "string" ? req.query.cursor : null;

  const PAGE_SIZE = 50;

  const enabledFilter: boolean | null =
    statusFilter === "enabled"
      ? true
      : statusFilter === "disabled"
      ? false
      : null;

  interface BundleWithTierCount {
    id: BundleId;
    title: string;
    description: string | null;
    mode: BundleMode;
    enabled: boolean;
    health_status: import("../types/contracts.js").BundleHealthStatus;
    created_at: Date;
    updated_at: Date;
    tier_count: string;
  }

  const rows = await sql<BundleWithTierCount[]>`
    SELECT b.id, b.title, b.description, b.mode, b.enabled, b.health_status, b.created_at, b.updated_at,
           COALESCE(t.cnt, 0)::text AS tier_count
    FROM bundles b
    LEFT JOIN (
      SELECT bundle_id, COUNT(*)::int AS cnt
      FROM bundle_tiers
      GROUP BY bundle_id
    ) t ON t.bundle_id = b.id
    WHERE (${enabledFilter}::boolean IS NULL OR b.enabled = ${enabledFilter}::boolean)
      AND (${healthFilter}::text   IS NULL OR b.health_status = ${healthFilter}::text)
      AND (${cursor}::text         IS NULL OR b.id::text > ${cursor}::text)
    ORDER BY b.created_at ASC, b.id ASC
    LIMIT ${PAGE_SIZE + 1}
  `;

  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor: string | null = hasMore
    ? (pageRows[pageRows.length - 1]?.id ?? null)
    : null;

  const countRows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*)::text AS cnt FROM bundles
    WHERE (${enabledFilter}::boolean IS NULL OR enabled = ${enabledFilter}::boolean)
      AND (${healthFilter}::text   IS NULL OR health_status = ${healthFilter}::text)
  `;
  const totalCount = parseInt(countRows[0]?.cnt ?? "0", 10);

  const bundles: BundleSummary[] = pageRows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    mode: r.mode,
    enabled: r.enabled,
    health_status: r.health_status,
    tier_count: parseInt(r.tier_count, 10),
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }));

  const resp: ListBundlesResponse = { bundles, next_cursor: nextCursor, total_count: totalCount };
  res.json(resp);
});

// ─── POST /admin/bundles/create ───────────────────────────────────────────────
adminRouter.post("/admin/bundles/create", async (req: Request, res: Response) => {
  const body = req.body as CreateBundleRequest;
  if (!body.title || typeof body.title !== "string") {
    res.status(400).json({ error: "title is required" });
    return;
  }
  const validModes: BundleMode[] = ["fixed", "flexible"];
  if (!body.mode || !validModes.includes(body.mode)) {
    res.status(400).json({ error: "mode must be 'fixed' or 'flexible'" });
    return;
  }

  const safeTitle = body.title.replace(/\0/g, "");
  const safeDesc = body.description ? body.description.replace(/\0/g, "") : null;

  const rows = await sql<{ id: BundleId }[]>`
    INSERT INTO bundles (title, description, mode)
    VALUES (${safeTitle}, ${safeDesc}, ${body.mode})
    RETURNING id
  `;

  const row = rows[0];
  if (!row) {
    res.status(500).json({ error: "failed to create bundle" });
    return;
  }

  const resp: CreateBundleResponse = { bundle_id: row.id, status: "created" };
  res.status(201).json(resp);
});

// ─── PUT /admin/bundles/update ────────────────────────────────────────────────
adminRouter.put("/admin/bundles/update", async (req: Request, res: Response) => {
  const body = req.body as UpdateBundleRequest;
  if (!body.bundle_id || typeof body.bundle_id !== "string") {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  if (body.mode !== undefined) {
    const validModes: BundleMode[] = ["fixed", "flexible"];
    if (!validModes.includes(body.mode)) {
      res.status(400).json({ error: "mode must be 'fixed' or 'flexible'" });
      return;
    }
  }

  if (body.enabled === true) {
    const blocker = await checkEnableBlockers(body.bundle_id);
    if (blocker) {
      res.status(409).json({ error: blocker });
      return;
    }
  }

  const existing = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${body.bundle_id}
  `;
  const b = existing[0];
  if (!b) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  const newTitle = body.title !== undefined ? body.title.replace(/\0/g, "") : b.title;
  const newDesc =
    body.description !== undefined
      ? (body.description ? body.description.replace(/\0/g, "") : null)
      : b.description;
  const newMode = body.mode !== undefined ? body.mode : b.mode;
  const newEnabled = body.enabled !== undefined ? body.enabled : b.enabled;

  const updated = await sql<{ id: BundleId; updated_at: Date }[]>`
    UPDATE bundles
    SET title       = ${newTitle},
        description = ${newDesc},
        mode        = ${newMode},
        enabled     = ${newEnabled},
        updated_at  = now()
    WHERE id = ${body.bundle_id}
    RETURNING id, updated_at
  `;

  const updRow = updated[0];
  if (!updRow) {
    res.status(500).json({ error: "update failed" });
    return;
  }

  const resp: UpdateBundleResponse = {
    bundle_id: updRow.id,
    updated_at: updRow.updated_at.toISOString(),
  };
  res.json(resp);
});

// ─── POST /admin/bundles/remove ───────────────────────────────────────────────
adminRouter.post("/admin/bundles/remove", async (req: Request, res: Response) => {
  const body = req.body as RemoveBundleRequest;
  if (!body.bundle_id || typeof body.bundle_id !== "string") {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const deleted = await sql<{ id: BundleId }[]>`
    DELETE FROM bundles WHERE id = ${body.bundle_id} RETURNING id
  `;
  if (deleted.length === 0) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  const resp: RemoveBundleResponse = { success: true };
  res.json(resp);
});

// ─── POST /admin/bundles/clone ────────────────────────────────────────────────
adminRouter.post("/admin/bundles/clone", async (req: Request, res: Response) => {
  const body = req.body as CloneBundleRequest;
  if (!body.source_bundle_id || typeof body.source_bundle_id !== "string") {
    res.status(400).json({ error: "source_bundle_id is required" });
    return;
  }

  const sourceRows = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${body.source_bundle_id}
  `;
  const source = sourceRows[0];
  if (!source) {
    res.status(404).json({ error: "source bundle not found" });
    return;
  }

  const cloneTitle = `${source.title} (Copy)`.replace(/\0/g, "");
  const cloneDesc = source.description ? source.description.replace(/\0/g, "") : null;

  const newBundleRows = await sql<{ id: BundleId }[]>`
    INSERT INTO bundles (title, description, mode, enabled, health_status)
    VALUES (${cloneTitle}, ${cloneDesc}, ${source.mode}, false, 'healthy')
    RETURNING id
  `;
  const newBundleRow = newBundleRows[0];
  if (!newBundleRow) {
    res.status(500).json({ error: "failed to clone bundle" });
    return;
  }
  const newBundleId = newBundleRow.id;

  // Copy items
  const sourceItems = await sql<BundleItemRow[]>`
    SELECT * FROM bundle_items WHERE bundle_id = ${body.source_bundle_id}
  `;
  for (const item of sourceItems) {
    await sql`
      INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability)
      VALUES (${newBundleId}, ${item.variant_external_id}, ${item.product_external_id}, 'available')
      ON CONFLICT (bundle_id, variant_external_id) DO NOTHING
    `;
  }

  // Copy tiers
  const sourceTiers = await sql<BundleTierRow[]>`
    SELECT * FROM bundle_tiers WHERE bundle_id = ${body.source_bundle_id} ORDER BY display_order ASC
  `;
  for (const tier of sourceTiers) {
    await sql`
      INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order)
      VALUES (${newBundleId}, ${tier.minimum_item_count}, ${tier.discount_rate}, ${tier.display_order})
      ON CONFLICT (bundle_id, minimum_item_count) DO NOTHING
    `;
  }

  const resp: CloneBundleResponse = { new_bundle_id: newBundleId, status: "created" };
  res.status(201).json(resp);
});

// ─── POST /admin/bundles/bulk-status ─────────────────────────────────────────
adminRouter.post("/admin/bundles/bulk-status", async (req: Request, res: Response) => {
  const body = req.body as BulkSetStatusRequest;
  if (!Array.isArray(body.bundle_ids) || body.bundle_ids.length === 0) {
    res.status(400).json({ error: "bundle_ids must be a non-empty array" });
    return;
  }
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }

  let updatedCount = 0;
  let skippedCount = 0;

  for (const bundleId of body.bundle_ids) {
    if (typeof bundleId !== "string") {
      skippedCount++;
      continue;
    }
    if (body.enabled) {
      const blocker = await checkEnableBlockers(bundleId as BundleId);
      if (blocker) {
        skippedCount++;
        continue;
      }
    }
    const result = await sql<{ id: BundleId }[]>`
      UPDATE bundles
      SET enabled = ${body.enabled}, updated_at = now()
      WHERE id = ${bundleId}
      RETURNING id
    `;
    if (result.length > 0) {
      updatedCount++;
    } else {
      skippedCount++;
    }
  }

  const resp: BulkSetStatusResponse = { updated_count: updatedCount, skipped_count: skippedCount };
  res.json(resp);
});

// ─── GET /admin/bundles/items ─────────────────────────────────────────────────
adminRouter.get("/admin/bundles/items", async (req: Request, res: Response) => {
  const bundleId =
    typeof req.query.bundle_id === "string" ? (req.query.bundle_id as BundleId) : null;
  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const PAGE_SIZE = 50;

  const rows = await sql<BundleItemRow[]>`
    SELECT * FROM bundle_items
    WHERE bundle_id = ${bundleId}
      AND (${cursor}::text IS NULL OR id::text > ${cursor}::text)
    ORDER BY added_at ASC, id ASC
    LIMIT ${PAGE_SIZE + 1}
  `;

  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor: string | null = hasMore
    ? (pageRows[pageRows.length - 1]?.id ?? null)
    : null;

  const countRows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*)::text AS cnt FROM bundle_items WHERE bundle_id = ${bundleId}
  `;

  const items: BundleItemSummary[] = pageRows.map((r) => ({
    id: r.id,
    bundle_id: r.bundle_id,
    variant_external_id: r.variant_external_id as unknown as VariantExternalId,
    product_external_id: r.product_external_id as unknown as ProductExternalId,
    observed_availability: r.observed_availability,
    added_at: r.added_at.toISOString(),
  }));

  const resp: ListBundleItemsResponse = {
    items,
    next_cursor: nextCursor,
    total_count: parseInt(countRows[0]?.cnt ?? "0", 10),
  };
  res.json(resp);
});

// ─── POST /admin/bundles/items/save ──────────────────────────────────────────
adminRouter.post("/admin/bundles/items/save", async (req: Request, res: Response) => {
  const body = req.body as SaveBundleItemsRequest;
  if (!body.bundle_id || typeof body.bundle_id !== "string") {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  if (!Array.isArray(body.variant_external_ids)) {
    res.status(400).json({ error: "variant_external_ids must be an array" });
    return;
  }
  if (!Array.isArray(body.product_external_ids)) {
    res.status(400).json({ error: "product_external_ids must be an array" });
    return;
  }
  if (body.variant_external_ids.length !== body.product_external_ids.length) {
    res.status(400).json({ error: "variant_external_ids and product_external_ids must have same length" });
    return;
  }

  const bundleExists = await sql<{ id: BundleId }[]>`
    SELECT id FROM bundles WHERE id = ${body.bundle_id}
  `;
  if (bundleExists.length === 0) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  // Build pairs up-front to satisfy the type checker
  const pairs: Array<[VariantExternalId, ProductExternalId]> = body.variant_external_ids.map(
    (vid, i) => [vid, body.product_external_ids[i] as ProductExternalId]
  );

  await sql.begin(async (tx) => {
    await tx`DELETE FROM bundle_items WHERE bundle_id = ${body.bundle_id}`;
    for (const [variantId, productId] of pairs) {
      await tx`
        INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability)
        VALUES (${body.bundle_id}, ${variantId}, ${productId}, 'available')
        ON CONFLICT (bundle_id, variant_external_id) DO UPDATE
          SET observed_availability = 'available',
              product_external_id   = EXCLUDED.product_external_id
      `;
    }
  });

  const resp: SaveBundleItemsResponse = {
    saved_count: body.variant_external_ids.length,
    unavailable_variants: [],
  };
  res.json(resp);
});

// ─── GET /admin/bundles/tiers ─────────────────────────────────────────────────
adminRouter.get("/admin/bundles/tiers", async (req: Request, res: Response) => {
  const bundleId =
    typeof req.query.bundle_id === "string" ? (req.query.bundle_id as BundleId) : null;
  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const PAGE_SIZE = 50;

  const rows = await sql<BundleTierRow[]>`
    SELECT * FROM bundle_tiers
    WHERE bundle_id = ${bundleId}
      AND (${cursor}::text IS NULL OR id::text > ${cursor}::text)
    ORDER BY display_order ASC, id ASC
    LIMIT ${PAGE_SIZE + 1}
  `;

  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor: string | null = hasMore
    ? (pageRows[pageRows.length - 1]?.id ?? null)
    : null;

  const countRows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*)::text AS cnt FROM bundle_tiers WHERE bundle_id = ${bundleId}
  `;

  const tiers: BundleTierSummary[] = pageRows.map((r) => ({
    id: r.id,
    bundle_id: r.bundle_id,
    minimum_item_count: r.minimum_item_count,
    discount_rate: r.discount_rate,
    display_order: r.display_order,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }));

  const resp: ListBundleTiersResponse = {
    tiers,
    next_cursor: nextCursor,
    total_count: parseInt(countRows[0]?.cnt ?? "0", 10),
  };
  res.json(resp);
});

// ─── POST /admin/bundles/tiers/save ──────────────────────────────────────────
adminRouter.post("/admin/bundles/tiers/save", async (req: Request, res: Response) => {
  const body = req.body as SaveBundleTiersRequest;
  if (!body.bundle_id || typeof body.bundle_id !== "string") {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }
  if (!Array.isArray(body.tiers)) {
    res.status(400).json({ error: "tiers must be an array" });
    return;
  }

  const bundleExists = await sql<{ id: BundleId }[]>`
    SELECT id FROM bundles WHERE id = ${body.bundle_id}
  `;
  if (bundleExists.length === 0) {
    res.status(404).json({ error: "bundle not found" });
    return;
  }

  for (const tier of body.tiers as TierInput[]) {
    if (typeof tier.minimum_item_count !== "number" || tier.minimum_item_count < 1) {
      res.status(400).json({ error: "each tier must have minimum_item_count >= 1" });
      return;
    }
    if (typeof tier.discount_rate !== "number" || tier.discount_rate < 1 || tier.discount_rate > 10000) {
      res.status(400).json({ error: "discount_rate must be between 1 and 10000 (0.01% – 100%)" });
      return;
    }
  }

  await sql.begin(async (tx) => {
    await tx`DELETE FROM bundle_tiers WHERE bundle_id = ${body.bundle_id}`;
    for (const [i, tier] of body.tiers.entries()) {
      if (!tier) continue;
      await tx`
        INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order)
        VALUES (${body.bundle_id}, ${tier.minimum_item_count}, ${tier.discount_rate}, ${i + 1})
        ON CONFLICT (bundle_id, minimum_item_count)
        DO UPDATE SET discount_rate = EXCLUDED.discount_rate,
                      display_order = EXCLUDED.display_order,
                      updated_at    = now()
      `;
    }
  });

  const resp: SaveBundleTiersResponse = { saved_count: body.tiers.length };
  res.json(resp);
});

// ─── GET /admin/purchase-history ──────────────────────────────────────────────
adminRouter.get("/admin/purchase-history", async (req: Request, res: Response) => {
  const bundleId =
    typeof req.query.bundle_id === "string" ? (req.query.bundle_id as BundleId) : null;
  const dateFrom =
    typeof req.query.date_from === "string" ? req.query.date_from : null;
  const dateTo =
    typeof req.query.date_to === "string" ? req.query.date_to : null;
  const cursor =
    typeof req.query.cursor === "string" ? req.query.cursor : null;

  const PAGE_SIZE = 50;

  const rows = await sql<BundlePurchaseRecordRow[]>`
    SELECT * FROM bundle_purchase_records
    WHERE (${bundleId}::uuid IS NULL OR bundle_id = ${bundleId}::uuid)
      AND (${dateFrom}::timestamptz IS NULL OR order_placed_at >= ${dateFrom}::timestamptz)
      AND (${dateTo}::timestamptz   IS NULL OR order_placed_at <= ${dateTo}::timestamptz)
      AND (${cursor}::text          IS NULL OR id::text > ${cursor}::text)
    ORDER BY order_placed_at DESC, id ASC
    LIMIT ${PAGE_SIZE + 1}
  `;

  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor: string | null = hasMore
    ? (pageRows[pageRows.length - 1]?.id ?? null)
    : null;

  const countRows = await sql<{ cnt: string }[]>`
    SELECT COUNT(*)::text AS cnt FROM bundle_purchase_records
    WHERE (${bundleId}::uuid IS NULL OR bundle_id = ${bundleId}::uuid)
      AND (${dateFrom}::timestamptz IS NULL OR order_placed_at >= ${dateFrom}::timestamptz)
      AND (${dateTo}::timestamptz   IS NULL OR order_placed_at <= ${dateTo}::timestamptz)
  `;

  const records: PurchaseRecordSummary[] = pageRows.map((r) => ({
    id: r.id,
    bundle_id: r.bundle_id,
    order_external_id: String(r.order_external_id) as OrderExternalId,
    order_placed_at: r.order_placed_at.toISOString(),
    variant_external_ids: JSON.parse(r.variant_external_ids) as VariantExternalId[],
    item_count: r.item_count,
    discount_rate_applied: r.discount_rate_applied,
    order_total: parseInt(String(r.order_total), 10),
    order_currency: r.order_currency,
    recorded_at: r.recorded_at.toISOString(),
  }));

  const resp: ListPurchaseHistoryResponse = {
    records,
    next_cursor: nextCursor,
    total_count: parseInt(countRows[0]?.cnt ?? "0", 10),
  };
  res.json(resp);
});
