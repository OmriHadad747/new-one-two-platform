"""
Admin-routing handler patterns.

Injected by handler_agent.py's JIT when ``appContracts.adminApiCatalog``
is non-empty (storefront_backend_admin or backend_admin). Covers the
src/routes/admin.ts file shape, express path-to-catalog mapping, and the
three-branch callPlatformService discipline for /services/* calls.
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
  import { callPlatformService } from "../lib/platform-call.js";

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

CALLING PLATFORM SERVICES (email, etc.) — three-branch rule:

  const { status, body } = await callPlatformService<{ ok: boolean; delivered: boolean }>({
    path: "/services/<service_name>",
    body: { <request_shape> },
  });
  if (status === 429) {
    res.status(429).json({ ok: false, reason: "quota_exceeded" });
    return;
  }
  if (status >= 400) {
    res.status(502).json({ ok: false, reason: "platform_error" });
    return;
  }
  res.json({ ...body, ok: true });

NEVER hand-roll fetch() to reach /services/*. Auth plumbing only works
through callPlatformService.

DB READS — search_path is already pinned to this tenant's schema, so
bare table names Just Work:
  const rows = await sql`SELECT <field_1>, <field_2> FROM <table_1> ORDER BY created_at DESC LIMIT 50`;

LOGGING — log every admin invocation entry:
  console.log(
    { requestId: req.platform!.requestId, path: req.path },
    "admin invoke",
  );
"""
