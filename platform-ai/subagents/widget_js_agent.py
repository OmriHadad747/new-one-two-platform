"""
Widget JS Generator — produces a self-contained ES module for storefront_backend / storefront_backend_admin apps.

The generated JS is loaded by the App Block runtime at storefront page load.
It must export a `mount(container, host)` function and interact with the outside
world exclusively through the `host` object.

platformGaps from appContracts carry UX implications when a backend limitation
affects the widget (e.g. async delivery → show intent, not action completion).

Only runs for storefront_backend / storefront_backend_admin apps — the registry entry is always present but
crew.py skips this generator for backend apps.

Model: claude-sonnet-4-6 (via agent_models.py)
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from subagents.base import CodegenContext, Generator
from subagents.prompts.core.widget import WIDGET_BASE
from llm_validations.widget_artifact import validate_widget_artifact
from subagents.prompts.capabilities import WIDGET_CAPABILITY_DOCS


class WidgetJsGenerator(Generator):
    name = "widget_js"
    max_tokens = 16000

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return WIDGET_BASE

    def user_prompt(self, ctx: CodegenContext) -> str:
        jit_sections = _build_jit_sections(ctx.plan)
        ux_block = _format_ux_guidance(ctx.plan)
        ux_expectations_block = _format_ux_expectations(ctx.plan)
        quality_brief_block = _format_quality_brief(ctx.intent)
        catalog_desc = _format_catalog(ctx.platform_api_catalog)
        prior_block = _format_prior_widget(ctx.prior_widget_code)

        return (
            f"{jit_sections}"
            f"Feature to build: {ctx.intent.get('desiredOutcome', '')}\n"
            f"Trigger types: {', '.join(ctx.intent.get('triggerTypes', []))}\n\n"
            f"{quality_brief_block}"
            f"{ux_expectations_block}"
            f"Platform API catalog — the ONLY paths the widget may call via host.call().\n"
            f"Use EXACTLY the requestShape shown when building the host.call() body.\n"
            f"Expect EXACTLY the responseShape shown when reading the result.\n"
            f"{catalog_desc}\n"
            f"{ux_block}"
            f"{prior_block}"
            "\nCRITICAL (validation rejects violations):\n"
            "- NEVER document.head / document.body — append styles and elements to `container`\n"
            "- NEVER setInterval — use event-driven patterns only\n"
            "- setTimeout only for debounce (literal ms ≤500). Never a polling loop.\n\n"
            "Generate the widget ES module. Output ONLY the raw JavaScript."
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
        return validate_widget_artifact(artifact, ctx.platform_api_catalog)


# ── Post-parse sanitisation ──────────────────────────────────────────────────


def _sanitize_dom_access(code: str) -> str:
    """Auto-fix common DOM access violations that the LLM repeatedly generates.

    Targets patterns that are always wrong in a sandboxed widget/panel:
      document.head.appendChild(el) → container.appendChild(el)
      document.body.appendChild(el) → container.appendChild(el)
    """
    code = re.sub(r"\bdocument\.head\b", "container", code)
    code = re.sub(r"\bdocument\.body\b", "container", code)
    return code


# ── JIT capability section builder ────────────────────────────────────────────


def _build_jit_sections(plan: Dict[str, Any]) -> str:
    """
    Inject capability docs for each widgetCapability the architect declared.

    Mirrors handler_agent._build_jit_sections: iterate the registry in its
    declared order (stable assembly → cache-friendly for the same cap set),
    emit .docs for every entry that appears in widgetCapabilities. Undeclared
    capabilities are absent from the prompt so the model cannot call APIs the
    architect did not authorize.
    """
    impl = plan.get("appContracts") or {}
    declared = set(impl.get("widgetCapabilities") or [])
    sections: List[str] = []
    for cap_name, docs in WIDGET_CAPABILITY_DOCS.items():
        if cap_name in declared and docs:
            sections.append(docs)
    return "\n\n".join(sections) + ("\n\n" if sections else "")


# ── Private prompt-building helpers ───────────────────────────────────────────


def _format_quality_brief(intent: Dict[str, Any]) -> str:
    """Inject the product agent's quality brief so the widget knows what good UX looks like."""
    brief = intent.get("qualityBrief", "")
    if not brief:
        return ""
    return "Quality brief — what makes a good version of this app:\n" f"{brief}\n\n"


def _format_ux_expectations(plan: Dict[str, Any]) -> str:
    """Inject the architect's storefront UX expectations for this specific app type."""
    ux = (plan.get("appContracts") or {}).get("uxExpectations") or {}
    storefront = ux.get("storefront")
    if not storefront:
        return ""
    return "UX expectations for this widget:\n" f"{storefront}\n\n"


def _format_prior_widget(prior_code: Any) -> str:
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
        " Preserve all mount() logic and host.call() paths that are NOT being changed.)\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{prior_code}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )


def _format_catalog(catalog: List[Dict[str, Any]]) -> str:
    """
    Format the widget API catalog with requestShape and responseShape.
    The requestShape is the exact body the widget must send to host.call().
    The responseShape is the exact object the handler returns.
    """
    if not catalog:
        return "  (none)"
    lines = []
    for e in catalog:
        req = e.get("requestShape", "{}")
        resp = e.get("responseShape", "{}")
        lines.append(f"  {e['method']} {e['path']}")
        lines.append(f"    send:    host.call('{e['path']}', {req})")
        lines.append(f"    receive: {resp}")
    return "\n".join(lines)


def _format_ux_guidance(plan: Dict[str, Any]) -> str:
    """Render platformGaps UX implications for the widget generator."""
    gaps = (plan.get("appContracts") or {}).get("platformGaps") or []
    if not gaps:
        return ""
    lines = "\n".join(
        f"  - {g.get('gap', '')}: {g.get('mitigation', '')}" for g in gaps
    )
    return f"\nBackend limitations the widget UX must reflect:\n{lines}\n"
