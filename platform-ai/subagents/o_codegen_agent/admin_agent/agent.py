"""
Admin Generator — produces the admin-panel ES module from the LLD plan.

Consumes (all from `ctx.lld`):
  - httpRoutes.admin → adminApiCatalog (path / method / requestShape /
                       responseShape / paginationKind)
  - uxExpectations.admin → UX guidance
  - uxExpectations.adminShapes → triggers WORKED EXAMPLES via the
                       admin_shapes dispatcher
  - stateMachine → state vocabulary (badges, filters)
  - database.tables → column enums (for filter dropdowns, badges)
  - platformGaps[] with uxImplication → backend-limit-driven UX hints

Plus from `ctx.intent`:
  - desiredOutcome, qualityBrief

Plus, on revision runs only:
  - ctx.prior_admin_ui_code → previously deployed admin source

Only runs for admin archetypes (`storefront_backend_admin`,
`backend_admin`) — the registry entry is always present but crew.py
skips this generator when is_admin_ui is False.

Generator name is kept as `admin_ui` so the existing artifacts-dict
key, CLI labels, and cross-artifact validator paths continue to work.

Model: claude-sonnet-4-6 (via agent_models.py)
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from subagents.base import CodegenContext, Generator
from subagents.o_codegen_agent.admin_agent.admin_shapes import examples_for_admin
from subagents.o_codegen_agent.admin_agent.prompt import ADMIN_BASE
from subagents.o_codegen_agent.admin_agent.validator import validate_admin_ui_artifact
from subagents.m_pre_codegen_agent import format_alignment_for


class AdminGenerator(Generator):
    name = "admin_ui"
    max_tokens = 16000

    # ── Generator interface ────────────────────────────────────────────────────

    def system_prompt(self) -> str:
        return ADMIN_BASE

    def user_prompt(self, ctx: CodegenContext) -> str:
        catalog = _admin_catalog_from_lld(ctx.lld)
        ux_expectations = _format_ux_expectations(ctx.lld)
        ux_implications = _format_ux_implications(ctx.lld)
        quality_brief = _format_quality_brief(ctx.intent)
        catalog_block = _format_catalog(catalog)
        state_machine_block = _format_state_machine(ctx.lld)
        column_enums_block = _format_column_enums(ctx.lld)
        prior_block = _format_prior_admin_ui(ctx.prior_admin_ui_code)
        examples_block = _format_examples(ctx.lld, ctx.intent)
        alignment_block = format_alignment_for(ctx.alignment_notes, self.name)

        # Message ordered by cache stability (most stable first), so a
        # future cache_control breakpoint between sections lets retries
        # of the same admin panel reuse the prefix:
        #   1. examples_block   — shape-matched examples (stable per app)
        #   2. catalog + LLD    — per-app
        #   3. alignment block  — per-app (kept after catalog so rules
        #                          reference fields already enumerated)
        #   4. tail             — volatile request line
        return (
            f"App purpose: {ctx.intent.get('desiredOutcome', '')}\n"
            f"App category: {ctx.intent.get('appCategory', '')}\n\n"
            f"{examples_block}"
            f"{quality_brief}"
            f"{ux_expectations}"
            f"{state_machine_block}"
            f"{column_enums_block}"
            "Admin API catalog — the ONLY paths the panel may call via bridge.call().\n"
            "Use EXACTLY the requestShape shown when building the bridge.call() body.\n"
            "Expect EXACTLY the responseShape shown when reading the result.\n"
            f"{catalog_block}\n"
            f"{ux_implications}"
            f"{alignment_block}"
            f"{prior_block}"
            "Generate the admin panel ES module. Output ONLY raw JavaScript."
        )

    def parse(self, raw: str) -> str:
        text = re.sub(r"^```(?:javascript|js)?\s*", "", raw.strip(), flags=re.MULTILINE)
        text = re.sub(r"```\s*$", "", text.strip(), flags=re.MULTILINE)
        text = text.strip()
        # Strip any leading prose the model emitted before the JS code.
        # Admin modules always start with export/const/let/var/function/comment.
        js_start = re.search(
            r"^(export\s|const\s|let\s|var\s|function\s|//|/\*)", text, re.MULTILINE
        )
        if js_start and js_start.start() > 0:
            text = text[js_start.start() :]
        text = _sanitize_dom_access(text)
        return text.strip()

    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        catalog = _admin_catalog_from_lld(ctx.lld)
        db_contracts = _db_contracts_from_lld(ctx.lld)
        return validate_admin_ui_artifact(artifact, catalog, db_contracts)


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


# ── LLD → catalog adapter ────────────────────────────────────────────────────


def _admin_catalog_from_lld(lld: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Build the admin's adminApiCatalog from `lld.httpRoutes.admin[]`.
    Mirrors `e_storefront_agent._widget_catalog_from_lld` — preserves
    path / method / requestShape / responseShape / paginationKind in the
    shape the validator + worked examples expect.

    Returns [] when the LLD is missing or when the archetype is non-
    admin — both cases collapse to the empty-catalog branch in the
    formatter.
    """
    routes = ((lld or {}).get("httpRoutes") or {}).get("admin") or []
    return [
        {
            "path": r.get("path", ""),
            "method": (r.get("method") or "POST").upper(),
            "requestShape": r.get("requestShape") or {},
            "responseShape": r.get("responseShape") or {},
            "paginationKind": r.get("paginationKind"),
        }
        for r in routes
        if isinstance(r, dict)
    ]


