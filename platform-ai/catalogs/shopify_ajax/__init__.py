"""
Shopify Ajax API catalog loader.

The Ajax API is the set of `*.js` / `*.json` REST endpoints that themes
(and our storefront widget) call from the shopper's browser. These are
the endpoints the widget reaches via `host.storefront(relativePath)`.

Shopify does not publish a machine-readable schema for this API — the
catalog under `endpoints.json` is hand-curated from
https://shopify.dev/docs/api/ajax. The Ajax API is theme-only and not
version-pinned, so there is no per-version directory.

  load_catalog()    -> dict  (raw structured catalog)
  load_summary_md() -> str   (compact prompt-injection prose)
  endpoint(id)      -> dict  (single entry by id, e.g. "product.get")
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List

_CATALOG_DIR = Path(__file__).resolve().parent
_ENDPOINTS_FILE = _CATALOG_DIR / "endpoints.json"
_SUMMARY_FILE = _CATALOG_DIR / "summary.md"


@lru_cache(maxsize=1)
def load_catalog() -> Dict[str, Any]:
    """Return the parsed endpoints.json. Cached."""
    return json.loads(_ENDPOINTS_FILE.read_text())


@lru_cache(maxsize=1)
def load_summary_md() -> str:
    """
    Return the compressed Markdown summary used for prompt injection.
    Generated lazily from endpoints.json so the file on disk only needs
    to be edited in one place. Re-renders if `summary.md` is missing.
    """
    if _SUMMARY_FILE.exists():
        return _SUMMARY_FILE.read_text()
    summary = _render_summary(load_catalog())
    _SUMMARY_FILE.write_text(summary)
    return summary


def endpoint(endpoint_id: str) -> Dict[str, Any]:
    """Look up a single endpoint by id (e.g. 'product.get')."""
    for e in load_catalog()["endpoints"]:
        if e["id"] == endpoint_id:
            return e
    raise KeyError(f"unknown Ajax endpoint id {endpoint_id!r}")


# ── Summary renderer ─────────────────────────────────────────────────────────


def _format_field(f: Dict[str, Any]) -> str:
    label = f.get("type", "any")
    desc = f.get("description")
    line = f"{f['name']} ({label})"
    if desc:
        line += f" — {desc}"
    return line


def _render_endpoint(e: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    out.append(f"- **{e['method']} {e['path']}** — {e['purpose']}")
    if e.get("path_params"):
        out.append(f"  path: {', '.join(p['name'] for p in e['path_params'])}")
    if e.get("query_params"):
        out.append(
            "  query: "
            + ", ".join(
                f"{q['name']}{'*' if q.get('required') else ''}"
                for q in e["query_params"]
            )
        )
    if e.get("body_params"):
        out.append(
            "  body: "
            + ", ".join(
                f"{b['name']}{'*' if b.get('required') else ''}"
                for b in e["body_params"]
            )
        )
    field_summary = ", ".join(f["name"] for f in e.get("response_top_fields", []))
    if field_summary:
        out.append(f"  response: {{ {field_summary} }}")
    for nest_name, nest_fields in (e.get("nested_shapes") or {}).items():
        names = ", ".join(f["name"] for f in nest_fields)
        out.append(f"  {nest_name}: {{ {names} }}")
    return out


def _render_summary(catalog: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("## Shopify Ajax API endpoints (host.storefront paths)")
    lines.append("")
    lines.append(
        "Each entry shows the relative path you pass to "
        "`host.storefront(path)`, the method, what triggers it, and the "
        "fields the response actually carries. The widget's ONLY public "
        "Shopify channel is these endpoints — paths NOT listed here are "
        "not supported by `host.storefront`."
    )
    lines.append("")
    by_cat: Dict[str, List[Dict[str, Any]]] = {}
    for e in catalog["endpoints"]:
        by_cat.setdefault(e["category"], []).append(e)
    for cat in sorted(by_cat):
        lines.append(f"### {cat}")
        lines.append("")
        for e in by_cat[cat]:
            lines.extend(_render_endpoint(e))
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"
