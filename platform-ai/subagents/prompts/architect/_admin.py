"""
Admin UI prompt section — injected only for admin archetypes.
"""

ADMIN_API_CATALOG = """\
adminApiCatalog: REQUIRED (non-null, non-empty) for storefront_backend_admin and backend_admin.
  MUST be null for storefront_backend and backend archetypes — no admin UI will be generated
  for those archetypes, so any declared routes would be dead code in the handler.
  Every route the Admin UI calls via bridge.call().
  RULES:
  - Each entry contains ONLY these four fields: path, method, requestShape, responseShape.
    Do NOT add description, summary, operationId, tags, or any other field — they are
    ignored by codegen and cause schema drift.
  - path must start with "/"
  - NO path parameters (:id, :slug, etc.) — paths are matched by exact string equality.
    Put identifiers in requestShape instead.
    ✅ { "path": "/record/detail", "requestShape": { "id": "string" } }
    ❌ { "path": "/record/:id",    "requestShape": {} }
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