def _db_contracts_from_lld(lld: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Adapt `lld.database.tables[]` into the `dbContracts` shape that
    `validate_admin_ui_artifact` (and the column-enum prompt block)
    expect. The legacy plan.appContracts.dbContracts has the same shape;
    this is the LLD equivalent.

    Shape: [{table: <name>, columns: [{name: <col>, enum: [<values>]}]}].
    Columns without an enum are still included — the consumers tolerate
    missing keys.
    """
    tables = ((lld or {}).get("database") or {}).get("tables") or []
    out: List[Dict[str, Any]] = []
    for t in tables:
        if not isinstance(t, dict):
            continue
        cols: List[Dict[str, Any]] = []
        for c in t.get("columns") or []:
            if not isinstance(c, dict):
                continue
            entry: Dict[str, Any] = {"name": c.get("name", "?")}
            enum_vals = c.get("enum")
            if isinstance(enum_vals, list) and enum_vals:
                entry["enum"] = enum_vals
            cols.append(entry)
        out.append({"table": t.get("name", "?"), "columns": cols})
    return out


# ── Prompt-section builders ──────────────────────────────────────────────────


def _format_examples(lld: Dict[str, Any], intent: Dict[str, Any]) -> str:
    """Append shape-matched worked examples picked by the admin_shapes
    dispatcher. Empty string when no shape matches (e.g. legacy LLDs
    with no adminShapes and no recognisable route shape)."""
    bodies = examples_for_admin(lld or {}, intent or {})
    if not bodies:
        return ""
    sep = "━" * 60
    parts = [
        "",
        sep,
        "WORKED EXAMPLES — shape-matched by admin_shapes dispatcher",
        sep,
        "",
    ]
    for body in bodies:
        parts.append(body.rstrip())
        parts.append("")
    return "\n".join(parts) + "\n"


def _format_quality_brief(intent: Dict[str, Any]) -> str:
    """Inject the product agent's quality brief so the admin panel knows what
    good UX looks like."""
    brief = intent.get("qualityBrief", "")
    if not brief:
        return ""
    return f"Quality brief — what makes a good version of this app:\n{brief}\n\n"


def _format_ux_expectations(lld: Dict[str, Any]) -> str:
    """Inject the LLD's admin UX expectations for this specific app type."""
    ux = (lld or {}).get("uxExpectations") or {}
    admin = ux.get("admin")
    if not admin:
        return ""
    return f"UX expectations for this admin panel:\n{admin}\n\n"


def _format_ux_implications(lld: Dict[str, Any]) -> str:
    """Render platformGaps with uxImplication so the admin UX reflects backend
    limits."""
    gaps = (lld or {}).get("platformGaps") or []
    affecting_ux = [g for g in gaps if g.get("uxImplication")]
    if not affecting_ux:
        return ""
    lines = "\n".join(
        f"  - {g.get('gap', '')}: {g.get('uxImplication', '')}" for g in affecting_ux
    )
    return f"\nBackend limitations the admin UX must reflect:\n{lines}\n\n"


def _format_catalog(catalog: List[Dict[str, Any]]) -> str:
    """
    Format the admin API catalog with method, path, requestShape,
    responseShape, paginationKind. The requestShape is the exact body
    the panel must send to bridge.call(). The responseShape is the
    exact object the handler returns. paginationKind drives the panel's
    pagination control choice (offset → page numbers, cursor → load-
    more / prev-next, inline → no controls).
    """
    if not catalog:
        return (
            "  (none — empty catalog. Render a 'requires backend "
            "configuration' message rather than faking screens.)"
        )
    lines = []
    for e in catalog:
        req = e.get("requestShape", "{}")
        resp = e.get("responseShape", "{}")
        pk = e.get("paginationKind")
        lines.append(f"  {e['method']} {e['path']}")
        lines.append(f"    send:    bridge.call('{e['path']}', {req})")
        lines.append(f"    receive: {resp}")
        if pk:
            lines.append(f"    paginationKind: {pk}")
    return "\n".join(lines)


def _format_state_machine(lld: Dict[str, Any]) -> str:
    """
    Inject the canonical state vocabulary when the LLD declared a
    stateMachine. Without this the admin generator has no way to know
    which status values the handler actually sets, and invents filter
    options (e.g. "skipped") that the handler never produces — leaving
    dead options the merchant cannot act on.

    The set rendered is the union of every `from` and `to` value across
    transitions; those are the ONLY status values the admin may
    reference in filters, badges, or conditional rendering.

    `kind` is surfaced because it changes how to render null state:
      observation → null is "never observed" (render "—" / "not yet")
      workflow    → null never occurs (every row carries a state)
    """
    sm = (lld or {}).get("stateMachine")
    if not isinstance(sm, dict):
        return ""
    transitions = sm.get("transitions") or []
    if not isinstance(transitions, list) or not transitions:
        return ""
    states: List[str] = []
    seen: set[str] = set()
    for t in transitions:
        if not isinstance(t, dict):
            continue
        for key in ("from", "to"):
            val = t.get(key)
            if isinstance(val, str) and val and val not in seen:
                states.append(val)
                seen.add(val)
    if not states:
        return ""
    kind = sm.get("kind", "workflow")
    column = sm.get("column", "status")
    table = sm.get("table", "?")
    values_csv = ", ".join(f'"{s}"' for s in states)
    null_hint = (
        "null on this column means 'never observed' — render as '—' or "
        "'Not yet' in the table, NOT as an empty badge."
        if kind == "observation"
        else "every row carries one of these states (NOT NULL); no null "
        "handling required."
    )
    return (
        f"Status vocabulary — the handler stores these EXACT values in "
        f'`{table}.{column}` (stateMachine kind="{kind}"):\n'
        f"  [{values_csv}]\n"
        f"  {null_hint}\n"
        "When rendering filter dropdowns, status badges, or any UI that "
        "references a status value, use ONLY values from this list. Do "
        "NOT invent additional states; those render dead options the "
        "merchant cannot act on.\n\n"
    )


def _format_column_enums(lld: Dict[str, Any]) -> str:
    """
    Surface every column-level `enum` declared in the LLD database so
    the admin UI knows the canonical vocabulary for each enum field.
    Without this, the panel invents filter buttons and badge variants
    that the handler never emits, leaving them dead in the merchant-
    facing dashboard.

    Complements `_format_state_machine`: stateMachine covers Shopify-
    mirrored state columns, while column-level enums cover handler-
    owned status columns (queue rows, internal pipelines, etc.).
    """
    tables = ((lld or {}).get("database") or {}).get("tables") or []
    lines: List[str] = []
    for table in tables:
        if not isinstance(table, dict):
            continue
        tname = table.get("name", "?")
        for col in table.get("columns") or []:
            if not isinstance(col, dict):
                continue
            enum_values = col.get("enum")
            if not isinstance(enum_values, list) or not enum_values:
                continue
            values_csv = ", ".join(f'"{v}"' for v in enum_values)
            lines.append(f'  {tname}.{col["name"]}: [{values_csv}]')
    if not lines:
        return ""
    return (
        "Column enum vocabulary — the handler stores ONLY these literal "
        "values in each column:\n"
        + "\n".join(lines)
        + "\nWhen rendering filter dropdowns, status badges, or any UI "
        "that branches on one of these column values, use ONLY values "
        "from the matching list. Do NOT invent additional values "
        "(e.g. a 'converted' filter when the column enum is "
        "['pending','sent','failed']) — those render dead options the "
        "merchant cannot act on.\n\n"
    )


def _format_prior_admin_ui(prior_code: Any) -> str:
    """Inject the currently deployed admin UI as context for revision runs.
    The model should apply targeted changes, not regenerate the whole panel."""
    if not prior_code:
        return ""
    return (
        "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "REVISION RUN — currently deployed admin UI module:\n"
        "(Apply the merchant feedback above as targeted changes to this code.\n"
        " Preserve all mount() logic and bridge.call() paths NOT being changed.)\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{prior_code}\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )
