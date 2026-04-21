"""
Admin-routing handler patterns.

Injected by handler_agent.py's JIT when ``appContracts.adminApiCatalog``
is non-empty (storefront_backend_admin or backend_admin). Covers the
src/routes/admin.ts file shape and express path-to-catalog mapping.
"""

HARNESS_SECTION_ADMIN = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ADMIN ROUTER — src/routes/admin.ts

Requests arrive from the embedded Shopify admin UI panel. The platform-back
middleware has already verified the App Bridge session token by the time
your router runs; `req.platform` is populated.

File skeleton:

  import { Router } from "express";
  import { sql } from "../lib/db.js";
  import { platform, QuotaExceeded } from "../lib/platform.js";

  export const adminRouter = Router();

  adminRouter.get("/<path_1>", async (req, res) => {
    // ... route body
  });

  adminRouter.post("/<path_2>", async (req, res) => {
    // ... route body
  });

CRITICAL: Every path listed in the architect's adminApiCatalog MUST have
a matching adminRouter route — using the exact method and path from the
catalog. Missing even one path is a validation error. The catalog is
the contract; implement all of it.

  If the catalog declares `POST /<path>`, emit:
    adminRouter.post("/<path>", async (req, res) => { ... });
  NOT adminRouter.get, NOT a different path.

  Admin routes are mounted under /admin by the template's server.ts, so
  the URL the UI calls is `/admin/<path>`. You write only the suffix
  `/<path>`.

Body & response contract:
  - Read the request body from `req.body` — JSON already parsed.
  - Return EXACTLY the responseShape declared in adminApiCatalog. Never
    rename fields. Never add fields the catalog doesn't list.
  - Use `res.json({...})` for success; `res.status(400|404|...).json({error: "..."})`
    for client errors.

CALLING THE EMAIL SERVICE — use platform.email.send():

  try {
    const result = await platform.email.send({
      to: <recipient>,
      data: { <template_vars> },
    });
    if (result.delivered) {
      res.json({ ok: true });
    } else {
      res.json({ ok: true, delivered: false, reason: result.reason });
    }
  } catch (err) {
    if (err instanceof QuotaExceeded) {
      res.status(429).json({ ok: false, reason: "quota_exceeded" });
      return;
    }
    throw err;
  }

NEVER hand-roll fetch() or callPlatformService() to reach /services/email/*.
For files uploads, callPlatformService is still used directly (no platform.files yet).

DB READS — search_path is already pinned to this tenant's schema, so
bare table names Just Work:
  const rows = await sql`SELECT <field_1>, <field_2> FROM <table_1> ORDER BY created_at DESC LIMIT 50`;

LOGGING — log every admin invocation entry:
  console.log(
    { requestId: req.platform!.requestId, path: req.path },
    "admin invoke",
  );
"""
