"""
Read + slice helpers for the committed Shopify GraphQL example bank.

Reads from catalogs/ and produces a JIT-injected prompt fragment keyed on a
list of approved operations. Where `subagents/g_ops_picker_agent/shopify_ops.py`
slices the *schema summary* (field/type listings), this module slices the
*example bank* — worked GraphQL scenarios mined from shopify.dev.

Source of truth
---------------
catalogs/shopify_<surface>/examples.jsonl (admin only for now, storefront later).
Built by scripts/build_shopify_examples_bank.py.

Each JSONL row:
  {operation, kind, family, scenario_title, query, variables, response, source_url}

Public API
----------
  examples_for_ops(op_names, surface="admin", intent_hint=None) -> str
      Returns a formatted multi-op block (one canonical example per op).
      Empty string when:
        - the bank file is missing
        - none of the ops have examples (the 16 ops where shopify.dev has no
          worked example just fall back to schema-only — same behavior as today)

Graceful skip
-------------
If `examples.jsonl` doesn't exist (fresh checkout, surface not yet built),
the loader returns "" and the caller's prompt section is silently omitted.
The pipeline never crashes on a missing example bank.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, FrozenSet, List, Optional

log = logging.getLogger(__name__)

_CATALOGS_ROOT = Path(__file__).resolve().parent

_SURFACES: FrozenSet[str] = frozenset({"admin", "storefront"})

# Caps tuned to keep the injection block well under the budget agreed in
# SHOPIFY_KNOWLEDGE_PLAN.md (~500 tok per example × ~5 ops × 2 scenarios ≈
# 5k tok max). A scenario rarely exceeds ~400 tok when only the query +
# variables are kept; response samples are dropped because they don't help
# the model write the *call* — they help interpret the result, which the
# typecheck validator covers separately.
_MAX_QUERY_CHARS = 1800
_MAX_VARIABLES_CHARS = 600
_MAX_TOTAL_CHARS = 20000

# How many scenarios to inject per op. Top-2 is cheap insurance against a
# bad intent_hint signal: when zero-overlap-with-any-title makes top-1
# arbitrary, top-2 hedges by also showing the runner-up. Diversity is
# automatic since scenarios within one op already have distinct titles.
_SCENARIOS_PER_OP = 2

_TOKEN_RE = re.compile(r"[a-z0-9]+")

_bank_cache: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}


def _bank_path(surface: str) -> Path:
    return _CATALOGS_ROOT / f"shopify_{surface}" / "examples.jsonl"


def _load_bank(surface: str) -> Dict[str, List[Dict[str, Any]]]:
    """Return {op_name: [scenario, …]}. Cached per surface."""
    if surface not in _SURFACES:
        raise ValueError(f"unknown surface: {surface!r}")
    if surface in _bank_cache:
        return _bank_cache[surface]
    path = _bank_path(surface)
    if not path.exists():
        log.warning(
            "examples bank: %s missing at %s — run "
            "`python platform-ai/scripts/build_shopify_examples_bank.py` to build it",
            surface,
            path,
        )
        _bank_cache[surface] = {}
        return _bank_cache[surface]
    bank: Dict[str, List[Dict[str, Any]]] = {}
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            bank.setdefault(row["operation"], []).append(row)
    _bank_cache[surface] = bank
    return bank


def _tokens(s: str) -> List[str]:
    return _TOKEN_RE.findall(s.lower())


def _pick_scenarios(
    scenarios: List[Dict[str, Any]],
    intent_hint: Optional[str],
    k: int = _SCENARIOS_PER_OP,
) -> List[Dict[str, Any]]:
    """
    Top-k scenarios by token overlap between `intent_hint` and
    `scenario_title`. Falls back to the first k scenarios when no hint /
    no overlap. Stable secondary sort on the original-list index keeps
    output deterministic across runs.

    No embeddings, no fuzzy lib — substring/overlap is enough at this scale
    (3-8 scenarios per op). Top-k (instead of top-1) is cheap insurance
    against a zero-overlap hint where top-1 would be effectively arbitrary.
    Tighter retrieval is a Phase 6 concern.
    """
    if len(scenarios) <= k:
        return scenarios
    if not intent_hint:
        return scenarios[:k]
    hint_tokens = set(_tokens(intent_hint))
    if not hint_tokens:
        return scenarios[:k]
    scored = [
        (
            len(hint_tokens & set(_tokens(s.get("scenario_title", "")))),
            -i,  # tiebreak: earlier-listed scenarios win (negate so sort desc keeps order)
            s,
        )
        for i, s in enumerate(scenarios)
    ]
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return [s for _, _, s in scored[:k]]


def _format_scenario(op: str, kind: str, scenario: Dict[str, Any]) -> str:
    title = scenario.get("scenario_title") or op
    query = (scenario.get("query") or "").strip()
    if len(query) > _MAX_QUERY_CHARS:
        query = query[:_MAX_QUERY_CHARS] + "\n# ... (truncated)"
    variables = scenario.get("variables")
    parts = [f"### {op} — {title}", "", "```graphql", query, "```"]
    if variables is not None:
        try:
            var_str = json.dumps(variables, indent=2, ensure_ascii=False)
        except (TypeError, ValueError):
            var_str = str(variables)
        if len(var_str) > _MAX_VARIABLES_CHARS:
            var_str = var_str[:_MAX_VARIABLES_CHARS] + "\n  // ... (truncated)"
        parts += ["", "Variables:", "```json", var_str, "```"]
    return "\n".join(parts)


def examples_for_ops(
    op_names: List[str],
    surface: str = "admin",
    intent_hint: Optional[str] = None,
) -> str:
    """
    Return a formatted multi-op example block (top-k scenarios per op),
    or "" if the bank is missing or no requested op has examples.

    `op_names` is the architect's approved list (same input as slice_summary).
    `intent_hint` is optional free-text describing what the handler is trying
    to do — used to pick the most relevant scenarios per op.
    """
    if not op_names:
        return ""
    bank = _load_bank(surface)
    if not bank:
        return ""
    blocks: List[str] = []
    total_chars = 0
    ops_rendered = 0
    truncated = False
    for op in op_names:
        scenarios = bank.get(op)
        if not scenarios:
            continue
        picks = _pick_scenarios(scenarios, intent_hint)
        for scenario in picks:
            kind = scenario.get("kind") or ""
            rendered = _format_scenario(op, kind, scenario)
            if total_chars + len(rendered) > _MAX_TOTAL_CHARS:
                truncated = True
                break
            blocks.append(rendered)
            total_chars += len(rendered)
        if truncated:
            blocks.append(
                f"# ... ({len(op_names) - ops_rendered - 1} more op(s) "
                "omitted to fit budget)"
            )
            break
        ops_rendered += 1
    if not blocks:
        return ""
    header = (
        f"Worked examples — top-{_SCENARIOS_PER_OP} scenarios per approved op, "
        "mined from shopify.dev. These are real, executable shapes; mirror\n"
        "them when writing your queries. Some approved ops have no example —\n"
        "write those from the schema slice above."
    )
    return header + "\n\n" + "\n\n".join(blocks)
