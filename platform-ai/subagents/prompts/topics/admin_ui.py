"""
Single source of truth for the admin UI surface.

  ARCHITECT  — architect prompt: adminApiCatalog declaration rules.
  HANDLER    — handler prompt: admin router implementation guide.
"""

# ── Architect view ─────────────────────────────────────────────────────────────

ARCHITECT = """\
adminApiCatalog: REQUIRED (non-null, non-empty) for storefront_backend_admin and backend_admin.
  MUST be null for storefront_backend and backend archetypes — no admin UI will be generated
  for those archetypes, so any declared routes would be dead code in the handler.
  Every route the Admin UI calls via bridge.call().
  RULES:
  - Each entry contains ONLY these four fields: path, method, requestShape, responseShape.
    Do NOT add description, summary, operationId, tags, or any other field — they are
    ignored by codegen and cause schema drift.
  - path must start with "/" and contain NO path parameters (:id, :slug, etc.) —
    paths match by exact string equality. Put identifiers in requestShape.
  - method: "GET" = read-only, "POST" = action or mutation
  - requestShape: fields the admin UI sends. Use {} for GET-style paths with no body.
  - responseShape: the exact JSON the handler returns on success.
  - Routes that return a list of records MUST include pagination in both shapes:
    requestShape: { "page": "number", "page_size": "number", ... }
    responseShape: { "items": [...], "total": "number", "page": "number", "page_size": "number" }
    Do NOT return unbounded lists — a merchant with thousands of records will get OOM/timeout errors.
  - When cronSchedule is non-null: ALWAYS include a POST route for manual trigger (e.g.
    "/run") — merchants must be able to trigger an immediate run without waiting for the
    next scheduled execution. Do NOT add a redundant "/run" route when the app is
    manually triggered (no cronSchedule) and already has an explicit start/trigger route.\
"""

# ── Architect capabilities view ────────────────────────────────────────────────

ARCHITECT_CAPABILITIES = """\
adminCapabilities: Closed-vocabulary list declaring which App Bridge / admin
  APIs the ADMIN UI uses beyond the always-on bridge.call(path, body) channel
  to the handler. null for non-admin archetypes.

  Allowed values: the "Admin-panel capabilities" entries in the AVAILABLE
  capabilities list above. No declarable admin capabilities exist today,
  so the array is [] for every admin archetype until the registry grows.

  RULES:
  - MUST be null for backend and storefront_backend archetypes — those
    archetypes have no admin UI, so there are no admin capabilities to
    declare. Use null, not [].
  - Keep the array [] for admin archetypes today — no declarable admin
    capabilities exist yet. When the AVAILABLE list adds admin entries
    (e.g. "toast", "resource_picker"), declare them here if the admin UI
    uses them.\
"""

# ── Handler view ───────────────────────────────────────────────────────────────

HANDLER = """
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

Response contract:
  - Return EXACTLY the responseShape from adminApiCatalog — no renaming, no extra fields.
  - `res.json({...})` for success; `res.status(400|404|...).json({error: "..."})` for client errors.

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

Use platform.email.send() for email and platform.files.upload() for files
— never hand-roll fetch() to /services/*.

DB READS — search_path is already pinned to this tenant's schema, so
bare table names Just Work:
  const rows = await sql`SELECT <field_1>, <field_2> FROM <table_1> ORDER BY created_at DESC LIMIT 50`;

LOGGING — log every admin invocation entry:
  console.log(
    { requestId: req.platform!.requestId, path: req.path },
    "admin invoke",
  );
"""
