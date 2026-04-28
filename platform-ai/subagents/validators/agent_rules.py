"""
agent_rules — unified prompt-rule compliance validator (Haiku, no thinking).

Owns every `owner: LLM` rule-row in ARCH_RULES.md and HANDLER_RULES.md.
Reads the architect plan + handler bundle + intent and flags places where
the output violates a prompt-taught rule that a static check cannot catch.

When new generator surfaces (migration / widget / admin / product / revision)
ship their `<SURFACE>_RULES.md` registries, ADD a section to SYSTEM_PROMPT
below — do not add a new validator module.

Source-of-truth handshake:
  ARCH_RULES.md, HANDLER_RULES.md   — what to validate (per-row)
  this file's SYSTEM_PROMPT          — how the validator reads the rules

Both must move together when an `llm` row is added or reclassified.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict

from models.adapter import extract_json, get_llm, invoke
from models.agent_models import get_agent_model
from subagents.base import CodegenContext
from subagents.validators.base import (
    ValidatorRunResult,
    _normalize_findings,
    _now_ms,
)

log = logging.getLogger(__name__)


_FINDINGS_CAP = 12
_MAX_OUTPUT_TOKENS = 2000


SYSTEM_PROMPT = """\
You are an LLM-side validator for a Shopify-app codegen pipeline. The architect agent emits a plan JSON; the handler agent emits a TypeScript file bundle. Both agents are taught explicit rules in their prompts. Your job is to find places where the output violates those rules in ways structural validators cannot detect — i.e., where the failure depends on understanding intent, prose, or cross-field consistency.

You will be given the architect plan, the handler bundle, and the user's app intent. Return only HIGH-confidence findings — every flagged item must be a real violation that would degrade or break the running app, not a stylistic preference.

ARCHITECT PLAN — what to look for:

Capability honesty. `platformGaps` mitigations must reference only AVAILABLE platform capabilities (no push notifications, Slack, WebSockets, GPU, inbound webhooks from arbitrary sources). Mitigations must not propose background workers or deferred-job patterns — the handler runs as a single synchronous async function. If the core value cannot be delivered without a missing capability, `feasibility` should be "blocked" rather than padded with an unworkable gap. `widgetCapabilities` should declare "storefront" only when the widget genuinely reads Shopify public storefront data directly. `shopifyGraphqlOperations` should list only ROOT operations the handler issues directly; sub-resources reached as sub-selections of another listed op should NOT appear separately.

Edge cases. `edgeCases` entries must describe scenarios semantically. Never cite literal Shopify enum values like "fulfilled" / "paid" / "subscribed" — Shopify's actual values may differ in case or naming, and a guessed literal silently no-ops the guard.

Catalog discipline. `widgetApiCatalog` and `adminApiCatalog` `requestShape` must contain only data the caller can actually produce — widgets see form inputs, URL params, and identifiers from `window.Shopify.context` (variantId / productId / customerId); they cannot send tenantId or arbitrary server state. Routes that persist per-shopper state must include both `customerId` AND `guestToken` in `requestShape` so the handler can identify both logged-in and guest flows. List routes returning collections must include pagination in both shapes (`page`, `page_size`, `items`, `total`). When `cronSchedule` is non-null, `adminApiCatalog` must include a manual-trigger POST route — merchants need to fire ad-hoc runs without waiting for the schedule.

Webhook and cron contracts. `webhookTopics` must contain only topics the handler actually consumes (no "just in case"). Every field listed in `webhookContract.payloadFields` must be referenced in `handlerMustProduce`. `cronContract.handlerMustProduce` must not describe per-item Shopify reads inside the loop body — bulk pre-fetch is required when iterating. `cronBatching` must be declared whenever the cron loop reads Shopify per-item; per-item write-only patterns require a corresponding `platformGaps` entry.

Database contracts. Structured-data columns (payload snapshots, settings blobs, line-item arrays — anything that would otherwise be `JSON.stringify`-ed) must use `JSONB`, never `TEXT`, even when not named with a `_json` suffix. Tables with one record per entity-combination (per customer per product, per order per item) must declare `uniqueConstraint` on the natural deduplication key. Each table must have exactly ONE creation timestamp — don't add `created_at` when a domain timestamp like `ran_at` / `sent_at` / `processed_at` is already set at row insertion. Log/audit tables that reference a parent record must declare `REFERENCES <parent>(id) ON DELETE CASCADE`; orphans become unqueryable when the parent is deleted. Discrete-value columns (`status` / `kind` / `channel` / `type`) must declare a non-empty `enum` list. Don't declare configuration/settings tables unless `adminApiCatalog` includes routes to read AND write them — settings the merchant can't change are dead.

State machines. `stateMachine` should be declared ONLY for discrete string/enum transitions. Numeric threshold logic (`available > 0`, `quantity >= 10`) belongs in `handlerMustProduce` prose, not as a state machine. Application workflow states (`pending` / `sent` / `expired`) are plain DB columns, not state machines. `skipWhenUnknown` must agree with `handlerMustProduce`: `true` means the first observation is skipped; `false` means it triggers action.

HANDLER BUNDLE — what to look for:

Routes and responses. Every admin and widget route handler must eventually call `res.json` / `res.status().json` / `res.status().send`. A code path that throws or returns without responding leaves the request hanging until the client times out. Webhook handlers, by contrast, must NOT touch `res` — the template router owns response writes; throw to signal failure.

Email service. `data` argument keys passed to `platform.email.send` must be camelCase strings (matching the email-metadata sidecar variable names). Never pass `subject` / `templateId` / HTML / from-name / CTA fields directly — those are merchant-edited via the platform's Email tab. Don't store email HTML in app DB tables; don't compile templates inside the handler. The send loop must catch `QuotaExceeded` with `kind="email"`, log, and STOP — never retry past the monthly quota. `delivered:false` is a soft outcome (`suppressed` / `missing_config` / `provider_failed`) — log and continue; never throw.

Files service. Pass `Buffer` or `Uint8Array` directly as `contents`; never pre-base64-encode. Store the returned `fileId`; re-sign read URLs via `platform.files.signReadUrl` when handing them out (upload-time URLs expire in ~15 minutes). MIME type must be in the allowed set.

SQL discipline. Never qualify tables with a schema name — `search_path` is pinned. Never wrap IDs in `String()` when interpolating into `sql` tagged templates (postgres-js handles JS numbers natively). When using IDs as JS Map/object keys, normalize both sides with `String()` because Shopify returns numbers and postgres returns BIGINT-as-strings. Strip NUL bytes from any string sourced outside the handler before a postgres write — postgres rejects \\u0000 and aborts the transaction.

Idempotency invariants. Every externally-visible side effect (email send, Shopify mutation, third-party API call, queue publish) must live behind an atomic `UPDATE … RETURNING` claim that runs first, with the act on the returned rows after. Never SELECT-then-act-then-UPDATE. INSERTs in request-driven paths must use `ON CONFLICT DO NOTHING` (or `DO UPDATE` for upserts) paired with a `uniqueConstraint` on the dedup key. Every SQL operation in a request-driven path must filter to the specific entity from the request payload — never run an unscoped UPDATE / DELETE / SELECT on the schema.

State observation. For "if X changed, do Y" logic, read the prior state from the DB before deciding; null means "never observed" and must not be treated as a transition. When applying the atomic claim to a state machine, include the prior state in the WHERE clause and bail on zero-row results so cron and webhook paths don't double-fire. Log `prevState` and `newState` on every transition.

Shopify mutations. After every Shopify mutation, check `userErrors[]` — non-empty means failure even though the `await` succeeded; throw to surface. Mutations must request `userErrors { field message code }` in the GraphQL selection. Never construct GIDs by parsing or concatenating raw IDs; treat them as opaque and build via `gid://shopify/<Type>/${id}`.

