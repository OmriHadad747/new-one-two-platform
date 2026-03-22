"""
Widget Config Sub-agent — generates the widget_config JSON for storefront_ui apps.

Produces a WidgetConfig object that the App Block renderer reads at runtime.
The App Block is written once by the platform developer; the AI generates only
the config that drives what it renders.

Widget types must match the App Block renderer registry. Current valid types:
  - notify_me
  - stock_counter
  - countdown

Model: claude-sonnet-4-6
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from models.adapter import get_code_llm, invoke, extract_json

# Widget types that exist in the App Block renderer registry.
# The AI must only use these — never generate raw HTML, Liquid, or JS.
VALID_WIDGET_TYPES = {"notify_me", "stock_counter", "countdown"}

SYSTEM_PROMPT = """You are configuring a widget for a Shopify storefront App Block.

The App Block is a pre-built renderer. Your job is to generate a JSON config that tells
the renderer what to display and what actions to wire up. You must NOT generate any
Liquid, HTML, or JavaScript — only the config JSON.

Widget types currently supported by the renderer:
  - notify_me      → shows an email input + submit button (e.g. "Notify me when back in stock")
  - stock_counter  → displays live inventory count or a low-stock warning
  - countdown      → shows a countdown timer to a deadline or restock date

OUTPUT FORMAT:
Return ONLY a JSON object with this exact shape:
{
  "widget_type": "notify_me" | "stock_counter" | "countdown",
  "trigger_condition": "out_of_stock" | "always" | "low_stock",
  "ui": {
    "button_text": "...",
    "input_placeholder": "...",
    "success_message": "...",
    "title": "..."
  },
  "actions": {
    "on_submit": "/relative/endpoint/path",
    "on_load": "/relative/endpoint/path",
    "data_source": "/relative/endpoint/path"
  }
}

RULES:
1. Output ONLY the JSON object — no markdown fences, no explanation
2. widget_type must be one of: notify_me, stock_counter, countdown
3. actions.on_submit / on_load / data_source must use paths from platformApiCatalog (omit if unused)
4. ui keys should be short merchant-facing strings (button text, placeholders, messages)
5. trigger_condition should reflect when the widget is visible to shoppers
6. Never include raw HTML, Liquid templates, or JavaScript"""


def run_widget_config_agent(
    intent: Dict[str, Any],
    api_plan: Dict[str, Any],
    platform_api_catalog: List[Dict[str, str]],
    previous_errors: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Generate widget_config JSON from the intent and API plan.

    Returns a dict conforming to the WidgetConfig schema.
    """
    llm = get_code_llm(max_tokens=512)

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

Platform API catalog (paths the widget actions can reference):
{catalog_desc}

API plan for context:
{json.dumps(api_plan, indent=2)}

Generate the widget_config JSON for this feature.
Output ONLY the JSON object."""

    result = invoke(llm, SYSTEM_PROMPT, user_prompt)
    raw = extract_json(result.content)
    parsed = json.loads(raw)

    return {
        "widget_type": parsed.get("widget_type", "notify_me"),
        "trigger_condition": parsed.get("trigger_condition"),
        "ui": parsed.get("ui", {}),
        "actions": parsed.get("actions", {}),
    }
