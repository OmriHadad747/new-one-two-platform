"""
Offline GraphQL validator for generated handler bundles.

Why
---
The backend agent writes Shopify GraphQL queries inside template literals
passed to `shopify.graphql / shopify.graphqlPaginate / shopify.bulkQuery`
(Admin API) and `shopify.storefront` (Storefront API). The Shopify schemas
have ~270 queries and ~480 mutations across ~3000 types each — far beyond
what the model can hold reliably. Without a deterministic schema check,
the generator emits queries with typo'd field names, wrong arg types, or
deprecated fields that only fail at runtime against a real shop.

How
---
1. Extract every GraphQL string passed to a known `shopify.*` helper from
   the handler bundle. Tag each with the surface (admin vs storefront) so
   we validate against the right schema.
2. For each query: `parse()` + `validate(schema, ast)` from graphql-core.
3. Map graphql-core errors back to actionable finding strings the handler
   agent can fix on retry — file path, helper name, error code, message.

Graceful skip on every failure mode:
  - `graphql-core` not installed → return [].
  - Catalog directory missing for a surface → log warning + skip queries
    on that surface.
  - Bundle parse failure → return [] (the bundle parser already flagged it).

The catalog version pins to `WEBHOOK_API_VERSION` so a single bump in
webhook.py refreshes everything that talks to Shopify.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from subagents.o_codegen_agent.backend_agent.constants import WEBHOOK_API_VERSION
from utils.file_bundle import is_file_bundle, parse_file_bundle

log = logging.getLogger(__name__)

# ── Surface routing ───────────────────────────────────────────────────────────
#
# Maps Shopify helper method names to the catalog surface their query strings
# should validate against. Adding a new helper to src/lib/shopify.ts requires
# adding it here so the validator routes its queries to the right schema.

_ADMIN_HELPERS = frozenset({"graphql", "graphqlPaginate", "bulkQuery"})
_STOREFRONT_HELPERS = frozenset({"storefront"})

# Catalog locations. The build script writes to the same paths.
# platform-ai/subagents/o_codegen_agent/backend_agent/graphql_check.py
# -> platform-ai/catalogs ⇒ 4 parents.
_CATALOGS_ROOT = Path(__file__).resolve().parent.parent.parent.parent / "catalogs"


# ── Query extraction ──────────────────────────────────────────────────────────
#
# Match `shopify.<helper>(\`...\`)` and capture the backtick contents. We also
# accept named binding hops via `const shopify = await shopifyClientFor(...)`
# — the regex looks for the literal `shopify.<helper>` as the call site, which
# is the convention every prompt teaches.
#
# The pattern handles `shopify.graphql<T>(...)` typed-call syntax (the type arg
# in angle brackets) by allowing an optional `<...>` between the helper name
# and the opening paren.

_HELPER_NAMES_GROUP = "|".join(sorted(_ADMIN_HELPERS | _STOREFRONT_HELPERS))
_QUERY_RE = re.compile(
    rf"""shopify\.(?P<helper>{_HELPER_NAMES_GROUP})\b   # shopify.<helper>
        (?:<[^>]*>)?                                    # optional <T> generic
        \s*\(                                           # opening paren
        \s*`(?P<query>[^`]*)`                           # backtick-delimited query
    """,
    re.VERBOSE,
)


def _extract_queries(file_path: str, source: str) -> List[Tuple[str, str, str]]:
    """
    Return [(file_path, helper_name, query_string)] for every shopify.* call.

    `query_string` is the raw template-literal contents — no `${...}`
    interpolation handling: graphql-core parses interpolated strings as
    syntactically invalid (the dollar isn't part of GraphQL syntax). We
    do a lightweight `${...}` → `_PLACEHOLDER_` substitution before
    handing to graphql-core so the rest of the query still validates.
    """
    out: List[Tuple[str, str, str]] = []
    for m in _QUERY_RE.finditer(source):
        raw = m.group("query")
        # Replace ${expr} with a placeholder identifier. graphql-core would
        # otherwise reject the query as a parse error and we'd lose every
        # downstream finding from the same query. Using `_X` (a valid GraphQL
        # name char sequence) keeps it parseable as a bare identifier in
        # whatever context the interpolation appeared in.
        cleaned = re.sub(r"\$\{[^}]*\}", "_X", raw)
        out.append((file_path, m.group("helper"), cleaned))
    return out


# ── Schema loading + caching ──────────────────────────────────────────────────


_schema_cache: Dict[str, "Optional[object]"] = {}


def _load_schema(surface: str, version: str = WEBHOOK_API_VERSION):
    """
    Return the parsed GraphQLSchema for (surface, version), or None if the
    catalog isn't available. Cached per-process — schema files are large
    (3MB+) and the parse is non-trivial.
    """
    cache_key = f"{surface}:{version}"
    if cache_key in _schema_cache:
        return _schema_cache[cache_key]

    try:
        from graphql import build_schema
    except ImportError:
        log.warning("graphql: graphql-core not installed — skipping gate")
        _schema_cache[cache_key] = None
        return None

    sdl_path = _CATALOGS_ROOT / f"shopify_{surface}" / version / "schema.graphql"
    if not sdl_path.exists():
        log.warning(
            "graphql: catalog missing for %s %s (%s) — skipping queries on this surface. "
            "Run `python platform-ai/scripts/refresh_shopify_graphql_catalog.py %s %s` to build it.",
            surface,
            version,
            sdl_path,
            surface,
            version,
        )
        _schema_cache[cache_key] = None
        return None

    try:
        sdl = sdl_path.read_text(encoding="utf-8")
        schema = build_schema(sdl, assume_valid_sdl=True)
    except Exception as err:
        log.warning(
            "graphql: failed to load %s schema (%s) — skipping gate", surface, err
        )
        _schema_cache[cache_key] = None
        return None

    _schema_cache[cache_key] = schema
    return schema


# ── Public entry point ────────────────────────────────────────────────────────


def validate_backend_graphql(handler_bundle: str) -> List[str]:
    """
    Validate every Shopify GraphQL query in the handler bundle against the
    committed catalog schemas.

    Returns
    -------
    List of finding strings, one per graphql-core diagnostic, in the format
        "[<path>] shopify.<helper> query: <code>: <message>"
    Empty list = clean validation, missing graphql-core, missing catalog,
    or no Shopify queries in the bundle.
    """
    if not is_file_bundle(handler_bundle):
        return []
    try:
        files = parse_file_bundle(handler_bundle)
    except Exception as err:
        log.warning("graphql: bundle parse failed (%s) — skipping gate", err)
        return []
    if not files:
        return []

    try:
        from graphql import parse, validate
        from graphql.error import GraphQLError
    except ImportError:
        log.warning("graphql: graphql-core not installed — skipping gate")
        return []

    # Walk every .ts file, extract queries, group by surface so we load each
    # schema at most once.
    by_surface: Dict[str, List[Tuple[str, str, str]]] = {"admin": [], "storefront": []}
    for entry in files:
        path = entry["path"]
        if not path.endswith(".ts"):
            continue
        for fp, helper, query in _extract_queries(path, entry["contents"]):
            if helper in _ADMIN_HELPERS:
                by_surface["admin"].append((fp, helper, query))
            elif helper in _STOREFRONT_HELPERS:
                by_surface["storefront"].append((fp, helper, query))
            # else: unknown helper — extractor regex shouldn't produce this

    findings: List[str] = []
    for surface, items in by_surface.items():
        if not items:
            continue
        schema = _load_schema(surface)
        if schema is None:
            # Catalog missing or graphql-core unavailable — skip this surface.
            # _load_schema already logged the reason.
            continue

        for file_path, helper, query in items:
            # Parse first — a parse error short-circuits validate().
            try:
                ast = parse(query)
            except GraphQLError as err:
                findings.append(_format_parse_error(file_path, helper, err))
                continue

            errors = validate(schema, ast)
            for err in errors:
                findings.append(_format_validation_error(file_path, helper, err))

    return findings


# ── Error formatting ──────────────────────────────────────────────────────────


def _format_parse_error(file_path: str, helper: str, err) -> str:
    msg = err.message if hasattr(err, "message") else str(err)
    loc = ""
    if getattr(err, "locations", None):
        first = err.locations[0]
        loc = f" at line {first.line}:{first.column}"
    return f"[{file_path}] shopify.{helper} query parse error{loc}: {msg}"


def _format_validation_error(file_path: str, helper: str, err) -> str:
    msg = err.message if hasattr(err, "message") else str(err)
    loc = ""
    if getattr(err, "locations", None):
        first = err.locations[0]
        loc = f" at line {first.line}:{first.column}"
    return f"[{file_path}] shopify.{helper} query{loc}: {msg}"
