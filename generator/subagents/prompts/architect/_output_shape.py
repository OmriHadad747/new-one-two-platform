"""
Archetype-aware OUTPUT FORMAT section for the architect prompt.

Tailors the JSON example to the archetype so the model only sees fields relevant
to the surfaces it must actually populate. A backend app never sees widgetApiCatalog
in the example, reducing hallucination risk.
"""

_WIDGET_EXAMPLE = """\
    "widgetTargetTemplates": ["product"],
    "widgetApiCatalog": [
      {
        "path": "/example/action",
        "method": "POST",
        "requestShape": { "variantId": "string" },
        "responseShape": { "success": "boolean" }
      }
    ],"""

_WIDGET_NULL = """\
    "widgetTargetTemplates": null,
    "widgetApiCatalog": null,"""

_ADMIN_EXAMPLE = """\
    "adminApiCatalog": [
      {
        "path": "/example/list",
        "method": "GET",
        "requestShape": { "page": "number", "page_size": "number" },
        "responseShape": { "items": [], "total": "number", "page": "number", "page_size": "number" }
      }
    ]"""

_ADMIN_NULL = """\
    "adminApiCatalog": null"""

_UX_STOREFRONT_PLACEHOLDER = '"<what the customer experience should feel like>"'
_UX_ADMIN_PLACEHOLDER = '"<what the merchant dashboard should prioritize>"'


def build_output_shape(archetype: str) -> str:
    """
    Returns the OUTPUT FORMAT section tailored to the given archetype.

    Fields for surfaces that do not exist in the archetype are shown as null —
    the LLM must emit every key in the schema.
    """
    has_widget = "storefront" in archetype
    has_admin = "admin" in archetype

    widget_block = _WIDGET_EXAMPLE if has_widget else _WIDGET_NULL
    admin_block = _ADMIN_EXAMPLE if has_admin else _ADMIN_NULL
    ux_storefront = _UX_STOREFRONT_PLACEHOLDER if has_widget else "null"
    ux_admin = _UX_ADMIN_PLACEHOLDER if has_admin else "null"

    return (
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "OUTPUT FORMAT — respond ONLY with this JSON (no markdown fences, no explanation):\n"
        "{\n"
        '  "shopifyPlan": {\n'
        '    "webhookTopics": [],\n'
        '    "cronSchedule": null\n'
        "  },\n"
        '  "appContracts": {\n'
        '    "feasibility": "feasible",\n'
        '    "blockedReason": null,\n'
        '    "complexity": "low",\n'
        '    "edgeCases": ["<specific edge case 1>", "<specific edge case 2>", "...3-6 total"],\n'
        '    "uxExpectations": {\n'
        f'      "storefront": {ux_storefront},\n'
        f'      "admin": {ux_admin}\n'
        "    },\n"
        '    "stateMachine": null,\n'
        '    "platformGaps": [],\n'
        '    "cronBatching": null,\n'
        '    "dbContracts": [\n'
        "      {\n"
        '        "table": "example_table",\n'
        '        "columns": [\n'
        '          { "name": "id",         "type": "UUID",        "constraints": "PRIMARY KEY DEFAULT gen_random_uuid()" },\n'
        '          { "name": "tenant_id",  "type": "UUID",        "constraints": "NOT NULL" },\n'
        '          { "name": "field_a",    "type": "TEXT",        "constraints": "NOT NULL" },\n'
        '          { "name": "field_b",    "type": "BIGINT",      "constraints": "NULL" },\n'
        '          { "name": "created_at", "type": "TIMESTAMPTZ", "constraints": "NOT NULL DEFAULT now()" }\n'
        "        ],\n"
        '        "uniqueConstraint": null,\n'
        '        "indexes": ["tenant_id"],\n'
        '        "rls": true\n'
        "      }\n"
        "    ],\n"
        '    "webhookContract": null,\n'
        '    "cronContract": null,\n'
        f"{widget_block}\n"
        f"{admin_block}\n"
        "  }\n"
        "}"
    )
