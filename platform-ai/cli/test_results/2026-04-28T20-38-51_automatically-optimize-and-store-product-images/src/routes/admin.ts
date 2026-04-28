import { Router } from "express";
import { sql } from "../lib/db.js";
import { enqueueJob } from "../lib/cron-enqueue.js";

export const adminRouter = Router();

// GET /admin/settings
adminRouter.get("/settings", async (req, res) => {
  console.log({ requestId: req.platform!.requestId, path: req.path }, "admin invoke");
  try {
    const rows = await sql<{
      schedule_frequency: string;
      schedule_hour_utc: number;
      schedule_day_of_week: number | null;
      is_enabled: boolean;
    }[]>`
      SELECT schedule_frequency, schedule_hour_utc, schedule_day_of_week, is_enabled
      FROM optimization_settings
      WHERE singleton = true
    `;
    const row = rows[0];
    if (!row) {
      // Return sensible defaults if not yet configured
      return res.json({
        schedule_frequency: "daily",
        schedule_hour_utc: 2,
        schedule_day_of_week: null,
        is_enabled: true,
      });
    }
    return res.json({
      schedule_frequency: row.schedule_frequency,
      schedule_hour_utc: row.schedule_hour_utc,
      schedule_day_of_week: row.schedule_day_of_week,
      is_enabled: row.is_enabled,
    });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "GET /settings error");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/settings
adminRouter.post("/settings", async (req, res) => {
  console.log({ requestId: req.platform!.requestId, path: req.path }, "admin invoke");
  try {
    const { schedule_frequency, schedule_hour_utc, schedule_day_of_week, is_enabled } = req.body as {
      schedule_frequency: string;
      schedule_hour_utc: number;
      schedule_day_of_week: number | null;
      is_enabled: boolean;
    };

    const allowedFrequencies = ["daily", "weekly", "custom"];
    if (!allowedFrequencies.includes(schedule_frequency)) {
      return res.status(400).json({ error: "Invalid schedule_frequency" });
    }

    await sql`
      INSERT INTO optimization_settings (singleton, schedule_frequency, schedule_hour_utc, schedule_day_of_week, is_enabled, updated_at)
      VALUES (true, ${schedule_frequency}, ${schedule_hour_utc}, ${schedule_day_of_week}, ${is_enabled}, NOW())
      ON CONFLICT (singleton) DO UPDATE SET
        schedule_frequency = EXCLUDED.schedule_frequency,
        schedule_hour_utc = EXCLUDED.schedule_hour_utc,
        schedule_day_of_week = EXCLUDED.schedule_day_of_week,
        is_enabled = EXCLUDED.is_enabled,
        updated_at = NOW()
    `;
    return res.json({ ok: true });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "POST /settings error");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/runs
adminRouter.get("/runs", async (req, res) => {
  console.log({ requestId: req.platform!.requestId, path: req.path }, "admin invoke");
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const page_size = Math.min(100, Math.max(1, parseInt(String(req.query.page_size ?? "20"), 10) || 20));
    const offset = (page - 1) * page_size;

    const [countResult, items] = await Promise.all([
      sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM optimization_runs`,
      sql<{
        id: string;
        trigger: string;
        status: string;
        total_images: number;
        succeeded_count: number;
        skipped_count: number;
        failed_count: number;
        started_at: string;
        completed_at: string | null;
      }[]>`
        SELECT
          id::text AS id,
          trigger,
          status,
          COALESCE(total_images, 0) AS total_images,
          COALESCE(succeeded_count, 0) AS succeeded_count,
          COALESCE(skipped_count, 0) AS skipped_count,
          COALESCE(failed_count, 0) AS failed_count,
          started_at::text AS started_at,
          completed_at::text AS completed_at
        FROM optimization_runs
        ORDER BY started_at DESC
        LIMIT ${page_size} OFFSET ${offset}
      `,
    ]);

    const total = Number(countResult[0]?.count ?? "0");
    return res.json({ items, total, page, page_size });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "GET /runs error");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/runs/items
adminRouter.get("/runs/items", async (req, res) => {
  console.log({ requestId: req.platform!.requestId, path: req.path }, "admin invoke");
  try {
    const run_id = String(req.query.run_id ?? "");
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const page_size = Math.min(100, Math.max(1, parseInt(String(req.query.page_size ?? "20"), 10) || 20));
    const offset = (page - 1) * page_size;

    if (!run_id) {
      return res.status(400).json({ error: "run_id is required" });
    }

    const [countResult, items] = await Promise.all([
      sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM optimization_run_items WHERE run_id = ${run_id}::uuid`,
      sql<{
        id: string;
        product_id: number;
        product_title: string;
        image_id: string;
        source_url: string;
        source_width: number | null;
        source_height: number | null;
        outcome: string;
        failure_reason: string | null;
        optimized_url: string | null;
        processed_at: string | null;
      }[]>`
        SELECT
          id::text AS id,
          product_id,
          product_title,
          image_id,
          source_url,
          source_width,
          source_height,
          outcome,
          failure_reason,
          optimized_url,
          processed_at::text AS processed_at
        FROM optimization_run_items
        WHERE run_id = ${run_id}::uuid
        ORDER BY processed_at ASC NULLS LAST, id ASC
        LIMIT ${page_size} OFFSET ${offset}
      `,
    ]);

    const total = Number(countResult[0]?.count ?? "0");
    return res.json({ items, total, page, page_size });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "GET /runs/items error");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/run — manual trigger
adminRouter.post("/run", async (req, res) => {
  console.log({ requestId: req.platform!.requestId, path: req.path }, "admin invoke");
  try {
    // Check for an existing in_progress run to prevent concurrent execution
    const existing = await sql<{ id: string }[]>`
      SELECT id::text AS id FROM optimization_runs WHERE status = 'in_progress' LIMIT 1
    `;
    if (existing.length > 0 && existing[0]) {
      return res.json({ run_id: existing[0].id, status: "in_progress" });
    }

    // Create a new run record
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO optimization_runs (trigger, status, total_images, succeeded_count, skipped_count, failed_count, started_at)
      VALUES ('manual', 'in_progress', 0, 0, 0, 0, NOW())
      RETURNING id::text AS id
    `;

    const newRun = inserted[0];
    if (!newRun) {
      return res.status(500).json({ error: "Failed to create run record" });
    }

    const runId = newRun.id;

    // Enqueue the cron job with run context
    await enqueueJob("main", { runId, trigger: "manual" }, { dedupKey: `optimization-run-${runId}` });

    return res.json({ run_id: runId, status: "in_progress" });
  } catch (err) {
    console.error({ requestId: req.platform!.requestId, err }, "POST /run error");
    return res.status(500).json({ error: "Internal server error" });
  }
});