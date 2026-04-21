import { Router } from "express";
import { sql } from "../lib/db.js";
import { webhookHandlers } from "./webhook-handlers.js";

// Locked down — generator does NOT replace this file.
// Business logic lives in webhook-handlers.ts (generator-authored).

export const webhookRouter = Router();

// Shopify topics contain a slash (e.g. "orders/create"), so we capture
// the full path rather than a single :param segment.
webhookRouter.post("/*", async (req, res) => {
  const topic = req.path.slice(1); // "/orders/create" → "orders/create"
  const envelop = req.body as { webhook_id?: string; payload?: unknown };

  if (typeof envelop.webhook_id !== "string" || envelop.webhook_id.length === 0) {
    res.status(400).json({ error: "missing_webhook_id" });
    return;
  }

  const inserted = await sql<Array<{ webhook_id: string }>>`
    INSERT INTO processed_webhooks (webhook_id)
    VALUES (${envelop.webhook_id})
    ON CONFLICT (webhook_id) DO NOTHING
    RETURNING webhook_id
  `;
  if (inserted.length === 0) {
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }

  const handler = webhookHandlers[topic];
  if (!handler) {
    // Unknown topic — already marked processed above so we don't hot-loop.
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  try {
    await handler(envelop.payload, req);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(
      { err: String(err), topic, webhook_id: envelop.webhook_id },
      "webhook handler threw",
    );
    res.status(500).json({ error: "handler_failed" });
  }
});
