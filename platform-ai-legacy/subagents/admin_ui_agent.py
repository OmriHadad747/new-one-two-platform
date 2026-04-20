"""
Admin UI Generator — produces a self-contained JavaScript ES module for the
Shopify Admin iframe panel.

Used for archetypes: storefront_backend_admin, backend_admin.

The generated JS exports:
  export function mount(container, bridge)

WHERE:
  container — the DOM element the panel owns. Render all HTML inside it.
  bridge    — the ONLY interface to the outside world:
    bridge.context = { shop: string, tenantId: string }
    bridge.call(path, body?)          — POST to the platform backend. Returns Promise<any>.
    bridge.notify(message, variant?)  — show a toast. variant: "success"|"error"|"info"

Model: claude-sonnet-4-6 (via agent_models.py)
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from subagents.base import CodegenContext, Generator
from subagents.prompts.admin import ADMIN_BASE
from subagents.static_validation import validate_admin_ui_artifact


class AdminUiGenerator(Generator):
    name = "admin_ui"
    max_tokens = 16000

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return ADMIN_BASE

    def user_prompt(self, ctx: CodegenContext) -> str:
        catalog_desc = _format_admin_catalog(ctx.plan)
        gaps_block = _format_gaps(ctx.plan)
        ux_expectations_block = _format_ux_expectations(ctx.plan)
        quality_brief_block = _format_quality_brief(ctx.intent)
        state_machine_block = _format_state_machine(ctx.plan)
        prior_block = _format_prior_admin_ui(ctx.prior_admin_ui_code)

        return (
            f"App purpose: {ctx.intent.get('desiredOutcome', '')}\n"
            f"App category: {ctx.intent.get('appCategory', '')}\n"
            f"Trigger types: {', '.join(ctx.intent.get('triggerTypes', []))}\n\n"
            f"{quality_brief_block}"
            f"{ux_expectations_block}"
            f"{state_machine_block}"
            f"Admin API catalog — the ONLY paths the panel may call via bridge.call().\n"
            f"Use EXACTLY the requestShape shown when building the bridge.call() body.\n"
            f"Expect EXACTLY the responseShape shown when reading the result.\n"
            f"{catalog_desc}\n"
            f"{gaps_block}"
            f"{prior_block}"
            "\nCRITICAL (validation rejects violations):\n"
            "- NEVER document.head / document.body — append styles and elements to `container`\n"
            "- NEVER import / export default — vanilla JS only, export function mount(...)\n\n"
            "Generate the Admin UI panel ES module. Output ONLY the raw JavaScript."
        )

    def parse(self, raw: str) -> str:
        text = re.sub(r"^```(?:javascript|js)?\s*", "", raw.strip(), flags=re.MULTILINE)
        text = re.sub(r"```\s*$", "", text.strip(), flags=re.MULTILINE)
        text = text.strip()
        # Strip any leading prose before the JS code.
        js_start = re.search(
            r"^(export\s|const\s|let\s|var\s|function\s|//|/\*)", text, re.MULTILINE
        )
        if js_start and js_start.start() > 0:
            text = text[js_start.start() :]
        text = _sanitize_dom_access(text)
        return text.strip()

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        admin_catalog = _extract_admin_catalog(ctx.plan)
        return validate_admin_ui_artifact(artifact, admin_catalog)


# ── Post-parse sanitisation ──────────────────────────────────────────────────


def _sanitize_dom_access(code: str) -> str:
    """Auto-fix common DOM access violations that the LLM repeatedly generates.

    Targets patterns that are always wrong in a sandboxed admin panel:
      document.head.appendChild(el) → container.appendChild(el)
      document.body.appendChild(el) → container.appendChild(el)
    """
    code = re.sub(r"\bdocument\.head\b", "container", code)
    code = re.sub(r"\bdocument\.body\b", "container", code)
    return code


# ── Private prompt-building helpers ───────────────────────────────────────────


def _format_quality_brief(intent: Dict[str, Any]) -> str:
    """Inject the product agent's quality brief so the admin UI knows what good UX looks like."""
    brief = intent.get("qualityBrief", "")
    if not brief:
        return ""
    return (
        "Quality brief — what makes a good version of this app:\n"
        f"{brief}\n\n"
    )


def _format_ux_expectations(plan: Dict[str, Any]) -> str:
    """Inject the architect's admin UX expectations for this specific app type."""
    ux = (plan.get("appContracts") or {}).get("uxExpectations") or {}
    admin = ux.get("admin")
    if not admin:
        return ""
    return (
        "UX expectations for this admin panel:\n"
        f"{admin}\n\n"
    )


def _format_state_machine(plan: Dict[str, Any]) -> str:
    """
    Inject the canonical state vocabulary when the architect declared a
    stateMachine. Without this the UI generator has no way to know which
    status values the handler actually sets, and invents filter options
    (e.g. "skipped") that the handler never produces — leaving the
    filter dead in the UI. The set below is the union of every `from`
    and `to` value across transitions; those are the ONLY status values
    the UI may reference in filters, badges, or conditional rendering.
    """
    sm = (plan.get("appContracts") or {}).get("stateMachine")
    if not isinstance(sm, dict):
        return ""
    transitions = sm.get("transitions") or []
    if not isinstance(transitions, list) or not transitions:
        return ""
    states: List[str] = []
    seen = set()
    for t in transitions:
        if not isinstance(t, dict):
            continue
        for key in ("from", "to"):
            val = t.get(key)
            if isinstance(val, str) and val and val not in seen:
                states.append(val)
                seen.add(val)
    if not states:
        return ""
    tracked = sm.get("trackedField") or "status"
    values_csv = ", ".join(f'"{s}"' for s in states)
    return (
        "Status vocabulary — the handler stores these EXACT values in the "
        f"`{tracked}` column:\n"
        f"  [{values_csv}]\n"
        "When rendering filter dropdowns, status badges, or any UI that "
        "references a status value, use ONLY values from this list. Do NOT "
        "invent additional states (e.g. a 'skipped' filter when the handler "
        "never sets 'skipped'); those render dead options the merchant "
        "cannot act on.\n\n"
    )


def _extract_admin_catalog(plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    impl = plan.get("appContracts") or {}
    return impl.get("adminApiCatalog") or []


def _format_admin_catalog(plan: Dict[str, Any]) -> str:
    catalog = _extract_admin_catalog(plan)
    lines = []
    for e in catalog:
        req = e.get("requestShape", "{}")
        resp = e.get("responseShape", "{}")
        lines.append(f"  {e.get('method', 'POST')} {e['path']}")
        lines.append(f"    send:    bridge.call('{e['path']}', {req})")
        lines.append(f"    receive: {resp}")
    return "\n".join(lines)


def _format_gaps(plan: Dict[str, Any]) -> str:
    gaps = (plan.get("appContracts") or {}).get("platformGaps") or []
    if not gaps:
        return ""
    lines = "\n".join(f"  - {g.get('gap', '')}: {g.get('mitigation', '')}" for g in gaps)
    return f"\nBackend limitations the admin UI should surface:\n{lines}\n"


def _format_prior_admin_ui(prior_code: Any) -> str:
    if not prior_code:
        return ""
    return (
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "REVISION RUN — currently deployed admin UI module:\n"
        "(Apply the merchant feedback above as targeted changes to this code.\n"
        " Preserve all mount() logic and bridge.call() paths that are NOT being changed.)\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{prior_code}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )
