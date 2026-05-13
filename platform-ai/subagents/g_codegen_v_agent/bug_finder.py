"""
bug_finder — open-ended cross-artifact runtime-bug hunter.

Sonnet + extended thinking (8192 budget). Reads ALL artifacts together (plan,
migration, handler bundle, email-metadata sidecar) and looks for runtime bugs
that the static layer and `agent_rules` do not cover — race conditions, silent
data loss, resource leaks, numeric overflow, cross-artifact mismatches, etc.

This is the spiritual successor to the legacy validator_agent's Part B "open
review" but with a tighter scope: per-prompt-rule violations are claimed by
`agent_rules`; bug_finder hunts the long-tail semantic + cross-artifact bugs
the rule-validator can't see.

Cap findings at 8. HIGH-confidence only — MEDIUM is dropped by the
shared `_normalize_finding` step in base.py, and the prompt asks the
model not to emit MEDIUM in the first place.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict

from models.adapter import extract_json, get_llm, invoke
from models.agent_models import get_agent_model
from subagents.base import CodegenContext
from subagents.g_codegen_v_agent.base import (
    ValidatorRunResult,
    _normalize_findings,
    _now_ms,
)

log = logging.getLogger(__name__)


_FINDINGS_CAP = 8
_THINKING_BUDGET = 8192
_MAX_OUTPUT_TOKENS = 2000


SYSTEM_PROMPT = """\
You are a runtime-bug hunter for a generated Shopify app. You see all the artifacts together: the architect plan, the migration SQL, the handler TypeScript bundle, and the email-metadata sidecar. Your job is to find runtime bugs that the static validators and the per-prompt-rule LLM validator do NOT cover — bugs that emerge from cross-artifact inconsistency, edge cases, or subtle semantic mismatches.

You're paired with extended thinking. Use it. Read all the artifacts, build a mental model of what the running app does, and look for failure modes a deploy-fresh test wouldn't trigger but a real customer would.

Cross-artifact mismatches. A `stateMachine` transition declares `from`/`to` values that the handler never writes, or whose column type can't hold them, or whose enum doesn't include them — the transition is dead at runtime. `handlerCapabilities` lists "shopify_graphql" but the handler never calls `shopify.*` (or vice versa). A widget/admin catalog entry with no matching handler route, or a near-match that looks like a typo. `adminApiCatalog` says GET but the handler implementation mutates state. The widget calls `host.call(path, { fieldA, fieldB })` but the handler's `widgetRouter.post(path, …)` route reads different field names (or different shapes) from `req.body` than what the widget sends — same hazard for the admin side with `adminRouter`. The admin panel renders a filter button or status-badge branch on a literal value (e.g. `data-status="converted"` on a real filter button, `if (row.status === 'archived')` in render logic) that no `dbContracts` column-level `enum` declares and no `stateMachine` transition emits — the bucket is permanently empty at runtime; the merchant clicks and sees nothing. Distinguish carefully from UI-only state attributes (`data-status="loading"` for in-flight indicators) — those aren't filtering a column. The admin panel's list-rendering reads pagination fields (`items`, `total`, `page`, `page_size`) that don't match what the handler returns from the corresponding `adminApiCatalog` route, or uses a `page_size` value the catalog never declared — pagination drifts and the merchant sees the wrong page count. When `cronSchedule` is non-null, `adminApiCatalog` declares no manual-trigger POST route or the admin panel never calls one — merchants can't fire ad-hoc runs. The email-metadata sidecar declares `variables` the handler never passes in `data:`, or the handler passes `data:` keys the sidecar doesn't list. The migration SQL diverges from `dbContracts` — a column declared in the contract is missing from any `CREATE TABLE` / `ADD COLUMN`, a column appears in the DDL with a different name or a different type than the contract, a constraint (NOT NULL / DEFAULT / CHECK / UNIQUE) is silently dropped or rewritten between the contract and the emitted DDL — every such drift is a runtime failure waiting for the handler's first INSERT.

Race and idempotency hazards. Two paths can observe the same state transition (cron + webhook on same entity) and only one has the atomic-claim discipline (`UPDATE … WHERE state=prev RETURNING`), or both do but one omits the prev-state predicate. Side effects (email send, Shopify mutation, queue publish) emitted before the row is marked done — any crash leaks duplicates. INSERT statements in request-driven paths without `ON CONFLICT`, on tables that webhook retries or widget retries hit twice. Cron jobs that mutate without an idempotency gate.