Money. Money is integer cents stored in BIGINT columns. Shopify returns prices as decimal strings; parse to integer cents via `Math.round(parseFloat(x) * 100)` before any math. Never use float (drift), never use INTEGER (overflow at ~$21.47M).

Null-defense. Webhook and widget payloads are partially typed; guard every field with `?.` and `??`. Treat absent identity (guest checkout, deleted parent, partial fulfillment) as a valid branch — not an error — unless the feature genuinely cannot proceed.

Scale and bulk-fetch. Reads ≤1000 items via `shopify.graphqlPaginate`; >1000 items via `shopify.bulkQuery`. Writes ≤50 synchronously; >50 chunked via `enqueueJob` so each cron tick handles a small batch. No naive long sync loops. Bulk-fetch all required Shopify data BEFORE per-item loops; the loop body must contain zero `shopify.*` calls. The Shopify lookup ID used inside the loop must be SELECTed alongside the entity ID on the DB row. Per-item Shopify writes only when no batch mutation exists AND `platformGaps` acknowledges the gap. `bulkQuery` must never be called from inside a per-item loop.

Outbound HTTP. `fetch()` is allowed only for non-Shopify, non-platform third-party APIs. Always pass `AbortSignal.timeout(<ms>)`. Always check `resp.ok` and throw on non-2xx. Use `shopify.*` for Shopify; use `platform.*` for platform-back; never hand-roll `fetch()` to either. https:// literals are allowed inside JSDoc comments, regular comments, and error-message strings (legitimate documentation), and as the literal URL argument to `fetch()`. They are NOT allowed in any string slot used as a callable URL value — `templateId: "https://…"`, an https URL assigned to a const that is later passed as a fetch destination, an https URL embedded inside a `platform.*` or `shopify.*` argument, etc. Flag those; ignore JSDoc / comment / error-message URLs.

Shopify client and helpers. `shopifyClientFor` takes `req.platform!` on HTTP paths, no argument on cron paths; never use `as any` to bypass the typed context. `graphqlPaginate` queries must declare `$cursor: String`, pass `after: $cursor`, and request both `pageInfo {hasNextPage endCursor}` and `edges {node {...}}`.

Webhook field consumption. Every field listed in `webhookContract.payloadFields` must be read from the `payload` somewhere in the handler body — declared-but-unused fields signal stale planning.

Cron job dispatch. `enqueueJob`'s first argument must match a key in the `jobs` map exported from `cron.ts`. Pass `dedupKey` when the same trigger may fire twice (admin double-click, webhook retry storm) and at-most-one in-flight is required.

Widget routes. Route handlers read EXACT field names from the catalog's `requestShape` and return EXACTLY the catalog's `responseShape` — no renaming, no extra fields. `customerId` and `guestToken` are advisory; when both are present, merge guest data onto the customer record inside a transaction and drop the guest row. IDs the widget cannot produce must be looked up server-side via Shopify GraphQL inside the handler. Responses must be small and JSON-safe — never return raw DB rows with sensitive columns, stack traces, or internal IDs the storefront doesn't need.

Admin routes. Same exact-shape rule as widget. List routes implement pagination semantics matching the catalog (`page`, `page_size`, `items`, `total`). When `cronSchedule` is non-null, the manual-trigger POST route in `adminRouter` must dispatch via `enqueueJob` — never via a direct `sql` INSERT into `cron_queue` (the template owns that table).

MIGRATION SQL — what to look for:

Schema isolation. The migration runner pins `search_path` to the tenant's own Postgres schema, so bare table names land in the right place automatically. The migration must NOT qualify table names with a schema (no `tenant_<uuid>.<table>` style, no cross-database references). A literal `tenant_<...>.foo` either lands in the wrong schema or fails at deploy — silent tenant cross-talk in the worst case.

