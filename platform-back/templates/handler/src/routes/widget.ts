import { Router } from "express";
import { sql } from "../lib/db.js";

// /widget/* — fired by storefront-rendered widgets calling back through
// the Shopify App Proxy. platform-back has already verified the App
// Proxy HMAC signature and minted an ID token to call us, so by the
// time we see a request here, req.platform is trusted.
//
// Widget calls are typically *unauthenticated from the customer's
// perspective* — there's no logged-in shopper identity. Any per-shopper
// state (cart, recently-viewed, etc.) must be derived from payload
// params, not from a session this handler holds.

export const widgetRouter = Router();

// Example: a "ping" route the storefront widget can call to fetch
// merchant-configured display data. Generator replaces with real routes.
widgetRouter.post("/:path", async (req, res) => {
  const { tenantId } = req.platform!;
  const { path } = req.params;

  // Trivial example query against tenant schema — proves wiring.
  const [{ count }] = await sql<[{ count: string }]>`
    SELECT count(*)::text AS count FROM processed_webhooks
  `;

  res.json({ ok: true, tenantId, path, sampleCount: Number(count) });
});
