"""
Capability registries — single source of truth for every capability the
architect can declare on the generated app.

Each capability lives in its own module with per-agent views:
  ARCHITECT — short line for the architect's AVAILABLE list.
  HANDLER   — full implementation docs for handler JIT (where applicable).
  WIDGET    — full implementation docs for widget JIT (where applicable).
  REVISION  — one-line discipline rule for the revision compact surface
              (optional; omitted when the capability has no rule).

Per-capability modules:
  shopify_graphql.py      ARCHITECT / HANDLER / REVISION
  shopify_storefront.py   HANDLER_ARCHITECT / HANDLER_DOCS  (server-side)
                          WIDGET_ARCHITECT  / WIDGET_DOCS   (client-side)
  email.py                ARCHITECT / ARCHITECT_SPEC / HANDLER
  files.py                ARCHITECT / HANDLER
  npm.py                  NPM dict — one entry per npm package with
                          architect/handler/packages/usage_rule keys

Consumers:
  - Architect prompt — iterates HANDLER_ARCHITECT_ENTRIES /
    WIDGET_ARCHITECT_ENTRIES / ADMIN_ARCHITECT_ENTRIES for the AVAILABLE
    list via render_architect(). Also imports email.ARCHITECT_SPEC
    directly for the emailSpec field docs.
  - Handler JIT — looks up HANDLER_CAPABILITY_DOCS by declared capability.
  - Widget JIT — looks up WIDGET_CAPABILITY_DOCS by declared capability.
  - Revision surface — iterates HANDLER_REVISION_RULES.
  - Static validator — uses the ALLOWED_* frozensets; reads
    NPM[cap]["packages"] to gate handler imports.
"""

from __future__ import annotations

from . import email, files, npm, shopify_graphql, shopify_storefront

# ── Handler services (non-npm) ────────────────────────────────────────────────

HANDLER_SERVICES: dict[str, dict[str, str]] = {
    "shopify_graphql": {
        "architect": shopify_graphql.ARCHITECT,
        "handler": shopify_graphql.HANDLER,
        "revision": shopify_graphql.REVISION,
    },
    "storefront": {
        "architect": shopify_storefront.HANDLER_ARCHITECT,
        "handler": shopify_storefront.HANDLER_DOCS,
        "revision": "",
    },
    "email": {
        "architect": email.ARCHITECT,
        "handler": email.HANDLER,
        "revision": "",
    },
    "files": {
        "architect": files.ARCHITECT,
        "handler": files.HANDLER,
        "revision": "",
    },
}

# ── Widget capabilities ───────────────────────────────────────────────────────

WIDGET_CAPABILITIES: dict[str, dict[str, str]] = {
    "storefront": {
        "architect": shopify_storefront.WIDGET_ARCHITECT,
        "widget": shopify_storefront.WIDGET_DOCS,
    },
}

# ── Admin capabilities ────────────────────────────────────────────────────────
# Reserved for future use (App Bridge Toast / Modal / ResourcePicker).

ADMIN_CAPABILITIES: dict[str, dict[str, str]] = {}

# ── NPM capabilities ──────────────────────────────────────────────────────────

NPM = npm.NPM

# ── Assembled lookups ─────────────────────────────────────────────────────────

HANDLER_CAPABILITY_DOCS: dict[str, str] = {
    **{name: entry["handler"] for name, entry in HANDLER_SERVICES.items()},
    **{name: entry["handler"] for name, entry in NPM.items()},  # type: ignore[misc]
}

WIDGET_CAPABILITY_DOCS: dict[str, str] = {
    name: entry["widget"] for name, entry in WIDGET_CAPABILITIES.items()
}

HANDLER_ARCHITECT_ENTRIES: dict[str, str] = {
    **{name: entry["architect"] for name, entry in HANDLER_SERVICES.items()},
    **{name: entry["architect"] for name, entry in NPM.items()},  # type: ignore[misc]
}

WIDGET_ARCHITECT_ENTRIES: dict[str, str] = {
    name: entry["architect"] for name, entry in WIDGET_CAPABILITIES.items()
}

ADMIN_ARCHITECT_ENTRIES: dict[str, str] = {
    name: entry["architect"] for name, entry in ADMIN_CAPABILITIES.items()
}

# Revision compact-surface rules (skips empty strings).
HANDLER_REVISION_RULES: list[str] = [
    rule
    for entry in list(HANDLER_SERVICES.values()) + list(NPM.values())  # type: ignore[misc]
    if (rule := entry.get("revision") or entry.get("usage_rule"))
]

# ── Validator allow-lists ─────────────────────────────────────────────────────

ALLOWED_HANDLER_CAPABILITIES: frozenset = frozenset(
    list(HANDLER_SERVICES.keys()) + list(NPM.keys())
)

ALLOWED_WIDGET_CAPABILITIES: frozenset = frozenset(WIDGET_CAPABILITIES.keys())

ALLOWED_ADMIN_CAPABILITIES: frozenset = frozenset(ADMIN_CAPABILITIES.keys())


# ── Rendering helpers ─────────────────────────────────────────────────────────


def render_architect(entries: dict[str, str], indent: str = "    ") -> str:
    """Render a name → architect-line dict as a bullet list."""
    return "\n".join(f'{indent}- "{name}" — {line}' for name, line in entries.items())


def render_revision_rules(rules: list[str], indent: str = "  ") -> str:
    """Render revision one-liners as a bullet list. Empty list → empty string."""
    return "\n".join(f"{indent}- {rule}" for rule in rules)


__all__ = [
    "ADMIN_ARCHITECT_ENTRIES",
    "ADMIN_CAPABILITIES",
    "ALLOWED_ADMIN_CAPABILITIES",
    "ALLOWED_HANDLER_CAPABILITIES",
    "ALLOWED_WIDGET_CAPABILITIES",
    "HANDLER_ARCHITECT_ENTRIES",
    "HANDLER_CAPABILITY_DOCS",
    "HANDLER_REVISION_RULES",
    "HANDLER_SERVICES",
    "NPM",
    "WIDGET_ARCHITECT_ENTRIES",
    "WIDGET_CAPABILITIES",
    "WIDGET_CAPABILITY_DOCS",
    "render_architect",
    "render_revision_rules",
]
