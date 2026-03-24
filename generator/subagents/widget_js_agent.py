"""
Widget JS Generator — produces a self-contained ES module for storefront_ui apps.

The generated JS is loaded by the App Block runtime at storefront page load.
It must export a `mount(container, host)` function and interact with the outside
world exclusively through the `host` object.

The implementationSpec contributes two things:
  - platformGaps: UX should reflect backend limitations (e.g. show "you'll be
    notified" rather than "email sent" when the backend can only log intent).
  - widgetGuidance: feature-specific UX decisions from the Planner.

Only runs for storefront_ui apps — the registry entry is always present but
crew.py skips this generator for backend_only apps.

Model: claude-sonnet-4-6 (prefers_code_model = True)
"""
from __future__ import annotations

from typing import Any, Dict, List

from subagents.base import CodegenContext, Generator
from subagents.validation import validate_widget_js

_SYSTEM_PROMPT = """You are generating a Shopify storefront widget as a self-contained JavaScript ES module.

The widget is loaded by a thin runtime (App Block) that calls:
  widget.mount(container, host)

WHERE:
  container — the DOM element the widget owns. Render all your HTML inside it.
  host      — the ONLY interface to the outside world. Its full shape:

    host.context = {
      shop: string,          // "example.myshopify.com"
      productId: string|null,
      variantId: string|null,
      customerId: string|null,
    }

    host.call(path, body?)   // POST to your platform backend. Returns Promise<any>.
                             // path must be one of the paths in platformApiCatalog.
                             // body is optional for data-fetch calls.

    host.getFormData(form)   // Reads named inputs from a <form> element → plain object.

RULES:
1. Export ONLY a named `mount` function: export function mount(container, host) { ... }
2. Render only inside `container` — never access the DOM outside it
3. Use ONLY host.call() for backend requests — never fetch(), XMLHttpRequest, or any URL
4. Never access window.*, document.* (except container.querySelector patterns), or globals
5. Never use eval(), Function(), setTimeout, setInterval
6. Never hardcode tenant IDs, shop domains, or product IDs — read from host.context
7. All backend paths must come from the platformApiCatalog provided — never invent paths
8. Output ONLY the raw JavaScript — no markdown fences, no explanation, no comments outside the code

The widget can render any UI it needs: forms, counters, timers, multi-step flows, etc.
There are no restrictions on widget type — only on how it communicates with the outside world."""


class WidgetJsGenerator(Generator):
    name = "widget_js"
    prefers_code_model = True
    max_tokens = 2048

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return _SYSTEM_PROMPT

    def user_prompt(self, ctx: CodegenContext) -> str:
        retry_block = self.format_retry_block(ctx.previous_errors)
        ux_block = _format_ux_guidance(ctx.plan)
        catalog_desc = "\n".join(
            f"  {e['method']} {e['path']}" for e in ctx.platform_api_catalog
        )

        return (
            f"{retry_block}"
            f"Feature to build: {ctx.intent.get('desiredOutcome', '')}\n"
            f"Trigger type: {ctx.intent.get('triggerType', '')}\n\n"
            f"Platform API catalog (the ONLY paths the widget may call via host.call()):\n"
            f"{catalog_desc}\n"
            f"{ux_block}"
            "Generate the widget ES module. Output ONLY the raw JavaScript."
        )

    def parse(self, raw: str) -> str:
        return raw.strip()

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        return validate_widget_js(artifact, ctx.platform_api_catalog)


# ── Private prompt-building helpers ───────────────────────────────────────────


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
