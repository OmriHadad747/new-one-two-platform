import { Router } from "express";
import { sql } from "../lib/db.js";
import { callPlatformService } from "../lib/platform-call.js";

// /admin/* — merchant-initiated requests from the embedded Shopify admin
// UI. platform-back has already verified the App Bridge JWT for us; this
// router only sees requests where req.platform is populated.
//
// Routes here are EXAMPLES the generator will replace. The shape is what
// matters: read req.platform for tenant identity, talk to your tenant
// schema via `sql`, call /services/* via callPlatformService.

export const adminRouter = Router();

// Example: a "send a test email" admin button.
adminRouter.post("/send-test-email", async (req, res) => {
  const { tenantId, shopDomain } = req.platform!;

  const { status, body } = await callPlatformService<{
    ok: boolean;
    delivered: boolean;
    reason?: string;
  }>({
    path: "/services/email/send",
    body: {
      to: "owner@" + shopDomain,
      data: { subject: "Test", message: `Hello from ${tenantId}` },
    },
  });

  // Per brief decision 12: handler gets exactly three branches.
  if (status === 429) {
    res.status(429).json({ ok: false, reason: "quota_exceeded" });
    return;
  }
  if (status >= 400) {
    res.status(502).json({ ok: false, reason: "platform_error", body });
    return;
  }
  res.json({ ...body, ok: true });
});

// Example: read something from the tenant's own schema.
adminRouter.get("/stats", async (_req, res) => {
  const [{ count }] = await sql<[{ count: string }]>`
    SELECT count(*)::text AS count FROM processed_webhooks
  `;
  res.json({ webhooksProcessed: Number(count) });
});
