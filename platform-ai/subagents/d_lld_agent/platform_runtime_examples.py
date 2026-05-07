"""
Working TypeScript snippets for every external-call step the LLD can emit.

Single source of truth, owned by the LLD agent. The LLD runner enriches
each external-call step in `LLDPlan.capabilityRecipes` with the matching
snippet via `example_for_step(...)` before passing the plan downstream.
Codegen agents read the enriched `example` field directly off the step
and translate the recipe mechanically — they never load this file.

Bucket selection rules (kept here so the runner is dumb):

  email_send         → "email_send"
  email_send_batch   → "email_send_batch"
  files_upload       → "files_upload_small"  (when size="small")
                     → "files_upload_large"  (when size="large")
  shopify_query      → "shopify_graphql"        (paginationStrategy="single")
                     → "shopify_graphql_paginate" (paginationStrategy="graphqlPaginate")
                     → "shopify_bulk_query"     (paginationStrategy="bulkQuery")
                     PLUS "shopify_storefront" instead when surface="storefront"
  shopify_mutation   → "shopify_mutation"
  enqueue            → "enqueue"
  compute            → "compute_money"   when expression uses `money.*`
                     → "compute_config"  when expression uses `config.*`
                     (otherwise no snippet)
  sql_select         → "paginate_offset" when the recipe's route has
                     paginationKind="offset" (stamped on the recipe's
                     sql_select before per-step walking)
                     (otherwise no snippet)

`decision`, `for_each`, `sql_transaction`, `try_catch`, `log`, `response`,
`return`, `fetch_external`, and the remaining `sql_*` kinds get NO
snippet — they are control-flow or use idioms straightforward enough
that a tiny dispatch line in the codegen prompt is enough.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional

# ── Snippet bank — keys are stable; values are working TS examples ──────────

_EXAMPLES: Dict[str, str] = {
    # ── Platform email service ─────────────────────────────────────────────
    "email_send": """\
import { platform, QuotaExceeded } from "../lib/platform.js";

try {
  const result = await platform.email.send({
    to: customerEmail,
    data: { customerName, productTitle, variantName },
  });

  if (result.delivered) {
    console.log({ deliveryId: result.deliveryId }, "email sent");
  } else {
    // result.reason is one of: "suppressed" | "missing_config" | "provider_failed"
    console.warn({ reason: result.reason }, "email not delivered");
  }
} catch (err) {
  if (err instanceof QuotaExceeded) {
    // err.kind === "email"; err.limit, err.current, err.resetsAt
    console.warn({ limit: err.limit, resetsAt: err.resetsAt }, "email quota exceeded");
    return; // monthly cap hit — stop the loop
  }
  throw err;
}
""",
    "email_send_batch": """\
import { platform, QuotaExceeded } from "../lib/platform.js";

const batch = await platform.email.sendBatch(
  rows.map((r) => ({ to: r.email, data: { name: r.name, productTitle: r.title } })),
);

for (const item of batch.items) {
  if (item.status === 200 && item.result.delivered) {
    // mark sent for rows[item.index]
  }
  // item.status === 429 → quota_exceeded for THIS item
  // item.status === 500 → send_failed for THIS item
}
""",
    # ── Platform files service ─────────────────────────────────────────────
    "files_upload_small": """\
import { platform, PayloadTooLarge, QuotaExceeded } from "../lib/platform.js";

// Inline upload (≤25 MiB) — receipts, small CSVs, thumbnails.
try {
  const f = await platform.files.upload({
    name: "receipt.pdf",
    contents: pdfBuffer,         // Buffer or Uint8Array
    mimeType: "application/pdf",
  });
  // f = { fileId, url, expiresAt, sizeBytes }
  // url is a signed link valid ~15 min — call platform.files.signReadUrl for longer.
  console.log({ fileId: f.fileId, sizeBytes: f.sizeBytes }, "file uploaded");
} catch (err) {
  if (err instanceof PayloadTooLarge) {
    // err.limitBytes — switch to platform.files.uploadLarge
    throw err;
  }
  if (err instanceof QuotaExceeded) {
    // err.kind === "storage"; err.resetsAt is null (permanent cap)
    return;
  }
  throw err;
}
""",
    "files_upload_large": """\
import { platform, PayloadTooLarge, QuotaExceeded } from "../lib/platform.js";