Silent data loss / corruption. Money column declared as INTEGER / FLOAT / NUMERIC / DOUBLE PRECISION (must be BIGINT cents), or money math using floats (`parseFloat` without `Math.round * 100`). A money column without a sibling `currency` column — SUM aggregates silently mix denominations. NOT-NULL columns INSERTed without a value or with a value that may be `undefined`. SQL strings concatenated rather than bound through `sql\\`...\\``. BIGINT IDs compared as strings on one side and numbers on the other (`Map.get(row.id)` where Shopify returned strings and postgres returned numbers, or vice versa). NUL bytes from third-party text written straight into postgres (transaction will abort).

Resource leaks and scale. A long loop that hits Shopify per-item without bulk pre-fetch (will throttle at scale). A `bulkQuery` call inside a loop. A `graphqlPaginate` without `pageInfo {hasNextPage endCursor}` (pagination breaks silently after the first page). A loop calling `platform.email.send` without catching `QuotaExceeded` (wastes the rest of the monthly quota). File uploads where signed read URLs are stored in the DB instead of `fileId`s (URLs expire in ~15 min). Synchronous loops that exceed Cloud Run's 5s webhook budget.

Numeric overflow / drift. INTEGER money columns above the $21.47M ceiling. BIGINT-parsed-as-Number when the value exceeds 2^53. Float math on values that should be integer cents.

Null-defense gaps. A webhook handler reading `payload.customer.id` without `?.` (guest checkouts crash). A widget route requiring `customerId` without a guest fallback. An "if X changed" check firing on null→value (null means never observed).

GraphQL traps. A mutation called without checking `userErrors[]` in the response. Per-item Shopify mutation inside a loop where a batch alternative exists (`metafieldsSet`, batch `tagsAdd`, etc.).

OUTPUT FORMAT — return JSON only:

{
  "findings": [
    {
      "artifact": "plan" | "backend" | "db" | "storefront" | "admin_ui",
      "location": "<file:symbol or route or job>",
      "issue": "<one sentence: what is wrong>",
      "failure_mode": "<one sentence: how it fails at runtime>",
      "confidence": "high"
    }
  ]
}

Cap findings at 8. Return only HIGH confidence — every finding must be a bug a real customer would hit. Skip anything tsc or `handler_graphql` would flag (they run separately). Skip duplicates of issues the per-prompt-rule validator would catch — atomic claim, money cents, null-defense are its lane unless you spot a specific cross-artifact instance the rule-validator can't see. Empty findings array is the expected output when nothing is wrong.
"""


def _build_user_prompt(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> str:
    """
    Render the per-run user prompt: plan + all emitted artifacts + sidecar.
    """
    plan = ctx.plan or {}
    plan_block = "ARCHITECT PLAN\n══════════════\n\n" + json.dumps(plan, indent=2)

    handler = artifacts.get("backend") or "(missing)"
    migration = artifacts.get("db") or "(missing)"

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
        widget = artifacts.get("storefront") or "(missing)"
        artifacts_lines.extend(["", "── widget.js ──", widget])

    if is_admin_ui:
        admin = artifacts.get("admin_ui") or "(missing)"
        artifacts_lines.extend(["", "── admin_ui.js ──", admin])

    sidecar = ctx.backend_email_metadata
    if sidecar:
        artifacts_lines.extend(
            ["", "── email-metadata sidecar ──", json.dumps(sidecar, indent=2)]
        )

    artifacts_block = "\n".join(artifacts_lines)

    return "\n\n".join([plan_block, artifacts_block])


def run_bug_finder_validator(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> ValidatorRunResult:
    """
    Run the cross-artifact bug-finder. Fail-open on any error.
    """
    t0 = _now_ms()
    model = get_agent_model("bug_finder")
    llm = get_llm(
        model=model,
        max_tokens=_MAX_OUTPUT_TOKENS,
        thinking_budget=_THINKING_BUDGET,
    )
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
        log.warning("bug_finder: failed to get/parse response (%s) — fail-open", exc)
        return ValidatorRunResult(
            validator="bug_finder",
            input_tokens=in_tok,
            output_tokens=out_tok,
            latency_ms=_now_ms() - t0,
            error=str(exc),
        )

    raw_findings = result.get("findings") if isinstance(result, dict) else None
    findings = _normalize_findings(raw_findings, "bug_finder", _FINDINGS_CAP)

    return ValidatorRunResult(
        validator="bug_finder",
        findings=findings,
        input_tokens=in_tok,
        output_tokens=out_tok,
        latency_ms=_now_ms() - t0,
    )
