"""
Read + slice helpers for the committed Shopify GraphQL catalogs.

Two consumers
-------------
1. The Architect prompt — needs the FULL operation index so it can pick
   which operations the handler should use, and emit those names back in
   `appContracts.shopifyGraphqlOperations`. Use `load_summary(surface)`.

2. The Handler prompt — needs ONLY the operations the architect approved,
   so the handler picks field names from a tight whitelist instead of
   hallucinating from the full schema. Use `slice_summary(surface, names)`.

Both paths share the same source-of-truth file
(`catalogs/shopify_<surface>/<version>/summary.md`) and the same version
pin (`WEBHOOK_API_VERSION` in webhook.py). A single bump there refreshes
every consumer.

Graceful skip
-------------
If a catalog isn't built yet (storefront on first install, or any version
mismatch), the loaders return a placeholder string and the validation
helpers return all-names-invalid. The pipeline never crashes on a missing
catalog.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Dict, FrozenSet, List, Optional

from subagents.prompts.topics.webhook import WEBHOOK_API_VERSION

log = logging.getLogger(__name__)

_CATALOGS_ROOT = Path(__file__).resolve().parent.parent / "catalogs"

# Each operation in summary.md is one line that starts with the op name
# followed by either `(` (op with args) or `:` (op with no args). The build
# script enforces this format.
_OP_LINE_RE = re.compile(r"^(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*[(:]")


# ── Surfaces ──────────────────────────────────────────────────────────────────

_SURFACES: FrozenSet[str] = frozenset({"admin", "storefront"})


def _summary_path(surface: str, version: str) -> Path:
    return _CATALOGS_ROOT / f"shopify_{surface}" / version / "summary.md"


# ── Caching ───────────────────────────────────────────────────────────────────
#
# The full admin summary is ~75 KB. Reading it once per process is fine; a
# small cache keyed on (surface, version) keeps repeated calls free.

_summary_cache: Dict[str, str] = {}
_op_index_cache: Dict[str, Dict[str, str]] = {}


def _load_raw(surface: str, version: str) -> Optional[str]:
    if surface not in _SURFACES:
        raise ValueError(f"unknown surface: {surface!r}")
    cache_key = f"{surface}:{version}"
    if cache_key in _summary_cache:
        return _summary_cache[cache_key]
    path = _summary_path(surface, version)
    if not path.exists():
        log.warning(
            "catalog: %s %s missing at %s — run "
            "`python platform-ai/scripts/refresh_shopify_graphql_catalog.py %s %s` to build it",
            surface,
            version,
            path,
            surface,
            version,
        )
        return None
    text = path.read_text(encoding="utf-8")
    _summary_cache[cache_key] = text
    return text


def _build_op_index(surface: str, version: str) -> Dict[str, str]:
    """
    Return {op_name: full_line} for every operation in the catalog.

    Cached per (surface, version) — the slicer hits this on every handler
    run and string-matching the whole summary on each call would be wasteful.
    """
    cache_key = f"{surface}:{version}"
    if cache_key in _op_index_cache:
        return _op_index_cache[cache_key]
    raw = _load_raw(surface, version)
    if raw is None:
        _op_index_cache[cache_key] = {}
        return {}
    index: Dict[str, str] = {}
    for line in raw.splitlines():
        m = _OP_LINE_RE.match(line)
        if m:
            index[m.group("name")] = line
    _op_index_cache[cache_key] = index
    return index


# ── Public API ────────────────────────────────────────────────────────────────


def load_summary(surface: str, version: str = WEBHOOK_API_VERSION) -> str:
    """
    Return the FULL summary.md for a surface, or a placeholder if the
    catalog isn't built. Used by the architect — it needs to see every
    available operation to pick the right ones.
    """
    raw = _load_raw(surface, version)
    if raw is None:
        return (
            f"(no Shopify {surface} catalog committed for {version} — "
            f"run `python platform-ai/scripts/refresh_shopify_graphql_catalog.py "
            f"{surface} {version}` to build it"
            + (
                "; storefront also requires DEV_STOREFRONT_TOKEN env var)"
                if surface == "storefront"
                else ")"
            )
        )
    return raw


def slice_summary(
    surface: str,
    op_names: List[str],
    version: str = WEBHOOK_API_VERSION,
) -> str:
    """
    Return a markdown slice containing ONLY the operations in `op_names`.

    Skipped silently if the catalog is missing (returns "" — the caller's
    prompt section is omitted). Names not present in the catalog are
    dropped from the slice; `validate_op_names` catches them upstream so
    the architect re-runs before the handler ever sees the slice.
    """
    if not op_names:
        return ""
    index = _build_op_index(surface, version)
    if not index:
        return ""
    lines: List[str] = []
    queries: List[str] = []
    mutations: List[str] = []
    # The catalog summary is sectioned `## Queries` then `## Mutations`. We
    # preserve that split in the slice so the handler can tell at a glance
    # which ops are reads vs writes.
    raw = _summary_cache.get(f"{surface}:{version}", "")
    in_section = "queries"
    for line in raw.splitlines():
        if line.startswith("## Mutations"):
            in_section = "mutations"
            continue
        if line.startswith("## Queries"):
            in_section = "queries"
            continue
        m = _OP_LINE_RE.match(line)
        if not m:
            continue
        if m.group("name") in op_names:
            (queries if in_section == "queries" else mutations).append(line)

    if queries:
        lines.append(f"## Queries — {len(queries)} approved")
        lines.append("")
        lines.extend(queries)
        lines.append("")
    if mutations:
        lines.append(f"## Mutations — {len(mutations)} approved")
        lines.append("")
        lines.extend(mutations)
        lines.append("")

    return "\n".join(lines).rstrip()


def validate_op_names(
    surface: str,
    op_names: List[str],
    version: str = WEBHOOK_API_VERSION,
) -> List[str]:
    """
    Return the names that do NOT exist in the surface's catalog.

    If the catalog isn't built, returns [] (graceful skip) — the architect
    can't be expected to pick from a catalog that hasn't been refreshed,
    and forcing the run to fail would block all generation.
    """
    if not op_names:
        return []
    index = _build_op_index(surface, version)
    if not index:
        return []
    return [name for name in op_names if name not in index]


# ── Test hook ─────────────────────────────────────────────────────────────────


def _reset_caches() -> None:
    """For tests only — clear all internal caches."""
    _summary_cache.clear()
    _op_index_cache.clear()
