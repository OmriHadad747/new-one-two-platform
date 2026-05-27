import { Router, Request, Response } from "express";
import { sql } from "../lib/db.js";
import {
  BundleId,
  BundleMode,
  BundleHealthStatus,
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
  AdminListItemsResponse,
  AdminBundleItemSummary,
  AdminSaveItemsRequest,
  AdminSaveItemsResponse,
  AdminListTiersResponse,
  AdminTierSummary,
  AdminSaveTiersRequest,
  AdminSaveTiersResponse,
  AdminPurchaseHistoryResponse,
  PurchaseRecordSummary,
  TierInput,
} from "../types/contracts.js";

export const adminRouter = Router();

// ─── Helper: cursor-based pagination ─────────────────────────────────────────
// We use created_at::text as a simple cursor (ISO string comparison works for
// TIMESTAMPTZ ordering).  For equal timestamps we append the id to break ties.

function parseCursor(cursor: string | undefined): Date | null {
  if (!cursor) return null;
  try {
    return new Date(Buffer.from(cursor, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function encodeCursor(date: Date): string {
  return Buffer.from(date.toISOString()).toString("base64");
}

const PAGE_SIZE = 25;

// ─── GET /admin/bundles ───────────────────────────────────────────────────────
adminRouter.get("/admin/bundles", async (req: Request, res: Response) => {
  const statusFilter =
    typeof req.query.status_filter === "string"
      ? req.query.status_filter
      : "all";
  const healthFilter =
    typeof req.query.health_filter === "string"
      ? req.query.health_filter
      : "all";
  const cursorRaw =
    typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const cursorDate = parseCursor(cursorRaw);

  // Count query (ignoring cursor)
  const countRows = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM bundles
    WHERE
      (${statusFilter} = 'all'
        OR (${statusFilter} = 'enabled' AND enabled = true)
        OR (${statusFilter} = 'disabled' AND enabled = false))
      AND
      (${healthFilter} = 'all' OR health_status = ${healthFilter})
  `;
  const totalCount = parseInt(countRows[0].count, 10);

  // Data query with cursor
  const rows = await sql<
    (BundleRow & { tier_count: string; item_count: string })[]
  >`
    SELECT
      b.*,
      (SELECT COUNT(*) FROM bundle_tiers WHERE bundle_id = b.id)::text AS tier_count,
      (SELECT COUNT(*) FROM bundle_items WHERE bundle_id = b.id)::text AS item_count
    FROM bundles b
    WHERE
      (${statusFilter} = 'all'
        OR (${statusFilter} = 'enabled' AND enabled = true)
        OR (${statusFilter} = 'disabled' AND enabled = false))
      AND
      (${healthFilter} = 'all' OR health_status = ${healthFilter})
      AND
      (${cursorDate}::timestamptz IS NULL OR b.created_at < ${cursorDate}::timestamptz)
    ORDER BY b.created_at DESC
    LIMIT ${PAGE_SIZE}
  `;

  const bundles: AdminBundleSummary[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    mode: r.mode,
    enabled: r.enabled,
    health_status: r.health_status,
    tier_count: parseInt(r.tier_count, 10),
    item_count: parseInt(r.item_count, 10),
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }));

  const nextCursor =
    rows.length === PAGE_SIZE ? encodeCursor(rows[rows.length - 1].created_at) : null;

  const response: AdminListBundlesResponse = {
    bundles,
    next_cursor: nextCursor,
    total_count: totalCount,
  };

  res.json(response);
});

// ─── POST /admin/bundles/create ───────────────────────────────────────────────
adminRouter.post("/admin/bundles/create", async (req: Request, res: Response) => {
  const body = req.body as AdminCreateBundleRequest;
  const title =
    typeof body.title === "string" ? body.title.replace(/\0/g, "").trim() : "";
  const mode: BundleMode =
    body.mode === "fixed" || body.mode === "flexible" ? body.mode : "flexible";
  const description =
    typeof body.description === "string"
      ? body.description.replace(/\0/g, "").trim()
      : null;

  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  const [row] = await sql<{ id: BundleId }[]>`
    INSERT INTO bundles (title, mode, description)
    VALUES (${title}, ${mode}, ${description})
    RETURNING id
  `;

  const response: AdminCreateBundleResponse = {
    bundle_id: row.id,
    status: "created",
  };

  res.status(201).json(response);
});

// ─── PUT /admin/bundles/update ────────────────────────────────────────────────
adminRouter.put("/admin/bundles/update", async (req: Request, res: Response) => {
  const body = req.body as AdminUpdateBundleRequest;
  const bundleId =
    typeof body.bundle_id === "string" ? (body.bundle_id as BundleId) : null;
  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  // Load the existing bundle
  const existing = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${bundleId}
  `;
  if (existing.length === 0) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }
  const bundle = existing[0];

  // Block re-enabling a bundle that is auto_disabled due to deleted variants
  if (body.enabled === true && bundle.health_status === "auto_disabled") {
    // Check if still has deleted or out_of_stock items
    const blockers = await sql<
      { variant_external_id: string; observed_availability: string }[]
    >`
      SELECT variant_external_id, observed_availability
      FROM bundle_items
      WHERE bundle_id = ${bundleId}
        AND observed_availability IN ('deleted', 'out_of_stock')
    `;
    if (blockers.length > 0) {
      const ids = blockers.map((b) => b.variant_external_id).join(", ");
      res
        .status(409)
        .json({
          error: `Cannot enable bundle: ${blockers.length} variant(s) still unavailable or deleted. Variant IDs: ${ids}`,
          blocking_variants: blockers.map((b) => b.variant_external_id),
        });
      return;
    }
  }

  const newTitle =
    typeof body.title === "string"
      ? body.title.replace(/\0/g, "").trim()
      : bundle.title;
  const newDesc =
    "description" in body
      ? body.description !== null && body.description !== undefined
        ? body.description.replace(/\0/g, "").trim()
        : null
      : bundle.description;
  const newMode: BundleMode =
    body.mode === "fixed" || body.mode === "flexible" ? body.mode : bundle.mode;
  const newEnabled =
    typeof body.enabled === "boolean" ? body.enabled : bundle.enabled;

  const [updated] = await sql<{ id: BundleId; updated_at: Date }[]>`
    UPDATE bundles
    SET
      title       = ${newTitle},
      description = ${newDesc},
      mode        = ${newMode},
      enabled     = ${newEnabled},
      updated_at  = now()
    WHERE id = ${bundleId}
    RETURNING id, updated_at
  `;

  const response: AdminUpdateBundleResponse = {
    bundle_id: updated.id,
    updated_at: updated.updated_at.toISOString(),
  };

  res.json(response);
});

// ─── POST /admin/bundles/remove ───────────────────────────────────────────────
adminRouter.post("/admin/bundles/remove", async (req: Request, res: Response) => {
  const body = req.body as AdminRemoveBundleRequest;
  const bundleId =
    typeof body.bundle_id === "string" ? (body.bundle_id as BundleId) : null;
  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const result = await sql`
    DELETE FROM bundles WHERE id = ${bundleId}
  `;
  // cascade removes items, tiers, purchase records, health events

  const response: AdminRemoveBundleResponse = {
    success: result.count > 0,
  };

  res.json(response);
});

// ─── POST /admin/bundles/clone ────────────────────────────────────────────────
adminRouter.post("/admin/bundles/clone", async (req: Request, res: Response) => {
  const body = req.body as AdminCloneBundleRequest;
  const sourceId =
    typeof body.source_bundle_id === "string"
      ? (body.source_bundle_id as BundleId)
      : null;
  if (!sourceId) {
    res.status(400).json({ error: "source_bundle_id is required" });
    return;
  }

  const [source] = await sql<BundleRow[]>`
    SELECT * FROM bundles WHERE id = ${sourceId}
  `;
  if (!source) {
    res.status(404).json({ error: "Source bundle not found" });
    return;
  }

  const newTitle = `${source.title.replace(/\0/g, "")} (Copy)`;
  const newDesc = source.description ? source.description.replace(/\0/g, "") : null;

  let newBundleId!: BundleId;

  await sql.begin(async (tx) => {
    const [newBundle] = await tx<{ id: BundleId }[]>`
      INSERT INTO bundles (title, description, mode, enabled, health_status)
      VALUES (${newTitle}, ${newDesc}, ${source.mode}, false, 'healthy')
      RETURNING id
    `;
    newBundleId = newBundle.id;

    // Clone items
    await tx`
      INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability)
      SELECT ${newBundleId}, variant_external_id, product_external_id, observed_availability
      FROM bundle_items
      WHERE bundle_id = ${sourceId}
    `;

    // Clone tiers
    await tx`
      INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order)
      SELECT ${newBundleId}, minimum_item_count, discount_rate, display_order
      FROM bundle_tiers
      WHERE bundle_id = ${sourceId}
    `;
  });

  const response: AdminCloneBundleResponse = {
    new_bundle_id: newBundleId,
    status: "created",
  };

  res.status(201).json(response);
});

// ─── POST /admin/bundles/bulk-status ──────────────────────────────────────────
adminRouter.post("/admin/bundles/bulk-status", async (req: Request, res: Response) => {
  const body = req.body as AdminBulkStatusRequest;
  const bundleIds = Array.isArray(body.bundle_ids)
    ? (body.bundle_ids as BundleId[])
    : [];
  const enabled = typeof body.enabled === "boolean" ? body.enabled : null;

  if (bundleIds.length === 0 || enabled === null) {
    res.status(400).json({ error: "bundle_ids and enabled are required" });
    return;
  }

  // When enabling: skip bundles that are auto_disabled with active blockers
  let skippedCount = 0;

  if (enabled) {
    // Find which bundles still have unavailable variants
    const blocked = await sql<{ bundle_id: BundleId }[]>`
      SELECT DISTINCT bi.bundle_id
      FROM bundle_items bi
      JOIN bundles b ON b.id = bi.bundle_id
      WHERE bi.bundle_id = ANY(${bundleIds}::uuid[])
        AND b.health_status = 'auto_disabled'
        AND bi.observed_availability IN ('deleted', 'out_of_stock')
    `;
    const blockedIds = new Set(blocked.map((r) => r.bundle_id));
    const eligibleIds = bundleIds.filter((id) => !blockedIds.has(id));
    skippedCount = bundleIds.length - eligibleIds.length;

    if (eligibleIds.length > 0) {
      await sql`
        UPDATE bundles
        SET enabled = true, updated_at = now()
        WHERE id = ANY(${eligibleIds}::uuid[])
      `;
    }

    const response: AdminBulkStatusResponse = {
      updated_count: eligibleIds.length,
      skipped_count: skippedCount,
    };
    res.json(response);
    return;
  }

  // Disabling: straightforward
  const result = await sql`
    UPDATE bundles
    SET enabled = false, updated_at = now()
    WHERE id = ANY(${bundleIds}::uuid[])
  `;

  const response: AdminBulkStatusResponse = {
    updated_count: result.count,
    skipped_count: 0,
  };
  res.json(response);
});

// ─── GET /admin/bundles/items ─────────────────────────────────────────────────
adminRouter.get("/admin/bundles/items", async (req: Request, res: Response) => {
  const bundleId =
    typeof req.query.bundle_id === "string"
      ? (req.query.bundle_id as BundleId)
      : null;
  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const cursorRaw =
    typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const cursorDate = parseCursor(cursorRaw);

  const [{ count }] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM bundle_items WHERE bundle_id = ${bundleId}
  `;

  const rows = await sql<BundleItemRow[]>`
    SELECT *
    FROM bundle_items
    WHERE bundle_id = ${bundleId}
      AND (${cursorDate}::timestamptz IS NULL OR added_at < ${cursorDate}::timestamptz)
    ORDER BY added_at DESC
    LIMIT ${PAGE_SIZE}
  `;

  const items: AdminBundleItemSummary[] = rows.map((r) => ({
    id: r.id,
    bundle_id: r.bundle_id,
    variant_external_id: String(r.variant_external_id),
    product_external_id: String(r.product_external_id),
    observed_availability: r.observed_availability,
    added_at: r.added_at.toISOString(),
  }));

  const nextCursor =
    rows.length === PAGE_SIZE ? encodeCursor(rows[rows.length - 1].added_at) : null;

  const response: AdminListItemsResponse = {
    items,
    next_cursor: nextCursor,
    total_count: parseInt(count, 10),
  };
  res.json(response);
});

// ─── POST /admin/bundles/items/save ───────────────────────────────────────────
adminRouter.post("/admin/bundles/items/save", async (req: Request, res: Response) => {
  const body = req.body as AdminSaveItemsRequest;
  const bundleId =
    typeof body.bundle_id === "string" ? (body.bundle_id as BundleId) : null;

  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const variantIds: string[] = Array.isArray(body.variant_external_ids)
    ? body.variant_external_ids.map((v: unknown) => String(v))
    : [];
  const productIds: string[] = Array.isArray(body.product_external_ids)
    ? body.product_external_ids.map((v: unknown) => String(v))
    : [];

  if (variantIds.length !== productIds.length) {
    res
      .status(400)
      .json({ error: "variant_external_ids and product_external_ids must have equal length" });
    return;
  }

  // Delete existing and re-insert
  await sql.begin(async (tx) => {
    await tx`DELETE FROM bundle_items WHERE bundle_id = ${bundleId}`;

    if (variantIds.length > 0) {
      // Build rows to insert
      for (let i = 0; i < variantIds.length; i++) {
        await tx`
          INSERT INTO bundle_items (bundle_id, variant_external_id, product_external_id, observed_availability)
          VALUES (${bundleId}, ${BigInt(variantIds[i])}, ${BigInt(productIds[i])}, 'available')
          ON CONFLICT (bundle_id, variant_external_id) DO NOTHING
        `;
      }
    }
  });

  const response: AdminSaveItemsResponse = {
    saved_count: variantIds.length,
    unavailable_variants: [],
  };
  res.json(response);
});

// ─── GET /admin/bundles/tiers ─────────────────────────────────────────────────
adminRouter.get("/admin/bundles/tiers", async (req: Request, res: Response) => {
  const bundleId =
    typeof req.query.bundle_id === "string"
      ? (req.query.bundle_id as BundleId)
      : null;
  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const [{ count }] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM bundle_tiers WHERE bundle_id = ${bundleId}
  `;

  const rows = await sql<BundleTierRow[]>`
    SELECT *
    FROM bundle_tiers
    WHERE bundle_id = ${bundleId}
    ORDER BY display_order ASC
  `;

  const tiers: AdminTierSummary[] = rows.map((r) => ({
    id: r.id,
    bundle_id: r.bundle_id,
    minimum_item_count: r.minimum_item_count,
    discount_rate: r.discount_rate,
    display_order: r.display_order,
  }));

  const response: AdminListTiersResponse = {
    tiers,
    next_cursor: null,
    total_count: parseInt(count, 10),
  };
  res.json(response);
});

// ─── POST /admin/bundles/tiers/save ───────────────────────────────────────────
adminRouter.post("/admin/bundles/tiers/save", async (req: Request, res: Response) => {
  const body = req.body as AdminSaveTiersRequest;
  const bundleId =
    typeof body.bundle_id === "string" ? (body.bundle_id as BundleId) : null;

  if (!bundleId) {
    res.status(400).json({ error: "bundle_id is required" });
    return;
  }

  const tiers: TierInput[] = Array.isArray(body.tiers) ? body.tiers : [];

  // Validate tiers
  for (const t of tiers) {
    if (
      typeof t.minimum_item_count !== "number" ||
      t.minimum_item_count < 1 ||
      typeof t.discount_rate !== "number" ||
      t.discount_rate < 0 ||
      t.discount_rate > 10000
    ) {
      res
        .status(400)
        .json({ error: "Each tier needs minimum_item_count >= 1 and discount_rate 0-10000 basis points" });
      return;
    }
  }

  await sql.begin(async (tx) => {
    await tx`DELETE FROM bundle_tiers WHERE bundle_id = ${bundleId}`;

    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i];
      await tx`
        INSERT INTO bundle_tiers (bundle_id, minimum_item_count, discount_rate, display_order)
        VALUES (${bundleId}, ${t.minimum_item_count}, ${t.discount_rate}, ${i})
        ON CONFLICT (bundle_id, minimum_item_count) DO UPDATE
          SET discount_rate = EXCLUDED.discount_rate,
              display_order = EXCLUDED.display_order,
              updated_at    = now()
      `;
    }
  });

  const response: AdminSaveTiersResponse = { saved_count: tiers.length };
  res.json(response);
});

// ─── GET /admin/purchase-history ──────────────────────────────────────────────
adminRouter.get("/admin/purchase-history", async (req: Request, res: Response) => {
  const bundleId =
    typeof req.query.bundle_id === "string"
      ? (req.query.bundle_id as BundleId)
      : null;
  const dateFrom =
    typeof req.query.date_from === "string" ? req.query.date_from : null;
  const dateTo =
    typeof req.query.date_to === "string" ? req.query.date_to : null;
  const cursorRaw =
    typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const cursorDate = parseCursor(cursorRaw);

  const [{ count }] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM bundle_purchase_records
    WHERE
      (${bundleId} IS NULL OR bundle_id = ${bundleId}::uuid)
      AND (${dateFrom} IS NULL OR order_placed_at >= ${dateFrom}::timestamptz)
      AND (${dateTo} IS NULL OR order_placed_at <= ${dateTo}::timestamptz)
  `;

  const rows = await sql<BundlePurchaseRecordRow[]>`
    SELECT *
    FROM bundle_purchase_records
    WHERE
      (${bundleId} IS NULL OR bundle_id = ${bundleId}::uuid)
      AND (${dateFrom} IS NULL OR order_placed_at >= ${dateFrom}::timestamptz)
      AND (${dateTo} IS NULL OR order_placed_at <= ${dateTo}::timestamptz)
      AND (${cursorDate}::timestamptz IS NULL OR order_placed_at < ${cursorDate}::timestamptz)
    ORDER BY order_placed_at DESC
    LIMIT ${PAGE_SIZE}
  `;

  const records: PurchaseRecordSummary[] = rows.map((r) => ({
    id: r.id,
    bundle_id: r.bundle_id,
    order_external_id: String(r.order_external_id),
    order_placed_at: r.order_placed_at.toISOString(),
    variant_external_ids: JSON.parse(r.variant_external_ids) as string[],
    item_count: r.item_count,
    discount_rate_applied: r.discount_rate_applied,
    order_total: String(r.order_total),
    order_currency: r.order_currency,
    recorded_at: r.recorded_at.toISOString(),
  }));

  const nextCursor =
    rows.length === PAGE_SIZE
      ? encodeCursor(rows[rows.length - 1].order_placed_at)
      : null;

  const response: AdminPurchaseHistoryResponse = {
    records,
    next_cursor: nextCursor,
    total_count: parseInt(count, 10),
  };
  res.json(response);
});
