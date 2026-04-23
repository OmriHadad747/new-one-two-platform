import { Router } from "express";
import { sql } from "../lib/db.js";

export const adminRouter = Router();

// GET /admin/settings/get
adminRouter.get("/settings/get", async (req, res) => {
  console.log(
    { requestId: req.platform!.requestId, path: req.path },
    "admin invoke",
  );
  try {
    const rows = await sql`
      SELECT abandonment_delay_minutes, is_enabled
      FROM abandonment_settings
      LIMIT 1
    `;
    if (rows.length === 0) {
      // Return sensible defaults if not yet configured
      res.json({ abandonment_delay_minutes: 60, is_enabled: false });
      return;
    }
    const row = rows[0];
    res.json({
      abandonment_delay_minutes: Number(row.abandonment_delay_minutes),
      is_enabled: Boolean(row.is_enabled),
    });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "settings/get error");
    res.status(500).json({ error: "Failed to load settings" });
  }
});

// POST /admin/settings/save
adminRouter.post("/settings/save", async (req, res) => {
  console.log(
    { requestId: req.platform!.requestId, path: req.path },
    "admin invoke",
  );
  try {
    const { abandonment_delay_minutes, is_enabled } = req.body as {
      abandonment_delay_minutes: number;
      is_enabled: boolean;
    };

    if (
      typeof abandonment_delay_minutes !== "number" ||
      typeof is_enabled !== "boolean"
    ) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    await sql`
      INSERT INTO abandonment_settings (abandonment_delay_minutes, is_enabled, created_at, updated_at)
      VALUES (${abandonment_delay_minutes}, ${is_enabled}, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE
        SET abandonment_delay_minutes = EXCLUDED.abandonment_delay_minutes,
            is_enabled               = EXCLUDED.is_enabled,
            updated_at               = NOW()
    `;

    res.json({ success: true });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "settings/save error");
    res.status(500).json({ error: "Failed to save settings" });
  }
});

// GET /admin/send-log/list
adminRouter.get("/send-log/list", async (req, res) => {
  console.log(
    { requestId: req.platform!.requestId, path: req.path },
    "admin invoke",
  );
  try {
    const page = Math.max(1, Number(req.query["page"] ?? 1));
    const page_size = Math.min(100, Math.max(1, Number(req.query["page_size"] ?? 20)));
    const offset = (page - 1) * page_size;

    const [countRow] = await sql`SELECT COUNT(*)::int AS total FROM abandonment_send_log`;
    const total = countRow.total as number;

    const rows = await sql`
      SELECT
        id::text,
        customer_email,
        checkout_id,
        cart_total_price,
        status,
        failed_reason,
        sent_at
      FROM abandonment_send_log
      ORDER BY sent_at DESC NULLS LAST, id DESC
      LIMIT ${page_size} OFFSET ${offset}
    `;

    res.json({
      items: rows.map((r) => ({
        id: String(r.id),
        customer_email: r.customer_email as string,
        checkout_id: Number(r.checkout_id),
        cart_total_price: r.cart_total_price as string,
        status: r.status as string,
        failed_reason: (r.failed_reason as string | null) ?? null,
        sent_at: r.sent_at ? String(r.sent_at) : "",
      })),
      total,
      page,
      page_size,
    });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "send-log/list error");
    res.status(500).json({ error: "Failed to load send log" });
  }
});

// GET /admin/queue/list
adminRouter.get("/queue/list", async (req, res) => {
  console.log(
    { requestId: req.platform!.requestId, path: req.path },
    "admin invoke",
  );
  try {
    const page = Math.max(1, Number(req.query["page"] ?? 1));
    const page_size = Math.min(100, Math.max(1, Number(req.query["page_size"] ?? 20)));
    const status = (req.query["status"] as string | undefined) ?? null;
    const offset = (page - 1) * page_size;

    const countRows = status
      ? await sql`SELECT COUNT(*)::int AS total FROM abandoned_cart_queue WHERE status = ${status}`
      : await sql`SELECT COUNT(*)::int AS total FROM abandoned_cart_queue`;

    const total = (countRows[0].total as number);

    const rows = status
      ? await sql`
          SELECT
            id::text,
            checkout_id,
            customer_email,
            customer_first_name,
            cart_total_price,
            cart_currency,
            status,
            abandoned_at,
            sent_at
          FROM abandoned_cart_queue
          WHERE status = ${status}
          ORDER BY abandoned_at DESC
          LIMIT ${page_size} OFFSET ${offset}
        `
      : await sql`
          SELECT
            id::text,
            checkout_id,
            customer_email,
            customer_first_name,
            cart_total_price,
            cart_currency,
            status,
            abandoned_at,
            sent_at
          FROM abandoned_cart_queue
          ORDER BY abandoned_at DESC
          LIMIT ${page_size} OFFSET ${offset}
        `;

    res.json({
      items: rows.map((r) => ({
        id: String(r.id),
        checkout_id: Number(r.checkout_id),
        customer_email: r.customer_email as string,
        customer_first_name: (r.customer_first_name as string | null) ?? null,
        cart_total_price: r.cart_total_price as string,
        cart_currency: r.cart_currency as string,
        status: r.status as string,
        abandoned_at: r.abandoned_at ? String(r.abandoned_at) : "",
        sent_at: r.sent_at ? String(r.sent_at) : null,
      })),
      total,
      page,
      page_size,
    });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "queue/list error");
    res.status(500).json({ error: "Failed to load queue" });
  }
});

// POST /admin/run — trigger the cron job immediately
adminRouter.post("/run", async (req, res) => {
  console.log(
    { requestId: req.platform!.requestId, path: req.path },
    "admin invoke",
  );
  try {
    // Enqueue an immediate cron_queue row for the runner to pick up
    await sql`
      INSERT INTO cron_queue (job_name, payload, run_at, status, created_at)
      VALUES ('main', '{}'::jsonb, NOW(), 'pending', NOW())
      ON CONFLICT DO NOTHING
    `;
    res.json({ triggered: true, message: "Abandoned cart job queued for immediate execution." });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "run error");
    res.status(500).json({ error: "Failed to trigger job" });
  }
});