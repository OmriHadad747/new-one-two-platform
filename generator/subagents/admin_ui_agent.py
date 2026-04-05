"""
Admin UI Generator — produces a self-contained JavaScript ES module for the
Shopify Admin iframe panel.

Used for:
  - Category B apps (storefront_backend_admin): merchant dashboard alongside the
    storefront widget (e.g. subscriber lists, conversion metrics, email template config).
  - Category C admin-triggered apps (backend with trigger="admin"): a Polaris-style
    panel with a button or form that calls the backend handler.

The generated JS exports:
  export function mount(container, bridge)

WHERE:
  container — the DOM element the panel owns. Render all HTML inside it.
  bridge    — the ONLY interface to the outside world:
    bridge.context = { shop: string, tenantId: string }
    bridge.call(path, body?)  — POST to the platform backend. Returns Promise<any>.
                                 Uses the same backend handler paths as widget host.call().
    bridge.notify(message, variant?)  — show a toast notification.
                                        variant: "success" | "error" | "info" (default "info")

Only runs for storefront_backend_admin apps and backend apps with trigger="admin".

Model: claude-sonnet-4-6 (prefers_code_model = True)
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from subagents.base import CodegenContext, Generator
from subagents.validation import validate_admin_ui_artifact


_SYSTEM_PROMPT = """You are generating a Shopify Admin embedded panel as a self-contained JavaScript ES module.

The panel is loaded inside a Shopify Admin iframe. It calls:
  panel.mount(container, bridge)

WHERE:
  container — the DOM element the panel owns. Render all your HTML inside it.
  bridge    — the ONLY interface to the outside world. Its full shape:

    bridge.context = {
      shop: string,      // "example.myshopify.com"
      tenantId: string,  // platform tenant UUID
    }

    bridge.call(path, body?)     // POST to the platform backend handler. Returns Promise<any>.
                                  // path must be one of the paths in adminApiCatalog.
                                  // body is a plain JS object or undefined.

    bridge.notify(message, variant?)
                                  // Show a toast notification to the merchant.
                                  // variant: "success" | "error" | "info" (default "info")

DESIGN PRINCIPLES:
- The panel runs inside a Shopify Admin iframe that has already loaded Polaris. Polaris CSS
  custom properties are available globally — use them for ALL colors, spacing, and typography.
  DO NOT invent a custom color palette or hardcode any hex colors.

- The admin shell injects a base stylesheet into `container` BEFORE mount() is called.
  The following classes are ALREADY DEFINED — do NOT redefine them:

  Layout:     .shell-root  .shell-header  .shell-title  .shell-section-title
              .shell-card  .shell-stats-row  .shell-stat-card  .shell-stat-label  .shell-stat-value
              .shell-toolbar  .shell-search
  Table:      .shell-table-wrap  .shell-table  (th and td styled)
  Buttons:    .btn-primary  .btn-secondary  .btn-danger  (with :hover and :disabled states)
  Badges:     .badge  .badge-success  .badge-error  .badge-warning  .badge-neutral
  Feedback:   .shell-loading  .shell-spinner  .shell-empty  .shell-error-banner
  Pagination: .shell-pagination  .shell-pagination-btns
  Modal:      .shell-confirm-overlay  .shell-confirm-dialog  .shell-confirm-title
              .shell-confirm-body  .shell-confirm-actions

  Use these classes directly. Only add a <style> block for CSS that is genuinely
  specific to this app (custom columns, unique layouts, extra component variants).
  Keep app-specific CSS minimal.

  Essential Polaris CSS tokens to use:
    Colors:
      --p-color-bg-surface            background of cards / panels
      --p-color-bg-surface-secondary  slightly recessed background (table rows, sidebars)
      --p-color-bg-fill               fills for selected/hover states
      --p-color-bg-fill-success       success banner background
      --p-color-bg-fill-critical      error banner background
      --p-color-bg-fill-warning       warning banner background
      --p-color-text                  primary body text
      --p-color-text-secondary        muted / label text
      --p-color-text-success          success text
      --p-color-text-critical         error text
      --p-color-border                default border
      --p-color-border-emphasis       stronger border (dividers, active states)
      --p-color-icon                  icon color
    Spacing (base unit = 4px):
      --p-space-100 (4px)  --p-space-200 (8px)  --p-space-300 (12px)
      --p-space-400 (16px) --p-space-500 (20px) --p-space-600 (24px)
      --p-space-800 (32px) --p-space-1000 (40px)
    Border radius:
      --p-border-radius-100 (4px)  --p-border-radius-200 (8px)
      --p-border-radius-300 (12px) --p-border-radius-full (9999px)
    Typography:
      --p-font-family-sans
      --p-font-size-300 (12px label) --p-font-size-350 (14px body)
      --p-font-size-400 (16px heading) --p-font-size-500 (20px title)
      --p-font-weight-medium (500)  --p-font-weight-semibold (600)  --p-font-weight-bold (700)
    Shadow:
      --p-shadow-100  --p-shadow-200  --p-shadow-300

  Example card:
    .card {
      background: var(--p-color-bg-surface);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-200);
      padding: var(--p-space-400);
      box-shadow: var(--p-shadow-100);
      font-family: var(--p-font-family-sans);
      color: var(--p-color-text);
    }
  Example primary button:
    .btn-primary {
      background: #008060;   /* Shopify brand green — safe to hardcode */
      color: #fff;
      border: none;
      border-radius: var(--p-border-radius-100);
      padding: var(--p-space-200) var(--p-space-400);
      font-size: var(--p-font-size-350);
      font-weight: var(--p-font-weight-medium);
      cursor: pointer;
    }
  Example secondary button:
    .btn-secondary {
      background: var(--p-color-bg-surface);
      color: var(--p-color-text);
      border: 1px solid var(--p-color-border-emphasis);
      border-radius: var(--p-border-radius-100);
      padding: var(--p-space-200) var(--p-space-400);
      font-size: var(--p-font-size-350);
      font-weight: var(--p-font-weight-medium);
      cursor: pointer;
    }
  Example badge:
    .badge {
      display: inline-flex; align-items: center;
      padding: 2px var(--p-space-200);
      border-radius: var(--p-border-radius-full);
      font-size: var(--p-font-size-300);
      font-weight: var(--p-font-weight-semibold);
    }
    .badge-success { background: var(--p-color-bg-fill-success); color: var(--p-color-text-success); }
    .badge-error   { background: var(--p-color-bg-fill-critical); color: var(--p-color-text-critical); }