(The deploy-blocking SQL allowlist — DROP / TRUNCATE / DELETE / UPDATE / GRANT / REVOKE / ENABLE RLS / CREATE POLICY / CREATE FUNCTION / CREATE TRIGGER / CREATE EXTENSION / DO $$ / CONCURRENTLY / cron.schedule, plus `tenant_id` columns, plus reserved template-owned tables `processed_webhooks` / `cron_queue` — is enforced statically by `migration_artifact.py` before this validator runs. Don't re-flag those; flag only the residual semantic cases the regex layer can't see.)

OUTPUT FORMAT — return JSON only:

{
  "findings": [
    {
      "artifact": "plan" | "handler" | "migration" | "widget_js" | "admin_ui",
      "location": "<file:symbol or plan field path or route>",
      "issue": "<one sentence: what is wrong>",
      "failure_mode": "<one sentence: how it fails at runtime>",
      "confidence": "high"
    }
  ]
}

Cap output at 12 findings. Skip everything tsc, the GraphQL parser, or the static validators would already catch — they run separately. Skip stylistic preferences. Skip duplicates of the same issue across files. Empty findings array is the expected output when nothing is wrong.
"""


def _build_user_prompt(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> str:
    """
    Render the per-run user prompt: app intent + plan summary + emitted artifacts.
    """
    intent = ctx.intent or {}
    plan = ctx.plan or {}

    intent_block = (
        "APP INTENT\n══════════\n\n"
        + json.dumps(
            {
                "appCategory": intent.get("appCategory"),
                "title": intent.get("title"),
                "summary": intent.get("summary"),
                "qualityBrief": intent.get("qualityBrief"),
            },
            indent=2,
        )
    )

    plan_block = "ARCHITECT PLAN\n══════════════\n\n" + json.dumps(plan, indent=2)

    handler = artifacts.get("handler") or "(missing)"
    migration = artifacts.get("migration") or "(missing)"

    artifacts_lines = [
        "ARTIFACTS",
        "═════════",
        "",
        "── handler bundle ──",
        handler,
        "",
        "── migration.sql ──",
        migration,
    ]

    if is_storefront:
        widget = artifacts.get("widget_js") or "(missing)"
        artifacts_lines.extend(["", "── widget.js ──", widget])

    if is_admin_ui:
        admin = artifacts.get("admin_ui") or "(missing)"
        artifacts_lines.extend(["", "── admin_ui.js ──", admin])

    artifacts_block = "\n".join(artifacts_lines)

    return "\n\n".join([intent_block, plan_block, artifacts_block])


def run_agent_rules_validator(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> ValidatorRunResult:
    """
    Run the unified prompt-rule compliance validator. Fail-open on any error.
    """
    t0 = _now_ms()
    model = get_agent_model("agent_rules")
    llm = get_llm(model=model, max_tokens=_MAX_OUTPUT_TOKENS)
    user = _build_user_prompt(artifacts, ctx, is_storefront, is_admin_ui)

    in_tok = 0
    out_tok = 0
    try:
        response = invoke(llm, SYSTEM_PROMPT, user)
        in_tok = response.input_tokens
        out_tok = response.output_tokens
        raw = extract_json(response.content)
        result: Any = json.loads(raw)
    except Exception as exc:
        log.warning("agent_rules: failed to get/parse response (%s) — fail-open", exc)
        return ValidatorRunResult(
            validator="agent_rules",
            input_tokens=in_tok,
            output_tokens=out_tok,
            latency_ms=_now_ms() - t0,
            error=str(exc),
        )

    raw_findings = result.get("findings") if isinstance(result, dict) else None
    findings = _normalize_findings(raw_findings, "agent_rules", _FINDINGS_CAP)

    return ValidatorRunResult(
        validator="agent_rules",
        findings=findings,
        input_tokens=in_tok,
        output_tokens=out_tok,
        latency_ms=_now_ms() - t0,
    )
