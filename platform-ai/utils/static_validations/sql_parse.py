"""SQL source parsing primitives shared across static validators."""

from __future__ import annotations


def strip_comments_and_strings(sql: str) -> str:
    """
    Return `sql` with line comments, block comments, and string literals
    replaced by single spaces (newlines preserved so line numbers stay
    aligned).

    Use this before applying token-level checks that should NOT match
    inside a column comment or DEFAULT string literal — e.g. a `tenant_id`
    column scan, template-owned-table extraction, or ALTER TABLE shape
    check. The forbidden-keyword denylist (DROP / TRUNCATE / GRANT / etc.)
    is INTENTIONALLY run against raw SQL because it mirrors the platform-
    back deployer's `sql-validator.ts` — the prompt warns the model that
    forbidden words anywhere in the output (comments, strings, anywhere)
    cause rejection. Scrub only the local-only checks.

    Recognised:
      - `-- line comments` until newline
      - `/* block comments */`, possibly multi-line
      - `'single-quoted strings'` with `''` (doubled-quote) escape
      - `E'...'` PostgreSQL escape strings (backslash escapes honored)
      - `$$ … $$` and `$tag$ … $tag$` dollar-quoted strings

    Double-quoted identifiers (`"my column"`) are NOT strings — they are
    quoted identifiers — and are left intact so identifier-token regexes
    still see them.
    """
    out: list[str] = []
    i = 0
    n = len(sql)
    while i < n:
        c = sql[i]
        # Line comment: -- ... \n
        if c == "-" and i + 1 < n and sql[i + 1] == "-":
            j = sql.find("\n", i + 2)
            j = n if j == -1 else j
            out.append(" " * (j - i))
            i = j
            continue
        # Block comment: /* ... */  (PostgreSQL allows nesting)
        if c == "/" and i + 1 < n and sql[i + 1] == "*":
            depth = 1
            j = i + 2
            while j < n and depth > 0:
                if sql[j] == "/" and j + 1 < n and sql[j + 1] == "*":
                    depth += 1
                    j += 2
                    continue
                if sql[j] == "*" and j + 1 < n and sql[j + 1] == "/":
                    depth -= 1
                    j += 2
                    continue
                j += 1
            block = sql[i:j]
            out.append("".join("\n" if ch == "\n" else " " for ch in block))
            i = j
            continue
        # Dollar-quoted string: $tag$ ... $tag$ (tag may be empty)
        if c == "$":
            # Match opening $tag$ where tag is empty or [A-Za-z_][A-Za-z0-9_]*
            j = i + 1
            while j < n and (sql[j].isalnum() or sql[j] == "_"):
                j += 1
            if j < n and sql[j] == "$":
                tag_open = sql[i : j + 1]
                tag_close = tag_open
                end = sql.find(tag_close, j + 1)
                if end == -1:
                    end = n
                else:
                    end += len(tag_close)
                block = sql[i:end]
                out.append("".join("\n" if ch == "\n" else " " for ch in block))
                i = end
                continue
            # Bare `$` not followed by tag — copy through.
            out.append(c)
            i += 1
            continue
        # Escape string: E'...' / e'...' with backslash escapes.
        if (
            c in ("E", "e")
            and i + 1 < n
            and sql[i + 1] == "'"
            and (i == 0 or not sql[i - 1].isalnum())
        ):
            j = i + 2
            while j < n:
                if sql[j] == "\\" and j + 1 < n:
                    j += 2
                    continue
                if sql[j] == "'":
                    j += 1
                    break
                j += 1
            block = sql[i:j]
            out.append("".join("\n" if ch == "\n" else " " for ch in block))
            i = j
            continue
        # Standard single-quoted string with '' (doubled) escape.
        if c == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2  # doubled-quote escape — stays inside the string
                        continue
                    j += 1
                    break
                j += 1
            block = sql[i:j]
            out.append("".join("\n" if ch == "\n" else " " for ch in block))
            i = j
            continue
        # Default: copy through. Double-quoted identifiers are NOT scrubbed.
        out.append(c)
        i += 1
    return "".join(out)


def is_inside_sql_begin(code: str, position: int) -> bool:
    """
    Return True when `position` falls inside a balanced `sql.begin(` call.

    Walks the code from start to position, counting paren depth only after
    the most recent `sql.begin(` token. If depth is still positive at
    position, we're inside the call.
    """
    last_begin = -1
    depth = 0
    i = 0
    while i < position:
        if code.startswith("sql.begin(", i):
            last_begin = i + len("sql.begin(") - 1  # position of the '('
            depth = 1
            i = last_begin + 1
            continue
        if last_begin >= 0:
            ch = code[i]
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    last_begin = -1
        i += 1
    return last_begin >= 0 and depth > 0
