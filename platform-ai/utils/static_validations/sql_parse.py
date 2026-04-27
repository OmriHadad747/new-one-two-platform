"""SQL source parsing primitives shared across static validators."""

from __future__ import annotations


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
