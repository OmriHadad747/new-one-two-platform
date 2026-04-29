import { Router } from "express";
import { sql } from "../lib/db.js";
import { enqueueJob } from "../lib/cron-enqueue.js";

export const adminRouter = Router();

adminRouter.get("/settings", async (req, res) => {
  console.log({ requestId: req.platform!.requestId, path: req.path }, "admin invoke");
  try {
    const rows = await sql<{ delay_minutes: number; is_enabled: boolean; updated_at: string }[]>`
      SELECT delay_minutes, is_enabled, updated_at
      FROM abandoned_cart_settings
      WHERE singleton = true
    `;
    const row = rows[0];
    if (!row) {
      return res.json({ delay_minutes: 60, is_enabled: false, updated_at: new Date().toISOString() });
    }
    return res.json({
      delay_minutes: row.delay_minutes,
      is_enabled: row.is_enabled,
      updated_at: row.updated_at,
    });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "GET /settings error");
    return res.status(500).json({ error: "Internal server error" });
  }
});

adminRouter.post("/settings", async (req, res) => {
  console.log({ requestId: req.platform!.requestId, path: req.path }, "admin invoke");
  try {
    const { delay_minutes, is_enabled } = req.body as { delay_minutes: number; is_enabled: boolean };
    if (typeof delay_minutes !== "number" || typeof is_enabled !== "boolean") {
      return res.status(400).json({ error: "delay_minutes (number) and is_enabled (boolean) are required" });
    }
    const rows = await sql<{ delay_minutes: number; is_enabled: boolean; updated_at: string }[]>`
      INSERT INTO abandoned_cart_settings (singleton, delay_minutes, is_enabled, updated_at)
      VALUES (true, ${delay_minutes}, ${is_enabled}, NOW())
      ON CONFLICT (singleton) DO UPDATE SET
        delay_minutes = EXCLUDED.delay_minutes,
        is_enabled = EXCLUDED.is_enabled,
        updated_at = NOW()
      RETURNING delay_minutes, is_enabled, updated_at
    `;
    const row = rows[0];
    if (!row) {
      return res.status(500).json({ error: "Failed to upsert settings" });
    }
    return res.json({
      delay_minutes: row.delay_minutes,
      is_enabled: row.is_enabled,
      updated_at: row.updated_at,
    });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "POST /settings error");
    return res.status(500).json({ error: "Internal server error" });
  }
});

adminRouter.get("/stats", async (req, res) => {
  console.log({ requestId: req.platform!.requestId, path: req.path }, "admin invoke");
  try {
    const rows = await sql<{ status: string; count: string }[]>`
      SELECT status, COUNT(*) AS count FROM abandoned_cart_emails GROUP BY status
    `;
    const todayRows = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM abandoned_cart_emails
      WHERE status = 'sent' AND email_sent_at >= CURRENT_DATE
    `;

    let total_sent = 0;
    let total_failed = 0;
    let total_skipped = 0;
    for (const r of rows) {
      const n = parseInt(r.count, 10);
      if (r.status === "sent") total_sent = n;
      else if (r.status === "failed") total_failed = n;
      else if (r.status === "skipped_no_email" || r.status === "skipped_completed") total_skipped += n;
    }

    const todayRow = todayRows[0];
    const sent_today = todayRow ? parseInt(todayRow.count, 10) : 0;

    return res.json({ total_sent, sent_today, total_failed, total_skipped });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "GET /stats error");
    return res.status(500).json({ error: "Internal server error" });
  }
});

adminRouter.get("/emails", async (req, res) => {
  console.log({ requestId: req.platform!.requestId, path: req.path }, "admin invoke");
  try {
    const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
    const page_size = Math.min(100, Math.max(1, parseInt((req.query.page_size as string) ?? "20", 10)));
    const status = (req.query.status as string) ?? null;
    const offset = (page - 1) * page_size;

    const countRows = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM abandoned_cart_emails
      WHERE (${status}::text IS NULL OR status = ${status})
    `;
    const countRow = countRows[0];
    const total = countRow ? parseInt(countRow.count, 10) : 0;

    const items = await sql<{
      id: string;
      cart_token: string;
      customer_email: string;
      cart_subtotal_cents: number;
      currency: string;
      line_items_json: unknown[];
      status: string;
      failure_reason: string | null;
      email_sent_at: string | null;
      detected_at: string;
      abandoned_at: string;
    }[]>`
      SELECT id, cart_token, customer_email, cart_subtotal_cents, currency,
             line_items_json, status, failure_reason, email_sent_at, detected_at, abandoned_at
      FROM abandoned_cart_emails
      WHERE (${status}::text IS NULL OR status = ${status})
      ORDER BY detected_at DESC
      LIMIT ${page_size} OFFSET ${offset}
    `;

    return res.json({ items, total, page, page_size });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "GET /emails error");
    return res.status(500).json({ error: "Internal server error" });
  }
});

adminRouter.post("/run", async (req, res) => {
  console.log({ requestId: req.platform!.requestId, path: req.path }, "admin invoke");
  try {
    await enqueueJob("main", {}, { dedupKey: "abandoned-cart-main-manual" });
    return res.json({ triggered: true, message: "Abandoned cart job queued successfully" });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "POST /run error");
    return res.status(500).json({ error: "Internal server error" });
  }
});