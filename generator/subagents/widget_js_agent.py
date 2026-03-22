"""
Widget JS Sub-agent — generates a self-contained ES module widget for storefront_ui apps.

The generated JS is loaded by the thin runtime (App Block) at storefront page load.
It must export a `mount(container, host)` function and interact with the outside
world exclusively through the `host` object (defined in /contract/host-contract.md).

There is no predefined list of widget types — the AI can render anything it needs
as long as it respects the host contract.

Model: claude-sonnet-4-6
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from models.adapter import get_code_llm, invoke

SYSTEM_PROMPT = """You are generating a Shopify storefront widget as a self-contained JavaScript ES module.

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


def run_widget_js_agent(
    intent: Dict[str, Any],
    api_plan: Dict[str, Any],
    platform_api_catalog: List[Dict[str, str]],
    previous_errors: Optional[List[str]] = None,
) -> str:
    """
    Generate a widget JS ES module from the intent and API plan.

    Returns the raw JavaScript string (the full ES module source).
    """
    llm = get_code_llm(max_tokens=2048)

    catalog_desc = "\n".join(
        f"  {entry['method']} {entry['path']}" for entry in platform_api_catalog
    )

    retry_context = ""
    if previous_errors:
        retry_context = (
            "\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n"
            + "\n".join(f"- {e}" for e in previous_errors)
            + "\n\nFix ALL listed errors.\n"
        )

    user_prompt = f"""{retry_context}Feature to build: {intent.get('desiredOutcome', '')}
Trigger type: {intent.get('triggerType', '')}

Platform API catalog (the ONLY paths the widget may call via host.call()):
{catalog_desc}

Generate the widget ES module. Output ONLY the raw JavaScript."""

    result = invoke(llm, SYSTEM_PROMPT, user_prompt)
    return result.content.strip()
