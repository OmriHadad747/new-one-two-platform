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
from subagents.static_validation import validate_widget_artifact

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
    max_tokens = 16000

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return _SYSTEM_PROMPT

    def user_prompt(self, ctx: CodegenContext) -> str:
        retry_block = self.format_retry_block(ctx.previous_errors)
        ux_block = _format_ux_guidance(ctx.plan)
        ux_expectations_block = _format_ux_expectations(ctx.plan)
        quality_brief_block = _format_quality_brief(ctx.intent)
        catalog_desc = _format_catalog(ctx.platform_api_catalog)
        prior_block = _format_prior_widget(ctx.prior_widget_code)

        return (
            f"{retry_block}"
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


def _format_quality_brief(intent: Dict[str, Any]) -> str:
    """Inject the product agent's quality brief so the widget knows what good UX looks like."""
    brief = intent.get("qualityBrief", "")
    if not brief:
        return ""
    return (
        "Quality brief — what makes a good version of this app:\n"
        f"{brief}\n\n"
    )


def _format_ux_expectations(plan: Dict[str, Any]) -> str:
    """Inject the architect's storefront UX expectations for this specific app type."""
    ux = (plan.get("appContracts") or {}).get("uxExpectations") or {}
    storefront = ux.get("storefront")
    if not storefront:
        return ""
    return (
        "UX expectations for this widget:\n"
        f"{storefront}\n\n"
    )


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
    lines = "\n".join(f"  - {g.get('gap', '')}: {g.get('mitigation', '')}" for g in gaps)
    return f"\nBackend limitations the widget UX must reflect:\n{lines}\n"
