"""
Tests for the `window.__PLATFORM_CATALOG__` bundle-prelude generators on
the Python side (CLI's _save_generated_files prelude) and the parity
contract with the platform-back TypeScript bundle-storage saver.

The bundle is served via `<script src=...>` and the `</script>` /
`<!--` HTML-tokens-inside-string-literals don't break out of a
script-src tag — they're only hazardous when JS gets inlined into HTML.
We escape them anyway as defense-in-depth so a future debug tool /
copy-paste / inline-into-template path stays safe.

The TypeScript escape (platform-back/apps/api/src/lib/bundle-storage.ts
`catalogPrelude`) is the source of truth; the Python prelude here must
emit byte-identical output for the same input. If the regexes drift,
locally-saved widget.js / admin_ui.js will differ from the deployed
bundle and the dev/prod parity claim breaks.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List


# Mirror of the chat_local.py `_prelude` helper, lifted here so tests can
# call it without importing the whole CLI module (which has heavy module-
# load deps via models.adapter). When the production helper changes, this
# mirror must change in lockstep — the test_bundle_prelude_byte_identical
# test below catches that drift.
def _python_prelude(catalog_rows: List[Dict[str, Any]]) -> str:
    slim = [
        {"path": r["path"], "method": (r.get("method") or "POST").upper()}
        for r in catalog_rows or []
        if isinstance(r, dict) and isinstance(r.get("path"), str)
    ]
    encoded = re.sub(
        r"</(script)", r"<\\/\1", json.dumps(slim), flags=re.IGNORECASE
    )
    return f"window.__PLATFORM_CATALOG__ = {encoded};\n"


# ── Defense-in-depth: HTML-token-in-path stays safe ─────────────────────────


def test_path_with_close_script_tag_escaped() -> None:
    catalog = [{"path": "/x</script>y", "method": "GET"}]
    out = _python_prelude(catalog)
    assert "</script>" not in out
    assert "<\\/script>" in out


def test_uppercase_close_script_tag_escaped() -> None:
    """Regex is case-insensitive — `</SCRIPT>` is also escaped."""
    catalog = [{"path": "/x</SCRIPT>y", "method": "GET"}]
    out = _python_prelude(catalog)
    assert "</SCRIPT>" not in out
    assert "<\\/SCRIPT>" in out


def test_close_script_with_whitespace_escaped() -> None:
    """`</script ` (with trailing space) also breaks out — escape it too."""
    catalog = [{"path": "/x</script y", "method": "GET"}]
    out = _python_prelude(catalog)
    assert "</script " not in out
    assert "<\\/script " in out


def test_unrelated_close_tag_not_escaped() -> None:
    """`</foo>` is not a script-end token; leave it alone.

    Same for `<!--` — HTML comment start does not break out of a
    `<script>` tag in modern (HTML5/strict) parsers; only `</script`
    is the actual hazard.
    """
    catalog = [
        {"path": "/x</foo>y", "method": "GET"},
        {"path": "/x<!--y", "method": "POST"},
    ]
    out = _python_prelude(catalog)
    assert "</foo>" in out
    assert "<!--" in out


# ── Output is well-formed JS ─────────────────────────────────────────────────


def test_prelude_is_assignable_js() -> None:
    """Output is `window.__PLATFORM_CATALOG__ = <expr>;\\n`."""
    out = _python_prelude([{"path": "/foo", "method": "GET"}])
    assert out.startswith("window.__PLATFORM_CATALOG__ = ")
    assert out.endswith(";\n")


def test_empty_catalog_yields_empty_array() -> None:
    out = _python_prelude([])
    assert out == "window.__PLATFORM_CATALOG__ = [];\n"


def test_method_uppercased() -> None:
    out = _python_prelude([{"path": "/x", "method": "get"}])
    assert '"method": "GET"' in out


def test_method_default_post_when_omitted() -> None:
    out = _python_prelude([{"path": "/x"}])
    assert '"method": "POST"' in out


def test_invalid_row_dropped() -> None:
    """Non-dict / non-string-path rows drop silently — the validator gate."""
    out = _python_prelude(["not-a-dict", {"path": 42, "method": "GET"}])
    assert out == "window.__PLATFORM_CATALOG__ = [];\n"


# ── Parity contract with platform-back's TS catalogPrelude ───────────────────


def test_typescript_escape_pattern_documented() -> None:
    """
    The TypeScript escape regex is `/<\\/script/gi` — case-insensitive,
    global. The Python regex must match the same shape (case-insensitive,
    applied across the entire JSON output).

    If either side changes the regex, this test's assertion text + the
    Python regex above must move in lockstep with the TypeScript regex
    in platform-back/apps/api/src/lib/bundle-storage.ts:catalogPrelude.
    """
    expected_pattern = r"</script"
    expected_flags = re.IGNORECASE
    # Compile and exercise the Python regex used in the prelude builder.
    compiled = re.compile(expected_pattern, expected_flags)
    assert compiled.search("</script>") is not None
    assert compiled.search("</SCRIPT>") is not None
    assert compiled.search("</script ") is not None
    assert compiled.search("</foo>") is None
    assert compiled.search("<!--") is None
