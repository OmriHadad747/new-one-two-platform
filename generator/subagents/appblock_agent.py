"""
App Block Sub-agent — generates the Theme App Extension artifacts.

Produces three outputs:
  - liquid: Liquid template for the storefront UI
  - javascript: Client-side JavaScript (fetches to platform API catalog paths)
  - schema: Theme Editor schema (merchant-configurable settings)

The JavaScript must only call paths present in platformApiCatalog.
No hardcoded tenant data allowed.

Model: claude-sonnet-4-6
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from models.adapter import get_code_llm, invoke, extract_json

SYSTEM_PROMPT = """You are an expert Shopify theme developer building App Blocks (Theme App Extensions).

An App Block is a Liquid/JavaScript component that merchants install in their storefront theme
via the Shopify Theme Editor. Your job is to generate THREE separate artifacts:

1. **Liquid template** (`liquid`): The storefront UI rendered server-side by Shopify.
   - Use `{{ block.settings.<key> }}` to reference merchant-configurable settings.
   - Render the UI structure (buttons, forms, containers).
   - Do NOT make any API calls in Liquid — use JavaScript for client-side interactions.

2. **JavaScript** (`javascript`): Client-side interactions.
   - Handle user events (button clicks, form submissions).
   - Use fetch() ONLY to call paths listed in the platformApiCatalog — never arbitrary URLs.
   - Do NOT hardcode any tenant_id — these are dynamic values from the platform.

3. **Schema** (`schema`): Theme Editor configuration schema.
   - Expose merchant-configurable settings (button text, colors, messages, etc.)
   - Format: { "name": "...", "settings": [{ "type": "text", "id": "...", "label": "...", "default": "..." }] }

OUTPUT FORMAT:
Return ONLY a JSON object with this exact shape:
{
  "schema": { "name": "...", "settings": [...] },
  "liquid": "...",
  "javascript": "..."
}

ABSOLUTE RULES:
1. Output ONLY the JSON object — no markdown fences, no explanation
2. JavaScript fetch() calls must only use paths from the platformApiCatalog
3. No hardcoded tenant_id in any artifact
4. Liquid must be valid Shopify Liquid syntax
5. Schema must follow Shopify's Theme Editor schema format"""


def run_appblock_agent(
    intent: Dict[str, Any],
    api_plan: Dict[str, Any],
    platform_api_catalog: List[Dict[str, str]],
    previous_errors: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Generate App Block artifacts from the intent and API plan.

    Returns a dict with keys: schema, liquid, javascript.
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

Platform API catalog (the ONLY paths JavaScript can fetch):
{catalog_desc}

API plan for context:
{json.dumps(api_plan, indent=2)}

Generate the App Block artifacts (schema, liquid, javascript) for this feature.
Output ONLY the JSON object."""

    result = invoke(llm, SYSTEM_PROMPT, user_prompt)
    raw = extract_json(result.content)
    parsed = json.loads(raw)

    # Normalize schema field (Pydantic model uses 'schema' not 'schema_def')
    return {
        "schema": parsed.get("schema", {}),
        "liquid": parsed.get("liquid", ""),
        "javascript": parsed.get("javascript", ""),
    }