// Resumable upload (≤500 MiB) — exports, archives, image batches.
// Bytes go directly to GCS via signed PUT; platform-back never sees the payload.
try {
  const f = await platform.files.uploadLarge({
    name: "export-2026-05.zip",
    contents: zipBuffer,
    mimeType: "application/zip",
  });
  // Same shape as upload(): { fileId, url, expiresAt, sizeBytes }
} catch (err) {
  if (err instanceof PayloadTooLarge) throw err; // exceeds 500 MiB cap
  if (err instanceof QuotaExceeded) return;      // storage cap exhausted
  throw err;
}

// Re-sign a fresh URL when the original expires:
const link = await platform.files.signReadUrl({ fileId: f.fileId, expiresInSec: 3600 });
// link = { url, expiresAt }
""",
    # ── Shopify GraphQL — single query ─────────────────────────────────────
    "shopify_graphql": """\
import { shopifyClientFor, ShopifyRateLimitError } from "../lib/shopify.js";

const shopify = await shopifyClientFor(req.platform!); // cron path: shopifyClientFor()

const data = await shopify.graphql<{
  order: { id: string; name: string; totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } } | null;
}>(
  `query GetOrder($id: ID!) {
     order(id: $id) {
       id
       name
       totalPriceSet { shopMoney { amount currencyCode } }
     }
   }`,
  { id: `gid://shopify/Order/${orderId}` },
);

if (!data.order) return; // deleted / not visible

// Money — Shopify returns decimal strings; persist as integer minor units.
const amountCents = Math.round(parseFloat(data.order.totalPriceSet.shopMoney.amount) * 100);
""",
    # ── Shopify GraphQL — paginated read ───────────────────────────────────
    "shopify_graphql_paginate": """\
import { shopifyClientFor } from "../lib/shopify.js";

const shopify = await shopifyClientFor(req.platform!);

// Query MUST declare $cursor: String and pass it to `after:`.
// The helper supplies the cursor on each iteration; you yield page-of-nodes.
const dataMap = new Map<string, { id: string; name: string; createdAt: string }>();

for await (const nodes of shopify.graphqlPaginate(
  `query Recent($cursor: String) {
     orders(first: 250, after: $cursor, query: "created_at:>2026-01-01") {
       pageInfo { hasNextPage endCursor }
       edges { node { id name createdAt } }
     }
   }`,
  {},
  "orders",          // connectionPath — where pageInfo/edges live
)) {
  for (const n of nodes as Array<{ id: string; name: string; createdAt: string }>) {
    dataMap.set(String(n.id), n);   // String() on both sides when joining vs DB rows
  }
}
""",
    # ── Shopify GraphQL — bulk export ──────────────────────────────────────
    "shopify_bulk_query": """\
import { shopifyClientFor } from "../lib/shopify.js";

const shopify = await shopifyClientFor(req.platform!);

// Bulk-op constraints (Shopify rules):
//   - SINGLE top-level connection field
//   - ≤5 connections total, ≤2 levels of nesting
//   - nested connections take NO first/last/before/after/sortKey/query args
//
// Yields one parsed JSONL object per line. Use for 100k+ rows, or list
// reads where per-page graphql cost would be prohibitive.

for await (const node of shopify.bulkQuery(
  `{
     orders {
       edges { node { id name createdAt } }
     }
   }`,
)) {
  const o = node as { id: string; name: string; createdAt: string };
  // process one order
}

// Per-call timeout override:
//   shopify.bulkQuery(query, { maxPollMs: 30 * 60_000 })  // 30 min
""",
    # ── Shopify GraphQL — mutation (always check userErrors) ───────────────
    "shopify_mutation": """\
import { shopifyClientFor } from "../lib/shopify.js";

const shopify = await shopifyClientFor(req.platform!);

const result = await shopify.graphql<{
  tagsAdd: { userErrors: { field: string[] | null; message: string }[] };
}>(
  `mutation AddTags($id: ID!, $tags: [String!]!) {
     tagsAdd(id: $id, tags: $tags) {
       userErrors { field message }
     }
   }`,
  { id: `gid://shopify/Order/${orderId}`, tags: ["vip"] },
);

// userErrors are returned as DATA, not as a thrown exception. A successful
// await is necessary but NOT sufficient — a non-empty userErrors[] means
// Shopify rejected the mutation.
if (result.tagsAdd.userErrors.length > 0) {
  throw new Error(
    `tagsAdd failed: ${result.tagsAdd.userErrors.map((e) => e.message).join("; ")}`,
  );
}
""",
    # ── Cron enqueue (HTTP route → background job) ──────────────────────────
    "enqueue": """\