- Components: tables for list data, stat cards for metrics, action buttons, forms for config.
- Show loading states (spinner or skeleton) while bridge.call() is in progress.
- Show error states clearly when bridge.call() rejects.
- Paginate or limit large lists (show at most 50 rows; add "Load more" if needed).

RULES:
1. Export ONLY a named `mount` function: export function mount(container, bridge) { ... }
2. Render only inside `container` — never access the DOM outside it.
3. All backend requests use bridge.call(). NEVER use raw fetch(), XMLHttpRequest, or hardcoded URLs.
4. Never access window.* globals.
5. Never access document.* directly — only use container.querySelector / container.querySelectorAll /
   container.getElementById for DOM access. Validation rejects direct document.* calls.
   EXCEPTION: document.createElement and document.createTextNode are allowed for building DOM nodes.
6. Never use eval(), Function(), setTimeout (except for debounce with < 500ms), setInterval.
7. Never hardcode tenant IDs, shop domains, or entity IDs — read from bridge.context.
8. All bridge.call() paths must come from the adminApiCatalog — never invent paths.
9. Output ONLY the raw JavaScript — no markdown fences, no explanation, no comments outside the code.
10. Handle all bridge.call() rejections gracefully — show an error message in the UI.
11. If adminApiCatalog is empty, render a clear "Backend not configured" message.

LAYOUT PATTERNS:
  Read-only dashboard (list + stats):
    - Load data in mount() with bridge.call('/list') or similar
    - Render a stat summary row at the top (totals, counts)
    - Render a table below with the key fields
    - Add a "Refresh" button

  Action panel (trigger a backend operation):
    - Render a description of what the action does
    - Render a form (if the operation needs parameters) or a single button
    - On submit: call bridge.call(path, body), show loading, then bridge.notify on result
    - Disable the button while loading to prevent double-submit

  Config panel:
    - Load current config via bridge.call('/config/get')
    - Render editable fields
    - On save: call bridge.call('/config/save', values), then bridge.notify('Saved', 'success')"""


class AdminUiGenerator(Generator):
    name = "admin_ui"
    prefers_code_model = True
    max_tokens = 16000

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return _SYSTEM_PROMPT

    def user_prompt(self, ctx: CodegenContext) -> str:
        retry_block = self.format_retry_block(ctx.previous_errors)
        catalog_desc = _format_admin_catalog(ctx.plan)
        admin_spec_block = _format_admin_spec(ctx.plan)
        gaps_block = _format_gaps(ctx.plan)
        prior_block = _format_prior_admin_ui(ctx.prior_admin_ui_code)

        return (
            f"{retry_block}"
            f"App purpose: {ctx.intent.get('desiredOutcome', '')}\n"
            f"App category: {ctx.intent.get('appCategory', '')}\n"
            f"Trigger types: {', '.join(ctx.intent.get('triggerTypes', []))}\n\n"
            f"Admin API catalog (the ONLY paths the panel may call via bridge.call()):\n"
            f"{catalog_desc}\n"
            f"{admin_spec_block}"
            f"{gaps_block}"
            f"{prior_block}"
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
        return text.strip()

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        admin_catalog = _extract_admin_catalog(ctx.plan)
        return validate_admin_ui_artifact(artifact, admin_catalog)


# ── Private prompt-building helpers ───────────────────────────────────────────


def _extract_admin_catalog(plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    impl = plan.get("implementationSpec") or {}
    return impl.get("adminApiCatalog") or []


def _format_admin_catalog(plan: Dict[str, Any]) -> str:
    catalog = _extract_admin_catalog(plan)
    if not catalog:
        return "  (none — render a 'Backend not configured' message)"
    lines = []
    for e in catalog:
        shape = e.get("responseShape")
        shape_str = f" → {shape}" if shape else ""
        lines.append(f"  {e.get('method', 'POST')} {e['path']}{shape_str}")
    return "\n".join(lines)


def _format_admin_spec(plan: Dict[str, Any]) -> str:
    """Render codeSpec.adminPath steps as the authoritative bridge.call() contract."""
    impl = plan.get("implementationSpec") or {}
    steps: List[str] = (impl.get("codeSpec") or {}).get("adminPath") or []
    if not steps:
        return ""
    numbered = "\n".join(f"  {i + 1}. {s}" for i, s in enumerate(steps))
    return (
        f"\nAdmin UI contract (implement bridge.call() bodies and result checks exactly as specified):\n"
        f"{numbered}\n"
    )


def _format_gaps(plan: Dict[str, Any]) -> str:
    gaps = (plan.get("implementationSpec") or {}).get("platformGaps") or []
    if not gaps:
        return ""
    lines = "\n".join(f"  - {g['need']}: {g['mitigation']}" for g in gaps)
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
