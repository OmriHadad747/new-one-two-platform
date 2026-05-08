"""
Storefront Generator — produces the storefront widget ES module from the
LLD plan.

Consumes (all from `ctx.lld`):
  - externalContracts filtered to surface=="widget" → platformApiCatalog
  - widgetTargetTemplates → for downstream App Block targeting (read-only here)
  - uxExpectations.storefront → UX guidance
  - platformGaps[] with uxImplication → backend-limit-driven UX hints

Plus from `ctx.intent`:
  - desiredOutcome, triggerTypes, qualityBrief

Plus, on revision runs only:
  - ctx.prior_storefront_code → previously deployed widget source

Only runs for storefront archetypes — the registry entry is always
present but crew.py skips this generator when is_storefront is False.

Model: claude-sonnet-4-6 (via agent_models.py)
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from llm_validations.widget_artifact import validate_widget_artifact
from subagents.base import CodegenContext, Generator
from subagents.e_storefront_agent.prompt import STOREFRONT_BASE


class StorefrontGenerator(Generator):
    name = "storefront"
    max_tokens = 16000

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return STOREFRONT_BASE

    def user_prompt(self, ctx: CodegenContext) -> str:
        from catalogs.shopify_ajax import load_summary_md as load_ajax_summary

        catalog = _widget_catalog_from_lld(ctx.lld)
        ux_expectations = _format_ux_expectations(ctx.lld)
        ux_implications = _format_ux_implications(ctx.lld)
        quality_brief = _format_quality_brief(ctx.intent)
        catalog_block = _format_catalog(catalog)
        prior_block = _format_prior_storefront(ctx.prior_storefront_code)
        ajax_block = load_ajax_summary()

        return (
            f"Feature: {ctx.intent.get('desiredOutcome', '')}\n"
            f"Trigger types: {', '.join(ctx.intent.get('triggerTypes', []))}\n\n"
            f"{quality_brief}"
            f"{ux_expectations}"
            "Platform API catalog — the ONLY paths the widget may call via host.call().\n"
            "Use EXACTLY the requestShape shown when building the host.call() body.\n"
            "Expect EXACTLY the responseShape shown when reading the result.\n"
            f"{catalog_block}\n\n"
            f"{ajax_block}\n"
            f"{ux_implications}"
            f"{prior_block}"
            "Generate the widget ES module. Output ONLY raw JavaScript."
        )

    def parse(self, raw: str) -> str:
        text = re.sub(r"^```(?:javascript|js)?\s*", "", raw.strip(), flags=re.MULTILINE)
        text = re.sub(r"```\s*$", "", text.strip(), flags=re.MULTILINE)
        text = text.strip()
        # Strip any leading prose the model emitted before the JS code.
        # Widget modules always start with export/const/let/var/function/comment.
        js_start = re.search(
            r"^(export\s|const\s|let\s|var\s|function\s|//|/\*)", text, re.MULTILINE
        )
        if js_start and js_start.start() > 0:
            text = text[js_start.start() :]
        text = _sanitize_dom_access(text)
        return text.strip()

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        catalog = _widget_catalog_from_lld(ctx.lld)
        return validate_widget_artifact(artifact, catalog)


# ── Post-parse sanitisation ──────────────────────────────────────────────────


def _sanitize_dom_access(code: str) -> str:
    """Auto-fix common DOM access violations the LLM repeatedly generates.

    Targets patterns that are always wrong in a sandboxed widget:
      document.head.appendChild(el) → container.appendChild(el)
      document.body.appendChild(el) → container.appendChild(el)
    """
    code = re.sub(r"\bdocument\.head\b", "container", code)
    code = re.sub(r"\bdocument\.body\b", "container", code)
    return code


# ── LLD → catalog adapter ────────────────────────────────────────────────────


def _widget_catalog_from_lld(lld: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Build the widget's platformApiCatalog from `lld.externalContracts` filtered
    to surface=="widget". Preserves path / method / requestShape / responseShape
    in the shape the validator + worked example expect.

    Returns [] when the LLD is missing (legacy plan still in ctx.plan) or
    when the archetype is non-storefront — both cases are handled by the
    empty-catalog fallback in the prompt.
    """
    contracts = (lld or {}).get("externalContracts") or []
    return [
        {
            "path": c.get("path", ""),
            "method": (c.get("method") or "POST").upper(),
            "requestShape": c.get("requestShape") or {},
            "responseShape": c.get("responseShape") or {},
        }
        for c in contracts
        if isinstance(c, dict) and c.get("surface") == "widget"
    ]


# ── Prompt-section builders ──────────────────────────────────────────────────


def _format_quality_brief(intent: Dict[str, Any]) -> str:
    """Inject the product agent's quality brief so the widget knows what good UX looks like."""
    brief = intent.get("qualityBrief", "")
    if not brief:
        return ""
    return f"Quality brief — what makes a good version of this app:\n{brief}\n\n"


def _format_ux_expectations(lld: Dict[str, Any]) -> str:
    """Inject the LLD's storefront UX expectations for this specific app type."""
    ux = (lld or {}).get("uxExpectations") or {}
    storefront = ux.get("storefront")
    if not storefront:
        return ""
    return f"UX expectations for this widget:\n{storefront}\n\n"


def _format_ux_implications(lld: Dict[str, Any]) -> str:
    """Render platformGaps with uxImplication so the widget UX reflects backend limits."""
    gaps = (lld or {}).get("platformGaps") or []
    affecting_ux = [g for g in gaps if g.get("uxImplication")]
    if not affecting_ux:
        return ""
    lines = "\n".join(
        f"  - {g.get('gap', '')}: {g.get('uxImplication', '')}"
        for g in affecting_ux
    )
    return f"\nBackend limitations the widget UX must reflect:\n{lines}\n\n"


def _format_catalog(catalog: List[Dict[str, Any]]) -> str:
    """
    Format the widget API catalog with method, path, requestShape, responseShape.
    The requestShape is the exact body the widget must send to host.call().
    The responseShape is the exact object the handler returns.
    """
    if not catalog:
        return "  (none — empty catalog. If the feature requires persistent\n"\
               "         state, render a 'requires backend configuration'\n"\
               "         message rather than faking a successful save.)"
    lines = []
    for e in catalog:
        req = e.get("requestShape", "{}")
        resp = e.get("responseShape", "{}")
        lines.append(f"  {e['method']} {e['path']}")
        lines.append(f"    send:    host.call('{e['path']}', {req})")
        lines.append(f"    receive: {resp}")
    return "\n".join(lines)


def _format_prior_storefront(prior_code: Any) -> str:
    """
    Inject the currently deployed widget as context for revision runs.
    The model should apply targeted changes, not regenerate the whole widget.
    """
    if not prior_code:
        return ""
    return (
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "REVISION RUN — currently deployed widget module:\n"
        "(Apply the merchant feedback above as targeted changes to this code.\n"
        " Preserve all mount() logic and host.call() paths NOT being changed.)\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{prior_code}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )
