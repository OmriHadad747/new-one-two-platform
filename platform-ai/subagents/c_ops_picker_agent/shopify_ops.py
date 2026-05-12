"""
Read + slice helpers for the committed Shopify GraphQL catalogs.

Three consumers
---------------
1. The Architect / Ops-picker prompts — need the FULL operation index so
   they can pick which ops the handler should use. Use `load_summary(surface)`.

2. The Handler prompt — needs ONLY the operations the architect approved,
   so it picks field names from a tight whitelist instead of hallucinating
   from the full schema. Use `slice_summary(surface, names)`.

3. The LLD prompt — needs the full per-op detail (signature, return-type
   SDL, input types, examples) for each op the ops-picker selected, plus
   the runtime ability to look up nested types on demand:
     - `load_op_details(surface, op_names)` returns per-op detail records.
     - `lookup_type(surface, type_name)` backs the LLD's tool-call to
       fetch one type's SDL when a nested selection isn't covered by the
       op's bundled examples.

All paths share the same source-of-truth files under
`catalogs/shopify_<surface>/<version>/` and the same version pin
(`WEBHOOK_API_VERSION` in webhook.py). A single bump refreshes every consumer.

Graceful skip
-------------
If a catalog isn't built yet (storefront on first install, or any version
mismatch), the loaders return a placeholder string and the validation
helpers return all-names-invalid. The pipeline never crashes on a missing
catalog.
"""

from __future__ import annotations

import functools
import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, FrozenSet, Iterable, List, Optional

from subagents.e_codegen_agent.backend_agent.constants import WEBHOOK_API_VERSION

log = logging.getLogger(__name__)

# platform-ai/subagents/c_ops_picker_agent/shopify_ops.py
# -> platform-ai/catalogs ⇒ 3 parents.
_CATALOGS_ROOT = Path(__file__).resolve().parent.parent.parent / "catalogs"

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


def get_op_names(
    surface: str,
    version: str = WEBHOOK_API_VERSION,
) -> frozenset[str]:
    """
    Return the set of operation names for `surface`. Empty set if the
    catalog isn't built. Used by the ops-picker agent for offline
    catalog-membership checks on its picks (Pydantic alone cannot see
    the catalog; the runner cross-references against this set).
    """
    return frozenset(_build_op_index(surface, version).keys())


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


# ── Per-op detail + type lookup (LLD inputs) ─────────────────────────────────
#
# operations_detail.json and types_sdl.json are produced by
# catalogs/scripts/build_operations_detail.py. The LLD agent gets per-op
# detail injected into its user prompt for every op the ops-picker selected,
# plus a `lookup_type` tool backed by `lookup_type(...)` below for nested
# types its examples don't cover.


def _operations_detail_path(surface: str, version: str) -> Path:
    return _CATALOGS_ROOT / f"shopify_{surface}" / version / "operations_detail.json"


def _types_sdl_path(surface: str, version: str) -> Path:
    return _CATALOGS_ROOT / f"shopify_{surface}" / version / "types_sdl.json"


@functools.lru_cache(maxsize=4)
def _load_operations_detail(surface: str, version: str) -> Dict[str, Dict[str, Any]]:
    """
    Load the per-op detail map. Cached so repeated runs in one process
    pay the parse cost once. Returns {} if the file is missing.
    """
    if surface not in _SURFACES:
        raise ValueError(f"unknown surface: {surface!r}")
    path = _operations_detail_path(surface, version)
    if not path.exists():
        log.warning(
            "catalog: %s %s operations_detail.json missing at %s — run "
            "`python platform-ai/catalogs/scripts/build_operations_detail.py %s %s` "
            "to build it",
            surface,
            version,
            path,
            surface,
            version,
        )
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


@functools.lru_cache(maxsize=4)
def _load_types_sdl(surface: str, version: str) -> Dict[str, str]:
    """
    Load the {type_name: sdl} map. Cached. Returns {} if missing.
    """
    if surface not in _SURFACES:
        raise ValueError(f"unknown surface: {surface!r}")
    path = _types_sdl_path(surface, version)
    if not path.exists():
        log.warning(
            "catalog: %s %s types_sdl.json missing at %s — run "
            "`python platform-ai/catalogs/scripts/build_operations_detail.py %s %s` "
            "to build it",
            surface,
            version,
            path,
            surface,
            version,
        )
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def load_op_details(
    surface: str,
    op_names: Iterable[str],
    version: str = WEBHOOK_API_VERSION,
) -> Dict[str, Dict[str, Any]]:
    """
    Return {op_name: detail_record} for the requested ops, drawn from
    operations_detail.json. Names not present in the catalog are silently
    omitted — the ops-picker runner already validates membership against
    `get_op_names`, so a miss here would mean the file is stale or being
    rebuilt; either way the caller can degrade gracefully (LLD still has
    the ops-picker note + summary line).
    """
    table = _load_operations_detail(surface, version)
    if not table:
        return {}
    return {name: table[name] for name in op_names if name in table}


def lookup_type(
    surface: str,
    type_name: str,
    version: str = WEBHOOK_API_VERSION,
) -> Optional[str]:
    """
    Return the SDL for one type, or None if it isn't in the catalog.
    Backs the LLD's `lookup_type` tool — called only when the LLD needs to
    nest into a type its op's examples don't already show.
    """
    table = _load_types_sdl(surface, version)
    return table.get(type_name)


# ── Test hook ─────────────────────────────────────────────────────────────────


def _reset_caches() -> None:
    """For tests only — clear all internal caches."""
    _summary_cache.clear()
    _op_index_cache.clear()
    _load_operations_detail.cache_clear()
    _load_types_sdl.cache_clear()
