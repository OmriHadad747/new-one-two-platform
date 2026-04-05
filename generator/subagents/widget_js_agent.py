"""
Widget JS Generator — produces a self-contained ES module for storefront_backend / storefront_backend_admin apps.

The generated JS is loaded by the App Block runtime at storefront page load.
It must export a `mount(container, host)` function and interact with the outside
world exclusively through the `host` object.

The implementationSpec contributes two things:
  - platformGaps: UX should reflect backend limitations (e.g. show "you'll be
    notified" rather than "email sent" when the backend can only log intent).
  - widgetGuidance: feature-specific UX decisions from the Planner.

Only runs for storefront_backend / storefront_backend_admin apps — the registry entry is always present but
crew.py skips this generator for backend apps.

Model: claude-sonnet-4-6 (prefers_code_model = True)
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from subagents.base import CodegenContext, Generator
from subagents.validation import validate_widget_artifact

_SYSTEM_PROMPT = """You are generating a Shopify storefront widget as a self-contained JavaScript ES module.

The widget is loaded by a thin runtime (App Block) that calls:
  widget.mount(container, host)

WHERE:
  container — the DOM element the widget owns. Render all your HTML inside it.
  host      — the ONLY interface to the outside world. Its full shape:

    host.context = {
      shop: string,           // "example.myshopify.com"
      customerId: string|null,// Shopify customer ID, null for guests
    }
    // host.context has NO product/variant/page fields — the runtime is a generic loader.
    // To access any Shopify page data, read the current URL then call host.storefront():
    //   location.pathname  — e.g. "/products/my-handle", "/collections/sale"
    //   location.search    — e.g. "?variant=12345"
    // location.pathname and location.search are the ONLY browser globals you may access.

    host.call(path, body?)        // POST to your platform backend. Returns Promise<any>.
                                  // Use ONLY for: DB reads/writes, Admin-API-only data, mutations.
                                  // NEVER use for data available from Shopify's public storefront API.
                                  // path must be one of the paths in platformApiCatalog.

    host.storefront(relativePath) // Fetch Shopify's public storefront endpoints. Returns Promise<any>.
                                  // Use for ALL publicly available Shopify data.
                                  // relativePath must be a relative path (no hostname).
                                  // Examples:
                                  //   host.storefront('/products/' + handle + '.js')    → product JSON
                                  //   host.storefront('/collections/' + handle + '.js') → collection JSON
                                  //   host.storefront('/cart.js')                       → cart JSON

    host.getFormData(form)        // Reads named inputs from a <form> element → plain object.

RULES:
1. Export ONLY a named `mount` function: export function mount(container, host) { ... }
2. Render only inside `container` — never access the DOM outside it
3. For backend requests use host.call(). For Shopify public storefront data use host.storefront().
   NEVER use raw fetch(), XMLHttpRequest, or hardcoded URLs.
   Decision rule: if the data is publicly available from Shopify's storefront (product details,
   variant availability, pricing, cart) → host.storefront(). If it requires your backend
   (DB state, Admin-API-only data, writes) → host.call().
4. Never access window.*, document.* (except container.querySelector patterns), or globals.
   EXCEPTION: location.pathname and location.search are allowed for reading the current page URL.
5. Never use eval(), Function(), setTimeout, setInterval
6. Never hardcode tenant IDs, shop domains, or entity IDs.
   Read shop and customerId from host.context. Read all other page/entity context from the
   URL (location.pathname / location.search) and resolve via host.storefront().
7. All host.call() paths must come from the platformApiCatalog — never invent paths.
   host.storefront() paths are Shopify's public paths, not from the catalog.
8. Output ONLY the raw JavaScript — no markdown fences, no explanation, no comments outside the code
9. If platformApiCatalog is empty and the feature requires persistent data collection (e.g. an
   email signup form), do NOT silently collect data that will be discarded — render a clear
   "this feature requires backend configuration" message instead. Never fake a successful save.

The widget can render any UI it needs: forms, counters, timers, multi-step flows, etc.
There are no restrictions on widget type — only on how it communicates with the outside world."""


class WidgetJsGenerator(Generator):
    name = "widget_js"
    prefers_code_model = True
    max_tokens = 16000

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return _SYSTEM_PROMPT

    def user_prompt(self, ctx: CodegenContext) -> str:
        retry_block = self.format_retry_block(ctx.previous_errors)
        ux_block = _format_ux_guidance(ctx.plan)
        catalog_desc = _format_catalog(ctx.platform_api_catalog)
        widget_spec_block = _format_widget_spec(ctx.plan)
        prior_block = _format_prior_widget(ctx.prior_widget_code)

        return (
            f"{retry_block}"
            f"Feature to build: {ctx.intent.get('desiredOutcome', '')}\n"
            f"Trigger types: {', '.join(ctx.intent.get('triggerTypes', []))}\n\n"
            f"Platform API catalog (the ONLY paths the widget may call via host.call()):\n"
            f"{catalog_desc}\n"
            f"{widget_spec_block}"
            f"{ux_block}"
            f"{prior_block}"
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
        return text.strip()

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        return validate_widget_artifact(artifact, ctx.platform_api_catalog)


# ── Private prompt-building helpers ───────────────────────────────────────────


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
    """Format the API catalog with response shapes so the widget uses exact field names."""
    if not catalog:
        return "  (none)"
    lines = []
    for e in catalog:
        shape = e.get("responseShape")
        shape_str = f" → {shape}" if shape else ""
        lines.append(f"  {e['method']} {e['path']}{shape_str}")
    return "\n".join(lines)


def _format_widget_spec(plan: Dict[str, Any]) -> str:
    """
    Render codeSpec.widgetPath steps as the authoritative host.call() contract.
    The planner writes the exact field names the widget must send AND the exact
    response shape the handler returns — both sides are generated from these steps.
    """
    impl = plan.get("implementationSpec") or {}
    steps: List[str] = (impl.get("codeSpec") or {}).get("widgetPath") or []
    if not steps:
        return ""
    numbered = "\n".join(f"  {i + 1}. {s}" for i, s in enumerate(steps))
    return (
        f"\nWidget API contract (implement host.call() bodies and result checks exactly as specified):\n"
        f"{numbered}\n"
    )


def _format_ux_guidance(plan: Dict[str, Any]) -> str:
    """Render UX-relevant fields from implementationSpec for the widget developer."""
    impl = plan.get("implementationSpec") or {}
    parts: List[str] = []

    gaps = impl.get("platformGaps") or []
    if gaps:
        lines = "\n".join(f"  - {g['need']}: {g['mitigation']}" for g in gaps)
        parts.append(f"\nBackend limitations the widget UX should reflect:\n{lines}")

    guidance = (impl.get("widgetGuidance") or "").strip()
    if guidance:
        parts.append(f"\nWidget guidance:\n  {guidance}")

    return "\n".join(parts) + "\n" if parts else ""