import { enqueueJob } from "../lib/cron-enqueue.js";

// Push one row onto the tenant's `cron_queue`. The template's cron-runner
// picks it up on the next poll tick (FOR UPDATE SKIP LOCKED), dispatches
// to `jobs[jobName]` in src/routes/cron.ts, retries on failure with
// exponential backoff (3 attempts: 30s, 5min, 30min), and sweeps stale
// rows. Use this from an HTTP route to break the request → background-work
// boundary so the route responds in <2s.
//
// `jobName` MUST be a key exported from src/routes/cron.ts; the LLD's
// enqueue cross-validator already enforced that this matches a
// triggeredBy: "cron:<jobName>" recipe in the same plan.
//
// `payload` is arbitrary JSON-serialisable data; the cron JobFn receives
// it as its single argument.
//
// `dedupKey` (optional) collapses concurrent enqueues of the same logical
// job — a second enqueue with the same (jobName, dedupKey) while a prior
// row is still pending/processing is a silent no-op. Use the parent
// record's id as the dedupKey to make routes safe to retry.

await enqueueJob("process_run", { run_id: insertedRunId }, { dedupKey: insertedRunId });

// Pattern — HTTP route that spawns long work and returns 202:
//   1. await sql`INSERT INTO rule_runs (...) VALUES (...) RETURNING id` → runId
//   2. await enqueueJob("process_run", { run_id: runId }, { dedupKey: runId })
//   3. res.status(202).json({ run_id: runId, status: "pending" })
""",
    # ── Platform workflow helper (stamped on compute steps using workflow.*) ─
    "compute_workflow": """\
import { workflow } from "../lib/workflow.js";

// One-shot lifecycle: atomic claim → run callback → mark complete (or
// persist failure_reason and re-throw on callback error). Returns
// `null` immediately when the row is already claimed / in the wrong
// state / missing — callback NEVER runs in that case.
const result = await workflow.attempt<RuleRun, void>(
  "rule_runs",
  runId,
  { from: "pending" },
  async (row) => {
    // Side effects here. If this throws, helper persists status='failed'
    // with err.message (truncated) and re-throws so the cron-runner sees it.
    await processRow(row);
  },
);
if (!result) return; // someone else claimed it

// Primitives for non-canonical flows (multi-step, branching terminals):
const claimed = await workflow.claim<Approval>(
  "approvals",
  approvalId,
  { from: "draft", to: "submitted" },
);
if (!claimed) return;
// … do work …
await workflow.complete("approvals", approvalId, { to: "approved" });
// or:
await workflow.fail("approvals", approvalId, "policy violation: …");

// Stale sweeper — call from a low-frequency cron tick (every ~10 min):
const swept = await workflow.sweepStale("rule_runs", { ttlMinutes: 30 });
console.log(JSON.stringify({ event: "sweep", count: swept.count }));
""",
    # ── Platform money helper (stamped on compute steps using money.*) ─────
    "compute_money": """\
import { money } from "../lib/money.js";

// Currency-aware conversion. Correct for every Shopify currency including
// zero-decimal (JPY, KRW) and three-decimal (BHD, JOD).
//
// Decimal-string from Shopify -> integer minor units (BIGINT in DB):
const totalCents = money.toMinorUnits(
  payload.totalPriceSet.shopMoney.amount,
  payload.totalPriceSet.shopMoney.currencyCode,
);

// Aggregate amounts you've already converted to integer minor units:
const grand = money.sum([itemA, itemB, itemC]);

// Take a percentage (tax / fee / discount):
const tax = money.percentage(grand, 8.5);

// Format for display (no symbol, currency-correct decimal count):
const display = money.format(totalCents, "USD"); // "9.99"
""",
    # ── Platform config helper (stamped on compute steps using config.*) ────
    "compute_config": """\
import { config } from "../lib/config.js";

// Reads always supply a default — never assume a key is set on first run.
const rate: number = await config.get("points_per_dollar", 1);
const enabled: boolean = await config.get("notifications_enabled", false);

// Writes (typical admin "save settings" route):
await config.set("points_per_dollar", req.body.rate);

// Read multiple keys for a settings-page pre-fill:
const subset = await config.getMany(["points_per_dollar", "alert_thresholds"]);

// Read every key (admin "list all settings" page):
const all = await config.getAll();
""",
    # ── Platform paginate helper (stamped on sql_select in offset routes) ──
    "paginate_offset": """\
import { paginate } from "../lib/paginate.js";
import { sql } from "../lib/db.js";

// The bare SELECT from the LLD's sql_select step (no LIMIT, no OFFSET,
// no COUNT(*)) is wrapped at codegen time. The helper handles input
// clamping (page>=1, page_size in [1,100]), the COUNT subquery, and
// the response shape.
const rows = await paginate(
  sql,
  sql`<your bare SELECT from the sql_select step, ORDER BY required>`,
  { page: req.body.page, page_size: req.body.page_size },
);
res.json(rows); // { items, total, page, page_size }

// Per-route maxPageSize override (when sql_select.purpose hints "max N"):
//   await paginate(sql, sql`...`, { page, page_size }, { maxPageSize: 1000 });
""",
    # ── Shopify Storefront API ─────────────────────────────────────────────
    "shopify_storefront": """\
import { shopifyClientFor } from "../lib/shopify.js";

const shopify = await shopifyClientFor(req.platform!);

// Public storefront data (uses a separate, public-scoped token minted
// by platform-back at OAuth time).
const data = await shopify.storefront<{
  product: { title: string; handle: string } | null;
}>(
  `query Lookup($handle: String!) {
     product(handle: $handle) { title handle }
   }`,
  { handle: "blue-widget" },
);
""",
}


# ── Public API ──────────────────────────────────────────────────────────────


_MONEY_EXPR_RE = re.compile(r"\bmoney\.[a-zA-Z]+\s*\(")
_CONFIG_EXPR_RE = re.compile(r"\bconfig\.[a-zA-Z]+\s*\(")
_WORKFLOW_EXPR_RE = re.compile(r"\bworkflow\.[a-zA-Z]+\s*\(")


def example_for_step(step: Dict[str, Any]) -> Optional[str]:
    """
    Return the working-TS snippet for one step, or None if the step kind
    needs no example (control-flow / log / response / fetch / generic
    sql_*).

    The runner calls this on every step in every recipe (including nested
    steps inside decision/for_each/sql_transaction/try_catch) and writes
    the result onto the step dict in place under the key `example`.

    `sql_select` paginate snippets are NOT chosen here — they require
    route context (paginationKind) that lives outside the step. The
    runner stamps `paginate_offset` separately, before walking, when the
    recipe's route is offset-paginated.
    """
    kind = step.get("kind")
    if kind == "email_send":
        return _EXAMPLES["email_send"]
    if kind == "email_send_batch":
        return _EXAMPLES["email_send_batch"]
    if kind == "files_upload":
        size = step.get("size")
        if size == "small":
            return _EXAMPLES["files_upload_small"]
        if size == "large":
            return _EXAMPLES["files_upload_large"]
        return None
    if kind == "shopify_query":
        # Storefront-surface queries get a dedicated snippet; admin-surface
        # queries pick by paginationStrategy.
        # The op's `surface` lives on the enriched op record (set by the
        # ops-picker runner on each pick). The LLD step references the op
        # by name; the runner has already merged the surface back onto the
        # step in `_enrich_step_with_surface()` before this is called.
        if step.get("surface") == "storefront":
            return _EXAMPLES["shopify_storefront"]
        strategy = step.get("paginationStrategy", "single")
        if strategy == "graphqlPaginate":
            return _EXAMPLES["shopify_graphql_paginate"]
        if strategy == "bulkQuery":
            return _EXAMPLES["shopify_bulk_query"]
        return _EXAMPLES["shopify_graphql"]
    if kind == "shopify_mutation":
        return _EXAMPLES["shopify_mutation"]
    if kind == "enqueue":
        return _EXAMPLES["enqueue"]
    if kind == "compute":
        expr = step.get("expression") or ""
        if _WORKFLOW_EXPR_RE.search(expr):
            return _EXAMPLES["compute_workflow"]
        if _MONEY_EXPR_RE.search(expr):
            return _EXAMPLES["compute_money"]
        if _CONFIG_EXPR_RE.search(expr):
            return _EXAMPLES["compute_config"]
        return None
    return None


def paginate_snippet() -> str:
    """Return the offset-paginate snippet — stamped by the runner on the
    sql_select step of a recipe whose route has paginationKind='offset'."""
    return _EXAMPLES["paginate_offset"]
