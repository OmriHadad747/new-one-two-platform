import { Router } from "express";
import { sql } from "../lib/db.js";
import { enqueueJob } from "../lib/cron-enqueue.js";

export const adminRouter = Router();

adminRouter.get("/settings", async (req, res) => {
  console.log(
    { requestId: req.platform!.requestId, path: req.path },
    "admin invoke",
  );

  try {
    const rows = await sql<
      { delay_hours: number; is_enabled: boolean; updated_at: Date }[]
    >`
      SELECT delay_hours, is_enabled, updated_at
      FROM abandoned_cart_settings
      WHERE singleton = true
    `;

    if (rows.length === 0) {
      // Return sensible defaults if never configured
      return res.json({
        delay_hours: 1,
        is_enabled: false,
        updated_at: new Date().toISOString(),
      });
    }

    const row = rows[0];
    return res.json({
      delay_hours: Number(row.delay_hours),
      is_enabled: Boolean(row.is_enabled),
      updated_at: row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
    });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "GET /settings error");
    return res.status(500).json({ error: "Failed to load settings" });
  }
});

adminRouter.post("/settings", async (req, res) => {
  console.log(
    { requestId: req.platform!.requestId, path: req.path },
    "admin invoke",
  );

  try {
    const { delay_hours, is_enabled } = req.body as {
      delay_hours: number;
      is_enabled: boolean;
    };

    if (
      typeof delay_hours !== "number" ||
      delay_hours < 0 ||
      typeof is_enabled !== "boolean"
    ) {
      return res
        .status(400)
        .json({ error: "delay_hours (number >= 0) and is_enabled (boolean) are required" });
    }

    const rows = await sql<
      { delay_hours: number; is_enabled: boolean; updated_at: Date }[]
    >`
      INSERT INTO abandoned_cart_settings (singleton, delay_hours, is_enabled, updated_at)
      VALUES (true, ${delay_hours}, ${is_enabled}, NOW())
      ON CONFLICT (singleton) DO UPDATE SET
        delay_hours = EXCLUDED.delay_hours,
        is_enabled  = EXCLUDED.is_enabled,
        updated_at  = NOW()
      RETURNING delay_hours, is_enabled, updated_at
    `;

    const row = rows[0];
    return res.json({
      delay_hours: Number(row.delay_hours),
      is_enabled: Boolean(row.is_enabled),
      updated_at: row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
    });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "POST /settings error");
    return res.status(500).json({ error: "Failed to save settings" });
  }
});

adminRouter.get("/reminders", async (req, res) => {
  console.log(
    { requestId: req.platform!.requestId, path: req.path },
    "admin invoke",
  );

  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.page_size ?? "20"), 10) || 20),
    );
    const status = req.query.status ? String(req.query.status) : undefined;
    const dateFrom = req.query.date_from ? String(req.query.date_from) : undefined;
    const dateTo = req.query.date_to ? String(req.query.date_to) : undefined;
    const offset = (page - 1) * pageSize;

    type CartRow = {
      id: string;
      checkout_token: string;
      customer_email: string;
      customer_display_name: string | null;
      total_price_cents: string | number;
      currency: string;
      status: string;
      last_activity_at: Date;
      reminder_sent_at: Date | null;
      created_at: Date;
    };

    const rows = await sql<CartRow[]>`
      SELECT
        id,
        checkout_token,
        customer_email,
        customer_display_name,
        total_price_cents,
        currency,
        status,
        last_activity_at,
        reminder_sent_at,
        created_at
      FROM abandoned_carts
      WHERE true
        ${status ? sql`AND status = ${status}` : sql``}
        ${dateFrom ? sql`AND created_at >= ${dateFrom}::timestamptz` : sql``}
        ${dateTo ? sql`AND created_at <= ${dateTo}::timestamptz` : sql``}
      ORDER BY created_at DESC
      LIMIT ${pageSize}
      OFFSET ${offset}
    `;

    const countRows = await sql<{ total: string }[]>`
      SELECT COUNT(*)::text AS total
      FROM abandoned_carts
      WHERE true
        ${status ? sql`AND status = ${status}` : sql``}
        ${dateFrom ? sql`AND created_at >= ${dateFrom}::timestamptz` : sql``}
        ${dateTo ? sql`AND created_at <= ${dateTo}::timestamptz` : sql``}
    `;

    const total = parseInt(countRows[0]?.total ?? "0", 10);

    const items = rows.map((r) => ({
      id: String(r.id),
      checkout_token: r.checkout_token,
      customer_email: r.customer_email,
      customer_display_name: r.customer_display_name,
      total_price_cents: Number(r.total_price_cents),
      currency: r.currency,
      status: r.status,
      last_activity_at:
        r.last_activity_at instanceof Date
          ? r.last_activity_at.toISOString()
          : String(r.last_activity_at),
      reminder_sent_at:
        r.reminder_sent_at != null
          ? r.reminder_sent_at instanceof Date
            ? r.reminder_sent_at.toISOString()
            : String(r.reminder_sent_at)
          : null,
      created_at:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : String(r.created_at),
    }));

    return res.json({ items, total, page, page_size: pageSize });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "GET /reminders error");
    return res.status(500).json({ error: "Failed to load reminders" });
  }
});

