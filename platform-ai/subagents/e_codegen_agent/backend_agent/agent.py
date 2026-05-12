"""
Backend Generator — produces the TypeScript handler file bundle from the LLD.

The backend agent's job under the LLD-driven pipeline is small and
deterministic: take the LLD's `capabilityRecipes` (a typed step-AST), the
database tables / httpRoutes / shopifyIntegration / state machine /
emailSpec / platformGaps, and emit the TypeScript files that drop into
the platform-back handler template.

Consumes (all from `ctx.lld`):
  - shopifyIntegration → webhook topics + cron schedule
  - database.tables    → DDL the handler reads/writes against
  - stateMachine       → the column the handler advances via transitions
  - httpRoutes         → routes the handler must implement
  - capabilityRecipes  → step-AST per capability (the implementation)
  - emailSpec, platformGaps, uxExpectations, edgeCases

Plus from `ctx.intent`:
  - desiredOutcome, qualityBrief, appCategory

Plus, on revision runs only:
  - ctx.prior_handler_code → previously deployed handler source

Model: claude-sonnet-4-6 (via agent_models.py)
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from subagents.base import (
    CodegenContext,
    Generator,
    _THINKING_BUDGET_HIGH,
    needs_extended_thinking,
)
from subagents.e_codegen_agent.backend_agent.prompt import BACKEND_BASE
from subagents.e_codegen_agent.backend_agent.validator import validate_handler_artifact

log = logging.getLogger(__name__)

# Fence the handler emits AFTER the file bundle when emailSpec is non-null.
# Carries the data: keys passed to platform.email.send + merchant-facing
# starter copy. Captured side-band into ctx.handler_email_metadata.
_EMAIL_META_FENCE_RE = re.compile(
    r"```email-metadata\s*\n(.*?)\n```",
    re.DOTALL,
)


class BackendGenerator(Generator):
    name = "handler"
    max_tokens = 16000

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return BACKEND_BASE

    def user_prompt(self, ctx: CodegenContext) -> str:
        intent = ctx.intent or {}
        lld = ctx.lld or {}

        sections: List[str] = [
            f"App purpose: {intent.get('desiredOutcome', '')}",
            f"App category: {intent.get('appCategory', '')}",
        ]

        quality_brief = intent.get("qualityBrief")
        if quality_brief:
            sections += ["", "Quality brief:", quality_brief]

        # The full LLD as JSON. The system prompt's INPUT section names every
        # top-level field; the model navigates the JSON directly. We dump
        # verbatim so the model sees the same shape the schema validator
        # accepted — no lossy formatting.
        sections += [
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "LLD PLAN — authoritative spec for handler implementation",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            json.dumps(lld, indent=2, default=str),
            "",
        ]

        prior = _format_prior_handler(ctx.prior_handler_code)
        if prior:
            sections += ["", prior]

        sections += [
            "",
            "Emit the TypeScript handler files using the "
            "===FILE: <path>=== / ===END=== markers. Translate each recipe "
            "step into the TypeScript pattern from the STEP-KIND TRANSLATION "
            "TABLE in the system prompt. Output ONLY the file bundle (plus "
            "the email-metadata fence when emailSpec is non-null). No prose, "
            "no markdown fences wrapping the whole response.",
        ]
        return "\n".join(sections)

    def parse(self, raw: str) -> str:
        """
        Strip the email-metadata sidecar and any stray outer markdown fence,
        and return the rest VERBATIM — the ===FILE:===/===END=== markers
        MUST be preserved so downstream consumers (crew.py, validator,
        revision_agent) can parse individual files via
        utils.file_bundle.parse_file_bundle.

        The email-metadata sidecar is captured separately in generate()
        before this method runs; we also defensively strip it here so a
        direct parse() call (tests) returns a clean bundle.
        """
        stripped = _EMAIL_META_FENCE_RE.sub("", raw).strip()
        stripped = re.sub(r"^```(?:typescript|ts)?\s*\n", "", stripped, count=1)
        stripped = re.sub(r"\n```\s*$", "", stripped, count=1)
        return stripped.strip()

    def generate(self, ctx: CodegenContext) -> Tuple[str, int, int]:
        """
        Overrides Generator.generate() to capture the email-metadata sidecar
        ALONGSIDE the file bundle. When emailSpec is non-null, the model
        appends a fenced ```email-metadata``` JSON block declaring the
        `variables` it passed and `starterContent` for the Email tab.

        parse() handles the file bundle. This override additionally extracts
        the sidecar JSON and stashes it on ctx.handler_email_metadata — an
        OUTPUT slot on CodegenContext the orchestrator reads after the
        future resolves.
        """
        from models.adapter import get_llm, invoke
        from models.agent_models import get_agent_model

        thinking_budget = (
            _THINKING_BUDGET_HIGH if needs_extended_thinking(ctx.plan) else None
        )

        llm = get_llm(
            model=get_agent_model(self.name),
            max_tokens=self.max_tokens,
            thinking_budget=thinking_budget,
        )
        retry_suffix = self._format_retry_suffix(ctx.previous_errors)
        result = invoke(
            llm,
            self.system_prompt(),
            self.user_prompt(ctx),
            retry_suffix=retry_suffix,
        )

        ctx.handler_email_metadata = _extract_email_metadata(result.content)
        ctx.handler_raw_response = result.content
        return self.parse(result.content), result.input_tokens, result.output_tokens

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        lld = ctx.lld or {}
        return validate_handler_artifact(
            artifact,
            api_plan_topics=_lld_webhook_topics(lld),
            widget_catalog=_lld_widget_catalog(lld),
            admin_catalog=_lld_admin_catalog(lld),
            declared_capabilities=_capabilities_from_recipes(lld),
            db_contracts=_lld_db_contracts(lld),
            raw_artifact=ctx.handler_raw_response or artifact,
        )


# ── Email-metadata sidecar extraction ──────────────────────────────────────────


def _extract_email_metadata(raw: str) -> Optional[Dict[str, Any]]:
    """
    Pull the ```email-metadata``` fenced JSON block out of the agent's raw
    response. Returns the parsed dict, or None when no sidecar was emitted
    (no emailSpec) or the block could not be parsed.

    Parse failures are logged but do not raise — the pipeline falls back to
    no starter content, which is recoverable (merchant fills in the Email
    tab manually). A loud failure here would be worse than a soft one.
    """
    match = _EMAIL_META_FENCE_RE.search(raw)
    if not match:
        return None
    body = match.group(1).strip()
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as err:
        log.warning(
            "handler emitted email-metadata block that is not valid JSON: %s", err
        )
        return None
    if not isinstance(parsed, dict):
        log.warning(
            "handler email-metadata block parsed to %s, expected object",
            type(parsed).__name__,
        )
        return None
    return parsed


# ── LLD → validator-input adapters ─────────────────────────────────────────────
#
# The validator's signature predates the LLD — it expects webhook topic
# lists, widget/admin catalogs, db_contracts, and a declared-capabilities
# list. These small helpers project the LLD's shape onto that contract so
# the validator stays unchanged.


def _lld_webhook_topics(lld: Dict[str, Any]) -> List[str]:
    """Pull webhookTopics from `shopifyIntegration`."""
    si = lld.get("shopifyIntegration") or {}
    topics = si.get("webhookTopics") or []
    return [t for t in topics if isinstance(t, str)]


def _lld_widget_catalog(lld: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Project `httpRoutes.widget[]` into the catalog shape the validator
    expects (path / method / requestShape / responseShape)."""
    routes = ((lld.get("httpRoutes") or {}).get("widget")) or []
    return [_route_to_catalog_entry(r) for r in routes if isinstance(r, dict)]


