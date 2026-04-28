"""
JS/TS source parsing primitives shared across static validators.

Pure structural extraction — no rules, no error messages. Each function
returns parsed data; rule modules layer the policy on top.
"""

from __future__ import annotations

import re
from typing import List, Optional


# Identifiers that look like object keys but are JS keywords / runtime
# globals — never treated as "fields" by the catalog↔code matchers.
NON_FIELD = {
    "true",
    "false",
    "null",
    "undefined",
    "host",
    "bridge",
    "context",
    "await",
    "const",
    "let",
    "var",
    "return",
    "if",
    "else",
    "new",
    "this",
    "async",
    "function",
    "result",
    "data",
    "response",
    "error",
}


def strip_comments_and_strings(js: str) -> str:
    """
    Return `js` with line comments, block comments, and string literals
    replaced by single spaces (preserving offsets so downstream regex line-
    number math still works).

    Use this before applying token-level forbidden-pattern denylists so a
    rule like `// don't use document.body` or `'eval() is forbidden'` does
    not false-positive against a comment or error-message string. Same
    pattern as `_check_no_tenant_id_in_sql` in `handler_artifact.py`.

    Recognised:
      - `// line comments`
      - `/* block comments, possibly multi-line */`
      - `'single-quoted'`, `"double-quoted"`, `` `template-literal` ``
        (template-literal interpolation `${…}` is NOT scrubbed — the
        substituted expression is still real code worth scanning)

    Backslash escapes inside string literals are honored. Regex literals
    (`/foo/g`) are NOT specifically detected — division operators look
    identical at the token level. Acceptable because the denylists this
    feeds don't trigger on regex bodies anyway (no `document.body` etc.
    inside a regex literal in real widget code).
    """
    out: list[str] = []
    i = 0
    n = len(js)
    while i < n:
        c = js[i]
        # Line comment: // ... \n
        if c == "/" and i + 1 < n and js[i + 1] == "/":
            j = js.find("\n", i + 2)
            j = n if j == -1 else j
            out.append(" " * (j - i))
            i = j
            continue
        # Block comment: /* ... */
        if c == "/" and i + 1 < n and js[i + 1] == "*":
            j = js.find("*/", i + 2)
            j = n if j == -1 else j + 2
            block = js[i:j]
            # Preserve newlines so line numbers stay aligned.
            out.append("".join("\n" if ch == "\n" else " " for ch in block))
            i = j
            continue
        # String / template literal — same scan logic for all three quotes.
        if c in ("'", '"', "`"):
            quote = c
            j = i + 1
            while j < n:
                cj = js[j]
                if cj == "\\":
                    j += 2
                    continue
                # Template-literal interpolation: keep ${…} contents real.
                if quote == "`" and cj == "$" and j + 1 < n and js[j + 1] == "{":
                    # Emit blank for the literal slice so far, then the raw
                    # interpolation, then continue scanning the literal.
                    out.append(" " * (j - i))
                    depth = 1
                    k = j + 2
                    while k < n and depth > 0:
                        ck = js[k]
                        if ck == "{":
                            depth += 1
                        elif ck == "}":
                            depth -= 1
                        k += 1
                    out.append(js[j:k])
                    i = k
                    j = i
                    if i >= n:
                        break
                    continue
                if cj == quote:
                    j += 1
                    break
                j += 1
            block = js[i:j]
            out.append("".join("\n" if ch == "\n" else " " for ch in block))
            i = j
            continue
        # Default: copy through.
        out.append(c)
        i += 1
    return "".join(out)


def extract_js_fields(obj_literal: str) -> List[str]:
    """
    Extract property key names from a JS object literal fragment.

    Handles shorthand  { email, variantId }
    and explicit       { email: formData.email, variantId: someVar }

    Returns sorted list of key identifiers only (not values).
    Uses a split-based approach so the last field is always captured even when
    the closing `}` is not present in the captured substring.
    """
    keys: List[str] = []
    seen: set = set()
    s = obj_literal.strip().strip("{}").strip()
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        key = part.split(":")[0].strip()
        if (
            re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", key)
            and key not in NON_FIELD
            and key not in seen
        ):
            keys.append(key)
            seen.add(key)
    return sorted(keys)


def extract_call_keys(body_str: str) -> set:
    """
    Extract top-level property key names from a JavaScript object literal
    fragment, returned as a set. Convenience wrapper around `extract_js_fields`
    for callers that need set semantics rather than a sorted list.
    """
    return set(extract_js_fields(body_str))


