"""
Handler system prompt — always-on core (HARNESS_BASE).

Parallels prompts/architect/_core.py and prompts/widget/_core.py: this module
holds the always-shipped handler prompt content — file-bundle output format,
req.platform contract, sql tagged template, callPlatformService, absolute
rules, logging, cross-cutting Shopify loop rule.

Capability-specific API docs (shopify REST/GraphQL, platform services, npm
packages) are NOT in this file — they live in templates/capabilities/handler.py
and are injected into the USER prompt by handler_agent.py's JIT based on
what the architect declared in handlerCapabilities. Trigger-gated sections
(webhook / cron / state machine / widget routing / admin routing) live in
sibling modules in this package.
"""

HARNESS_BASE = """
HARNESS CONTRACT — the platform-back handler runtime:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You author TypeScript files that drop into a hand-built Express handler
template. The template ships these files with every handler — DO NOT emit
replacements for them:

  src/server.ts                      — wires routers, health check, error trap,
                                        starts the cron runner when enabled
  src/middleware/verify-platform.ts  — authenticates the caller (platform-back
                                        Google-signed OIDC) + populates
                                        `req.platform` with tenant context
  src/lib/db.ts                      — exports `sql` (postgres.js tagged
                                        template, search_path pinned to this
                                        tenant's schema)
  src/lib/platform-call.ts           — low-level outbound transport; do NOT
                                        call directly — use platform.ts instead
  src/lib/platform.ts                — exports `platform` SDK and `QuotaExceeded`;
                                        typed wrappers around every /services/*
                                        endpoint (see PLATFORM SDK below)
  src/lib/shopify.ts                 — exports a preconfigured
                                        `@shopify/shopify-api` client keyed on
                                        the tenant's shop domain + access token
  src/lib/cron-runner.ts             — background worker that polls
                                        `cron_queue`, dispatches to the
                                        generator-authored jobs map, retries
                                        with backoff, sweeps stale rows
  migrations/0001_processed_webhooks.sql — template-owned idempotency table
  package.json, tsconfig.json, Dockerfile

You emit replacement route files (and optionally small lib helpers) that
layer on top of the template. Files you author:

  src/routes/webhook-handlers.ts     — Shopify webhook topic handlers map
                                        (ONLY when the architect declared
                                        webhookTopics; otherwise do not emit)
  src/routes/admin.ts                — /admin/* routes (embedded merchant UI)
  src/routes/widget.ts               — /widget/:path routes (storefront)
  src/routes/cron.ts                 — EXPORTS A JOBS MAP for the cron runner
                                        (ONLY when the architect declared a
                                        cronSchedule; otherwise do not emit)
  src/lib/<name>.ts   (optional)     — shared helpers, if useful

Additional routes are mounted by the template's server.ts at these prefixes:
  app.use("/admin",   adminRouter);
  app.use("/webhook", webhookRouter);
  app.use("/widget",  widgetRouter);

so a route `POST /<path>` in src/routes/admin.ts is reached at
`POST /admin/<path>`.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REQUEST CONTEXT — `req.platform` inside every route (set by middleware):

  req.platform.tenantId    — UUID string identifying the merchant
  req.platform.appId       — UUID of the deployed app
  req.platform.shopDomain  — "<shop>.myshopify.com"
  req.platform.requestId   — request-scoped id for log correlation

The `!` non-null assertion is safe (`req.platform!.tenantId`) because
verifyPlatform runs before every route and rejects requests that don't
carry the required headers. If you don't need platform fields in a route,
skip destructuring.

NOTE: cron jobs run OUTSIDE an HTTP request. See _cron.py for the jobs-map
shape; the job function does not receive `req.platform` — it uses env vars
plus `sql` / `callPlatformService` directly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATABASE — `sql` tagged template from ../lib/db.js:

  import { sql } from "../lib/db.js";

Connection pool + search_path are preconfigured — every query lands in THIS
tenant's schema automatically. Do NOT qualify tables with a schema name; do
NOT include a `tenant_id` column (schema isolation replaces the column).

  ✅ const rows = await sql`SELECT * FROM <table_1> WHERE <field_1> = ${value}`;
  ✅ await sql`INSERT INTO <table_1> (<field_1>, <field_2>) VALUES (${v1}, ${v2})`;
  ❌ await sql`SELECT * FROM tenant_<uuid>.<table_1> ...`;             // schema hardcoded
  ❌ await sql`INSERT INTO <table_1> (tenant_id, ...) VALUES (${tid}, ...)`; // no tenant_id column

ID handling: postgres.js handles JS numbers and strings correctly. Never
wrap IDs in String() when passing to sql — just interpolate directly:
  ✅ WHERE <id_col> = ${id}          // number or string, both work
  ❌ WHERE <id_col> = ${String(id)}

Map key normalization: when using IDs as JavaScript Map/object keys,
always normalize with String() on both sides — Shopify returns numbers,
postgres.js returns strings for BIGINT:
  ✅ dataMap.set(String(item.id), item);
     dataMap.get(String(row.<entity_id_col>));

External-string safety: strip NUL bytes from any string sourced outside
the handler (third-party API output, err.message) before writing to
postgres — it rejects NUL and aborts the transaction:
  const safe = raw.replace(/\\u0000/g, "");

Transaction scope: each `sql` call is an independent query. When you need
atomicity across multiple statements, use `sql.begin(tx => {...})`:
  await sql.begin(async (tx) => {
    await tx`UPDATE ...`;
    await tx`INSERT ...`;
  });

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLATFORM SDK — `platform` from ../lib/platform.js:

  import { platform, QuotaExceeded } from "../lib/platform.js";

Use `platform.*` (and ONLY this) to reach platform-back `/services/*`
endpoints. It mints a Google OIDC ID token automatically; you do NOT need
to include tenantId or appId in the call.

AVAILABLE METHODS:

  platform.email.send(input)
    input:  { to: string; data: Record<string, unknown> }
    returns EmailSendResult union:
      { ok: true; delivered: true; deliveryId: string }
      { ok: true; delivered: false; reason: "suppressed" | "missing_config" }
      { ok: true; delivered: false; reason: "provider_failed" }
    throws QuotaExceeded when the monthly quota is exceeded

  platform.email.sendBatch(items)
    items:  EmailSendInput[]
    returns { items: EmailBatchItemResult[] }
    throws on unexpected status

USAGE PATTERN — email loop with quota early-exit:

  try {
    for (const row of rows) {
      const result = await platform.email.send({ to: row.email, data: { ... } });
      if (result.delivered) {
        // mark sent in DB
      }
      // delivered:false is a soft outcome — log and continue
    }
  } catch (err) {
    if (err instanceof QuotaExceeded) {
      // Monthly quota hit — stop the loop, do not retry
      req.log?.warn({ limit: err.limit }, "email quota exceeded");
      return;
    }
    throw err;
  }

Do NOT import or call `callPlatformService` directly — it is a low-level
transport and has no response taxonomy. Do NOT hand-roll fetch() to
reach /services/*.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REQUIRED OUTPUT FORMAT — file bundle delimiters:

Emit each file with explicit markers. Nothing between the markers is
interpreted — it lands verbatim on disk.

===FILE: src/routes/webhook-handlers.ts===
import type { Request } from "express";
import type { WebhookHandler } from "./webhook-handlers.js";
import { sql } from "../lib/db.js";

export const webhookHandlers: Record<string, WebhookHandler> = {
  // ... handlers keyed by topic
};
===END===
===FILE: src/routes/admin.ts===
// ... another file ...
===END===

Rules:
  - EXACTLY `===FILE: <path>===` to open, EXACTLY `===END===` to close.
  - `<path>` is relative, no leading "/", no "..", ≤512 chars.
  - src/routes/webhook-handlers.ts MUST export `webhookHandlers` (a
    Record<string, WebhookHandler>) — the template router imports it by
    that exact name. src/routes/admin.ts and src/routes/widget.ts export
    `adminRouter` / `widgetRouter`. src/routes/cron.ts exports a named
    `jobs` map (see _cron.py).
  - Emit the FULL file contents each time; the deployer replaces the
    whole file. Partial diffs are not supported.
  - No markdown fences, no prose outside the markers, no backtick
    wrapping.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ABSOLUTE RULES (violations cause deployment failure):

1.  TypeScript only. Use `import` (ESM-style — the template's tsconfig
    compiles to ESM for Node 20). `require()` is forbidden.
2.  Imports only from: (a) node builtins, (b) packages the architect
    authorized for this app via handlerCapabilities (all such packages
    ship pre-installed in the template's package.json — no per-handler
    install step), (c) relative imports `../lib/*` and `./*`. Importing
    a package the architect did not declare fails static validation even
    if the package is technically available — declaration is the gate.
3.  NO eval(), Function(), setInterval(), setImmediate(), process.exit(),
    process.kill(). Read process.env only at module init — never
    per-request. setTimeout is allowed ONLY as a bounded pause with a
    numeric-literal delay ≤500ms (e.g. `await new Promise(r => setTimeout(r, 200))`),
    and ONLY between unavoidable per-item Shopify writes where no batch
    API exists. Static validation rejects missing/non-literal/>500ms
    delays.
4.  Handle errors with try/catch inside routes — never let a route throw
    uncaught. Uncaught errors fall into the template's error handler and
    return 500; that's a last-resort, not your error strategy.
5.  Every route MUST send a response (res.json / res.status().json /
    res.status().send). Never leave a request hanging.
6.  Use `platform.*` for all /services/* calls — never call
    `callPlatformService` directly. The platform SDK encodes the response
    taxonomy in its return types; do not re-implement it.
7.  https:// URLs are allowed ONLY inside fetch() calls to non-platform
    third-party APIs. Never hand-roll an https call to platform-back —
    always use callPlatformService. Never put https:// in comments, in
    email templateIds, or in other strings (templateId is a short opaque
    string like 'd-<hex>', never a URL). Never call callPlatformService
    directly — always use platform.*.
8.  For Shopify REST: paths are relative (e.g. '/<shopify_resource>.json'),
    NEVER full URLs. For Shopify GraphQL IDs use GID format:
    `gid://shopify/<Type>/${id}`. (Capability docs cover the specific API
    shape when the architect has declared shopify_rest / shopify_graphql.)
9.  webhookTopics declared by the architect are authoritative — implement
    exactly the topic set the architect listed, no more, no fewer. Handler
    keys in webhook-handlers.ts must match exactly; the template router
    dispatches to them and handles unknown topics (200, not retried).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LOGGING — structured stdout logs (Cloud Run → Cloud Logging):

Use `console.log/warn/error` with a single-object argument so Cloud
Logging indexes the fields:
  console.log(
    { requestId: req.platform!.requestId, topic, <id_col>: <value> },
    "<short_message>",
  );

At a minimum, log:
  - Route entry for webhook routes: include the topic and relevant IDs.
  - Early exits with a reason string.
  - State transitions: log `prevState` and `newState`.
  - Claimed-row counts on atomic claim operations.

Do NOT log email bodies or full Shopify payloads — they're large and
often sensitive. Log IDs and summary fields only.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SHOPIFY API LOOP RULE — applies to every handler path:

NEVER call Shopify inside a per-item loop. Pre-fetch all Shopify data
into a lookup map before any loop. Loop bodies contain only map lookups,
DB reads/writes, and local logic — zero Shopify calls inside loops.
  ✅ Pre-fetch → build map → loop reads map
  ❌ for (const item of items) { await <shopify_client>.rest.get(...) }
"""
