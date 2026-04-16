"""
Admin UI Generator — produces a self-contained JavaScript ES module for the
Shopify Admin iframe panel.

Used for archetypes: storefront_backend_admin, backend_admin.

The generated JS exports:
  export function mount(container, bridge)

WHERE:
  container — the DOM element the panel owns. Render all HTML inside it.
  bridge    — the ONLY interface to the outside world:
    bridge.context = { shop: string, tenantId: string }
    bridge.call(path, body?)          — POST to the platform backend. Returns Promise<any>.
    bridge.notify(message, variant?)  — show a toast. variant: "success"|"error"|"info"

Model: claude-sonnet-4-6 (via agent_models.py)
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from subagents.base import CodegenContext, Generator
from subagents.static_validation import validate_admin_ui_artifact


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

  The shell-* / btn-* / badge / badge-success / badge-error / badge-warning /
  badge-neutral classes are already defined by the shell stylesheet listed above
  — DO NOT redeclare them. Use them directly in your HTML:
    <div class="shell-card">...</div>
    <button class="btn-primary">Save</button>
    <span class="badge badge-success">Active</span>

  If you need a genuinely new CSS class (a custom layout, app-specific chip,
  extra variant), keep it short and reference Polaris tokens (--p-color-*,
  --p-space-*, --p-border-radius-*, --p-shadow-*, --p-font-*) for every value.
  Hardcoded hex colors are forbidden — they break the merchant's theme. The
  single exception is Shopify brand green (#008060), which is safe to hardcode
  if you explicitly need it.

- Components: tables for list data, stat cards for metrics, action buttons, forms for config.
- Show loading states (spinner or skeleton) while bridge.call() is in progress.
- Show error states clearly when bridge.call() rejects.
- Paginate large lists: use the `page_size` declared in the route's adminApiCatalog requestShape; do not introduce a different limit here.

RULES:
1. Export ONLY a named `mount` function: export function mount(container, bridge) { ... }
2. Render only inside `container` — never access the DOM outside it.
3. All backend requests use bridge.call(). NEVER use raw fetch(), XMLHttpRequest, or hardcoded URLs.
4. Never access window.* globals.
5. DOM scoping — route ALL DOM access through `container` or document creation helpers:
   ALLOWED:   container.querySelector()  container.querySelectorAll()
              container.appendChild()    container.innerHTML
              document.createElement()   document.createTextNode()
   FORBIDDEN: document.querySelector()  document.getElementById()
              document.body             document.head
              document.title            document.cookie
              window.* (any property)
   CSS/styles — inject into container, never document.head:
     const style = document.createElement('style');
     style.textContent = `.my-widget { color: red; }`;
     container.appendChild(style);
6. Never use eval(), Function(), setTimeout (except for debounce with ≤500ms), setInterval.
7. Never hardcode tenant IDs, shop domains, or entity IDs — read from bridge.context.
8. All bridge.call() paths must come from the adminApiCatalog — never invent paths.
9. Output ONLY the raw JavaScript — no markdown fences, no explanation, no comments outside the code.
10. Handle all bridge.call() rejections gracefully — show an error message in the UI.
11. NEVER use React, JSX, or any JavaScript framework — vanilla DOM only.
    FORBIDDEN: import statements of any kind (import React, import { useState }, etc.)
    FORBIDDEN: export default function — the only allowed export is export function mount
    FORBIDDEN: JSX syntax — use document.createElement() / innerHTML for all DOM construction
    FORBIDDEN: React.createElement(), useState(), useEffect(), useRef(), or any React API
12. NEVER hardcode hex colors except #008060 (Shopify brand green — safe to hardcode).
    For ALL other colors use Polaris CSS custom properties (--p-color-*).
    Example: color: var(--p-color-text) NOT color: #1a1a1a
    Hardcoded hex colors break the merchant's theme (dark mode, high-contrast accessibility).
13. NEVER use container.innerHTML += after any container.appendChild() call.
    innerHTML-assign serializes the DOM back to an HTML string and re-parses it, destroying
    all previously appended DOM nodes and their event listeners.
    Safe pattern: assign container.innerHTML = '...' ONCE at the start of mount() to set the
    full HTML skeleton, then call container.appendChild(styleEl) to append the <style> last.

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
    max_tokens = 16000

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return _SYSTEM_PROMPT

    def user_prompt(self, ctx: CodegenContext) -> str:
        catalog_desc = _format_admin_catalog(ctx.plan)
        gaps_block = _format_gaps(ctx.plan)
        ux_expectations_block = _format_ux_expectations(ctx.plan)
        quality_brief_block = _format_quality_brief(ctx.intent)
        prior_block = _format_prior_admin_ui(ctx.prior_admin_ui_code)

        return (
            f"App purpose: {ctx.intent.get('desiredOutcome', '')}\n"
            f"App category: {ctx.intent.get('appCategory', '')}\n"
            f"Trigger types: {', '.join(ctx.intent.get('triggerTypes', []))}\n\n"
            f"{quality_brief_block}"
            f"{ux_expectations_block}"
            f"Admin API catalog — the ONLY paths the panel may call via bridge.call().\n"
            f"Use EXACTLY the requestShape shown when building the bridge.call() body.\n"
            f"Expect EXACTLY the responseShape shown when reading the result.\n"
            f"{catalog_desc}\n"
            f"{gaps_block}"
            f"{prior_block}"
            "\nCRITICAL (validation rejects violations):\n"
            "- NEVER document.head / document.body — append styles and elements to `container`\n"
            "- NEVER import / export default — vanilla JS only, export function mount(...)\n\n"
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
        text = _sanitize_dom_access(text)
        return text.strip()

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        admin_catalog = _extract_admin_catalog(ctx.plan)
        return validate_admin_ui_artifact(artifact, admin_catalog)


# ── Post-parse sanitisation ──────────────────────────────────────────────────


def _sanitize_dom_access(code: str) -> str:
    """Auto-fix common DOM access violations that the LLM repeatedly generates.

    Targets patterns that are always wrong in a sandboxed admin panel:
      document.head.appendChild(el) → container.appendChild(el)
      document.body.appendChild(el) → container.appendChild(el)
    """
    code = re.sub(r"\bdocument\.head\b", "container", code)
    code = re.sub(r"\bdocument\.body\b", "container", code)
    return code


# ── Private prompt-building helpers ───────────────────────────────────────────


def _format_quality_brief(intent: Dict[str, Any]) -> str:
    """Inject the product agent's quality brief so the admin UI knows what good UX looks like."""
    brief = intent.get("qualityBrief", "")
    if not brief:
        return ""
    return (
        "Quality brief — what makes a good version of this app:\n"
        f"{brief}\n\n"
    )


def _format_ux_expectations(plan: Dict[str, Any]) -> str:
    """Inject the architect's admin UX expectations for this specific app type."""
    ux = (plan.get("appContracts") or {}).get("uxExpectations") or {}
    admin = ux.get("admin")
    if not admin:
        return ""
    return (
        "UX expectations for this admin panel:\n"
        f"{admin}\n\n"
    )


def _extract_admin_catalog(plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    impl = plan.get("appContracts") or {}
    return impl.get("adminApiCatalog") or []


def _format_admin_catalog(plan: Dict[str, Any]) -> str:
    catalog = _extract_admin_catalog(plan)
    lines = []
    for e in catalog:
        req = e.get("requestShape", "{}")
        resp = e.get("responseShape", "{}")
        lines.append(f"  {e.get('method', 'POST')} {e['path']}")
        lines.append(f"    send:    bridge.call('{e['path']}', {req})")
        lines.append(f"    receive: {resp}")
    return "\n".join(lines)


def _format_gaps(plan: Dict[str, Any]) -> str:
    gaps = (plan.get("appContracts") or {}).get("platformGaps") or []
    if not gaps:
        return ""
    lines = "\n".join(f"  - {g.get('gap', '')}: {g.get('mitigation', '')}" for g in gaps)
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
