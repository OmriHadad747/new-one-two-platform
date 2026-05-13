import { Router } from "express";
import type { Request, Response } from "express";
import { sql } from "../lib/db.js";
import { config } from "../lib/config.js";

export const adminRouter = Router();

// GET /customers/balances
adminRouter.get("/customers/balances", async (req: Request, res: Response): Promise<void> => {
  const cursorSort: string | null = (req.query?.cursor_sort as string) ?? null;
  const cursorId: string | null = (req.query?.cursor_id as string) ?? null;
  const searchCustomer: string | null = (req.query?.search_customer as string) ?? null;
  const pageSize: number = req.query?.page_size as unknown as number;

  // normalise page size, cap at 100
  const limit = Math.min(Math.max(Number(pageSize) || 25, 1), 100);

  // parse cursor values for keyset pagination
  const cursor = {
    hasCursor:
      cursorSort !== null &&
      cursorSort !== undefined &&
      cursorId !== null &&
      cursorId !== undefined,
    sortVal:
      cursorSort !== null && cursorSort !== undefined ? Number(cursorSort) : null,
    idVal: cursorId !== null && cursorId !== undefined ? cursorId : null,
  };

  // normalise optional search term, null when absent
  const search =
    searchCustomer && searchCustomer.trim().length > 0 ? searchCustomer.trim() : null;

  let rows: {
    id: string;
    customer_external_id: number;
    available_points: number;
    lifetime_earned: number;
    lifetime_redeemed: number;
    updated_at: string;
  }[];

  // branch on whether search filter is active
  if (search !== null) {
    // branch on whether cursor is present (search + cursor)
    if (cursor.hasCursor) {
      // cursor-paginated search query: fetch limit+1 rows for next-cursor detection
      rows = await sql<typeof rows>`
        SELECT id, customer_external_id, available_points, lifetime_earned, lifetime_redeemed, updated_at
        FROM customer_balance_snapshots
        WHERE CAST(customer_external_id AS TEXT) ILIKE ${"%" + search + "%"}
          AND (available_points, id) < (${cursor.sortVal}, ${cursor.idVal}::uuid)
        ORDER BY available_points DESC, id DESC
        LIMIT ${limit + 1}
      `;
    } else {
      // first page search query: fetch limit+1 rows
      rows = await sql<typeof rows>`
        SELECT id, customer_external_id, available_points, lifetime_earned, lifetime_redeemed, updated_at
        FROM customer_balance_snapshots
        WHERE CAST(customer_external_id AS TEXT) ILIKE ${"%" + search + "%"}
        ORDER BY available_points DESC, id DESC
        LIMIT ${limit + 1}
      `;
    }
  } else {
    // branch on whether cursor is present (no search)
    if (cursor.hasCursor) {
      // cursor-paginated full list query
      rows = await sql<typeof rows>`
        SELECT id, customer_external_id, available_points, lifetime_earned, lifetime_redeemed, updated_at
        FROM customer_balance_snapshots
        WHERE (available_points, id) < (${cursor.sortVal}, ${cursor.idVal}::uuid)
        ORDER BY available_points DESC, id DESC
        LIMIT ${limit + 1}
      `;
    } else {
      // first page full list query
      rows = await sql<typeof rows>`
        SELECT id, customer_external_id, available_points, lifetime_earned, lifetime_redeemed, updated_at
        FROM customer_balance_snapshots
        ORDER BY available_points DESC, id DESC
        LIMIT ${limit + 1}
      `;
    }
  }

  // detect next page and trim to page size
  const page = {
    hasNext: rows.length > limit,
    items: rows.slice(0, limit),
  };

  // build next_cursor from last item if next page exists
  const nextCursor =
    page.hasNext && page.items.length > 0
      ? JSON.stringify({
          sort: String(page.items[page.items.length - 1]!.available_points),
          id: page.items[page.items.length - 1]!.id,
        })
      : null;

  res.status(200).json({
    items: page.items,
    next_cursor: nextCursor,
    page_size: limit,
  });
  return;
});

// GET /settings
adminRouter.get("/settings", async (req: Request, res: Response): Promise<void> => {
  // read both settings from config store with safe defaults
  const settings = await config.getMany([
    "loyalty_points_per_dollar",
    "loyalty_points_to_discount_rate",
  ]);

  // apply defaults for keys not yet set
  const resolved = {
    pointsPerDollar: settings["loyalty_points_per_dollar"] ?? 1,
    pointsToDiscountRate: settings["loyalty_points_to_discount_rate"] ?? 0.01,
  };

  res.status(200).json({
    points_per_dollar: resolved.pointsPerDollar,
    points_to_discount_rate: resolved.pointsToDiscountRate,
  });
  return;
});

// POST /settings
adminRouter.post("/settings", async (req: Request, res: Response): Promise<void> => {
  const pointsPerDollar: number = req.body?.points_per_dollar;
  const pointsToDiscountRate: number = req.body?.points_to_discount_rate;

  // validate earn rate is a positive integer
  (typeof pointsPerDollar === "number" &&
    Number.isInteger(pointsPerDollar) &&
    pointsPerDollar >= 1)
    ? true
    : (() => {
        throw new Error("points_per_dollar must be a positive integer >= 1");
      })();

  // validate redemption rate is a positive number
  (typeof pointsToDiscountRate === "number" && pointsToDiscountRate > 0)
    ? true
    : (() => {
        throw new Error("points_to_discount_rate must be a positive number");
      })();

  // persist earn rate to config store
  await config.set("loyalty_points_per_dollar", pointsPerDollar);

  // persist redemption rate to config store
  await config.set("loyalty_points_to_discount_rate", pointsToDiscountRate);

  res.status(200).json({
    points_per_dollar: pointsPerDollar,
    points_to_discount_rate: pointsToDiscountRate,
  });
  return;
});