import { Router } from "express";
import { sql } from "../lib/db.js";

// /webhook/* — fired by the platform's worker after a Shopify webhook
// arrives. The worker is the only caller; platform-back's verifyPlatform
// middleware has already established that, so req.platform is trusted.
//
// Per locked decision 8 (idempotency layer 2): every webhook route MUST
// start with the INSERT … ON CONFLICT DO NOTHING dance against
// processed_webhooks, and return early on conflict. Locking this in at
// the template level means every generated handler is duplicate-safe by
// construction.

export const webhookRouter = Router();

interface WebhookEnvelope {
  webhook_id: string;
  topic: string;
  payload: unknown;
}

webhookRouter.post("/:topic", async (req, res) => {
  const { topic } = req.params;
  const env = req.body as Partial<WebhookEnvelope>;

  if (typeof env.webhook_id !== "string" || env.webhook_id.length === 0) {
    res.status(400).json({ error: "missing_webhook_id" });
    return;
  }

  // ── Idempotency gate ──────────────────────────────────────────────────────
  const inserted = await sql<Array<{ webhook_id: string }>>`
    INSERT INTO processed_webhooks (webhook_id)
    VALUES (${env.webhook_id})
    ON CONFLICT (webhook_id) DO NOTHING
    RETURNING webhook_id
  `;
  if (inserted.length === 0) {
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }

  // ── Topic dispatch (generator fills these in) ─────────────────────────────
  switch (topic) {
    case "orders/create":
      // example: do something
      break;
    default:
      // Unknown topics still get marked processed above so we don't hot-loop.
      break;
  }

  res.status(200).json({ ok: true });
});