adminRouter.get("/reminders/log", async (req, res) => {
  console.log(
    { requestId: req.platform!.requestId, path: req.path },
    "admin invoke",
  );

  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.page_size ?? "20"), 10) || 20),
    );
    const dateFrom = req.query.date_from ? String(req.query.date_from) : undefined;
    const dateTo = req.query.date_to ? String(req.query.date_to) : undefined;
    const offset = (page - 1) * pageSize;

    type LogRow = {
      id: string;
      abandoned_cart_id: string;
      customer_email: string;
      customer_display_name: string | null;
      total_price_cents: string | number;
      currency: string;
      outcome: string;
      sent_at: Date;
    };

    const rows = await sql<LogRow[]>`
      SELECT
        id,
        abandoned_cart_id,
        customer_email,
        customer_display_name,
        total_price_cents,
        currency,
        outcome,
        sent_at
      FROM reminder_log
      WHERE true
        ${dateFrom ? sql`AND sent_at >= ${dateFrom}::timestamptz` : sql``}
        ${dateTo ? sql`AND sent_at <= ${dateTo}::timestamptz` : sql``}
      ORDER BY sent_at DESC
      LIMIT ${pageSize}
      OFFSET ${offset}
    `;

    const countRows = await sql<{ total: string }[]>`
      SELECT COUNT(*)::text AS total
      FROM reminder_log
      WHERE true
        ${dateFrom ? sql`AND sent_at >= ${dateFrom}::timestamptz` : sql``}
        ${dateTo ? sql`AND sent_at <= ${dateTo}::timestamptz` : sql``}
    `;

    const total = parseInt(countRows[0]?.total ?? "0", 10);

    const items = rows.map((r) => ({
      id: String(r.id),
      abandoned_cart_id: String(r.abandoned_cart_id),
      customer_email: r.customer_email,
      customer_display_name: r.customer_display_name,
      total_price_cents: Number(r.total_price_cents),
      currency: r.currency,
      outcome: r.outcome,
      sent_at:
        r.sent_at instanceof Date ? r.sent_at.toISOString() : String(r.sent_at),
    }));

    return res.json({ items, total, page, page_size: pageSize });
  } catch (err) {
    console.error(
      { requestId: req.platform!.requestId, err: String(err) },
      "GET /reminders/log error",
    );
    return res.status(500).json({ error: "Failed to load reminder log" });
  }
});

adminRouter.post("/run", async (req, res) => {
  console.log(
    { requestId: req.platform!.requestId, path: req.path },
    "admin invoke",
  );

  try {
    await enqueueJob("main", {}, { dedupKey: "manual-run" });
    return res.json({ queued: true, message: "Reminder job queued successfully" });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err: String(err) }, "POST /run error");
    return res.status(500).json({ error: "Failed to queue job" });
  }
});