def _lld_admin_catalog(lld: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Project `httpRoutes.admin[]` into the catalog shape the validator expects."""
    routes = ((lld.get("httpRoutes") or {}).get("admin")) or []
    return [_route_to_catalog_entry(r) for r in routes if isinstance(r, dict)]


def _route_to_catalog_entry(route: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "path": route.get("path", ""),
        "method": (route.get("method") or "POST").upper(),
        "requestShape": route.get("requestShape") or {},
        "responseShape": route.get("responseShape") or {},
    }


def _lld_db_contracts(lld: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Project `database.tables[]` into the dbContracts shape
    `validate_handler_artifact` expects (table + columns with name/enum)."""
    tables = (lld.get("database") or {}).get("tables") or []
    out: List[Dict[str, Any]] = []
    for t in tables:
        if not isinstance(t, dict):
            continue
        cols: List[Dict[str, Any]] = []
        for c in t.get("columns") or []:
            if not isinstance(c, dict):
                continue
            entry: Dict[str, Any] = {"name": c.get("name", "?")}
            enum_vals = c.get("enum")
            if isinstance(enum_vals, list) and enum_vals:
                entry["enum"] = enum_vals
            cols.append(entry)
        out.append({"table": t.get("name", "?"), "columns": cols})
    return out


def _capabilities_from_recipes(lld: Dict[str, Any]) -> List[str]:
    """
    Derive the validator's declared-capabilities list from the step kinds
    that appear in `capabilityRecipes`. The legacy `handlerCapabilities`
    plan field is gone; instead, the LLD's step-AST tells us which platform
    services + Shopify surfaces the handler uses. npm:* capabilities are
    NOT covered here — the LLD does not yet declare npm packages, so the
    handler can use only template-shipped packages.
    """
    caps: set[str] = set()
    recipes = lld.get("capabilityRecipes") or {}
    if not isinstance(recipes, dict):
        return []
    for recipe in recipes.values():
        if not isinstance(recipe, dict):
            continue
        _walk_step_kinds(recipe.get("steps") or [], caps)
    return sorted(caps)


# Step kinds → validator capability names. Only the kinds that gate an
# import allow-list entry need a mapping; pure control-flow steps (compute,
# decision, for_each, try_catch, return, response, log) do not.
_STEP_KIND_TO_CAPABILITY: Dict[str, str] = {
    "shopify_query": "shopify_graphql",
    "shopify_mutation": "shopify_graphql",
    "email_send": "email",
    "email_send_batch": "email",
    "files_upload": "files",
}


def _walk_step_kinds(steps: Any, into: set[str]) -> None:
    """Recurse through the step-AST, collecting capability names. Nested
    steps live under `try`, `catch`, `then`, `else`, and `steps`."""
    if not isinstance(steps, list):
        return
    for step in steps:
        if not isinstance(step, dict):
            continue
        cap = _STEP_KIND_TO_CAPABILITY.get(step.get("kind", ""))
        if cap:
            into.add(cap)
        for nested_key in ("steps", "try", "catch", "then", "else"):
            nested = step.get(nested_key)
            if isinstance(nested, list):
                _walk_step_kinds(nested, into)


# ── Revision-run prior-handler block ───────────────────────────────────────────


def _format_prior_handler(prior: Any) -> str:
    """Render the previously deployed handler source for revision runs.
    Accepts the legacy single-file string OR the new multi-file
    [{path, contents}] bundle from platform-back."""
    if not prior:
        return ""
    bar = "━" * 60
    header = (
        f"\n{bar}\n"
        "REVISION RUN — currently deployed handler bundle:\n"
        "(Apply the merchant feedback above as targeted changes to this code.\n"
        " Preserve all logic NOT being changed; emit the FULL bundle.)\n"
        f"{bar}\n"
    )
    footer = f"\n{bar}\n"
    if isinstance(prior, str):
        return header + prior + footer
    if isinstance(prior, list):
        parts: List[str] = []
        for f in prior:
            if not isinstance(f, dict):
                continue
            path = f.get("path", "?")
            contents = f.get("contents", "")
            parts.append(f"===FILE: {path}===\n{contents}\n===END===")
        return header + "\n".join(parts) + footer
    return ""