def top_level_keys_of(code: str, start_idx: int) -> set:
    """
    Scan the object literal starting at the `{` at start_idx and return the set
    of property names declared at its top level (depth 0 of braces/brackets/parens).

    Handles strings and backticks so `{ key: "ignore: me" }` doesn't confuse us.
    Returns the empty set on malformed input rather than raising — this is a
    soft-check helper.
    """
    i = start_idx
    n = len(code)
    if i >= n or code[i] != "{":
        return set()
    depth = 0
    keys: set = set()
    in_string: Optional[str] = None
    at_key_position = True
    key_start = -1
    while i < n:
        c = code[i]
        if in_string:
            if c == "\\":
                i += 2
                continue
            if c == in_string:
                in_string = None
            i += 1
            continue
        if c in ('"', "'", "`"):
            in_string = c
            at_key_position = False
            i += 1
            continue
        if c == "{" or c == "[" or c == "(":
            depth += 1
            at_key_position = False
            i += 1
            continue
        if c == "}" or c == "]" or c == ")":
            depth -= 1
            if depth == 0 and c == "}":
                # End of our top-level object.
                # A trailing shorthand key right before the close also counts.
                if key_start >= 0 and at_key_position and depth == 0:
                    keys.add(code[key_start:i].strip())
                return keys
            i += 1
            continue
        if depth == 1:
            # Top-level of the object we're interested in.
            if c == "," and at_key_position and key_start >= 0:
                keys.add(code[key_start:i].strip())
                key_start = -1
            elif c == ":" and at_key_position and key_start >= 0:
                keys.add(code[key_start:i].strip())
                key_start = -1
                at_key_position = False
            elif c == ",":
                at_key_position = True
            elif at_key_position and (c.isalnum() or c == "_" or c == "$"):
                if key_start == -1:
                    key_start = i
        i += 1
    return keys


def split_top_level(s: str) -> List[str]:
    """Split a comma list, respecting paren depth and string boundaries."""
    out: List[str] = []
    buf: List[str] = []
    depth = 0
    in_str = False
    str_ch = ""
    for ch in s:
        if in_str:
            buf.append(ch)
            if ch == str_ch:
                in_str = False
            continue
        if ch in ("'", '"', "`"):
            in_str = True
            str_ch = ch
            buf.append(ch)
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


def string_literal_value(expr: str) -> Optional[str]:
    """Return the inner content of a single-quoted SQL literal, or None."""
    expr = expr.strip()
    m = re.fullmatch(r"'([^']*)'", expr)
    return m.group(1) if m else None


def scan_balanced_paren(code: str, start: int) -> Optional[str]:
    """
    Given `code` positioned just AFTER an opening '(', return the substring
    up to (but not including) the matching close-paren, respecting nesting
    and SQL string literals. Returns None if no balanced close exists.
    """
    depth = 1
    i = start
    in_str = False
    str_ch = ""
    while i < len(code):
        ch = code[i]
        if in_str:
            if ch == str_ch:
                in_str = False
        elif ch in ("'", '"'):
            in_str = True
            str_ch = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return code[start:i]
        i += 1
    return None


def extract_settimeout_delays(js: str) -> List[Optional[str]]:
    """
    For each setTimeout( call in js, return the delay (second top-level argument)
    as a stripped string, or None when no second argument is present.

    Uses a character scanner instead of a regex so that callbacks containing
    commas (arrow functions, multi-param functions, block bodies) are handled
    correctly.  Example: setTimeout(() => search(q, page), 300) → "300".
    """
    delays: List[Optional[str]] = []
    for m in re.finditer(r"\bsetTimeout\s*\(", js):
        i = m.end()  # index just past the opening '('
        n = len(js)
        depth = 1  # we're inside the outer '('
        in_string: Optional[str] = None
        first_top_comma: Optional[int] = None

        while i < n and depth > 0:
            c = js[i]
            if in_string:
                if c == "\\":
                    i += 2
                    continue
                if c == in_string:
                    in_string = None
            elif c in ('"', "'", "`"):
                in_string = c
            elif c in ("(", "[", "{"):
                depth += 1
            elif c in (")", "]", "}"):
                depth -= 1
            elif c == "," and depth == 1 and first_top_comma is None:
                # Only the FIRST top-level comma separates callback from delay.
                first_top_comma = i
            i += 1

        if first_top_comma is None:
            delays.append(None)  # no second argument
            continue

        # i now points one past the closing ')'; js[i-1] == ')'
        delay_str = js[first_top_comma + 1 : i - 1].strip()
        delays.append(delay_str)

    return delays


def js_is_syntactically_complete(code: str) -> bool:
    """
    Heuristic completeness check — catches truncated output before Node.js sees it.
    Tracks brace/bracket/paren depth and string state; returns False if unbalanced.
    """
    depth = 0
    in_string: str | None = None
    in_line_comment = False
    in_block_comment = False
    i = 0
    while i < len(code):
        c = code[i]
        nxt = code[i + 1] if i + 1 < len(code) else ""

        if in_line_comment:
            if c == "\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if c == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_string:
            if c == "\\":
                i += 2
                continue
            if c == in_string:
                in_string = None
            i += 1
            continue

        if c == "/" and nxt == "/":
            in_line_comment = True
            i += 2
            continue
        if c == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue
        if c in ('"', "'", "`"):
            in_string = c
            i += 1
            continue

        if c in ("{", "(", "["):
            depth += 1
        elif c in ("}", ")", "]"):
            depth -= 1
            if depth < 0:
                return False
        i += 1

    return depth == 0 and in_string is None and not in_block_comment


def pkg_base(specifier: str) -> str:
    """
    Reduce an import specifier to its base package name:
      "qrcode"          → "qrcode"
      "csv-parse/sync"  → "csv-parse"
      "@shopify/shopify-api" → "@shopify/shopify-api"
      "@xmldom/xmldom/lib/foo" → "@xmldom/xmldom"
    """
    if specifier.startswith("@"):
        parts = specifier.split("/")
        if len(parts) >= 2:
            return "/".join(parts[:2])
        return specifier
    return specifier.split("/")[0]
