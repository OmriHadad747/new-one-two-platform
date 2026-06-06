"""Apply targeted field edits to an HLD plan dict (revise mode).

The revise pass addresses reviewer findings by EDITING the prior plan instead of
re-emitting it. Edits are addressed semantically — capabilities by their unique
`id`, tables by their unique `name` — so they are stable against reordering and
mirror how findings name locations (e.g. "capabilities[process-restock-queue],
kind").

One operation only: SET a field (or a whole element) to a full new value. To add
a list item (e.g. a shopifyStep) the caller supplies the full new list as the
value; to rewrite a whole capability it targets `capabilities[<id>]`. The loop
re-validates the result against `HLDPlan`, so `apply_edits` only resolves paths
and sets values — it never has to understand the schema. A bad field name or a
schema-illegal value is caught by that downstream validation (the model gets the
errors back), not here.
"""

from __future__ import annotations

import re
from copy import deepcopy
from typing import Any, Dict, List

# "capabilities[<id>]" / "persistence[<name>]" — collection[key] addressing.
_INDEXED = re.compile(r"^(?P<coll>[A-Za-z_][A-Za-z0-9_]*)\[(?P<key>.+)\]$")

# Which field uniquely identifies an element in each indexed collection.
_KEY_FIELD: Dict[str, str] = {
    "capabilities": "id",
    "persistence": "name",
}


class PatchError(ValueError):
    """A path could not be resolved or an edit was malformed."""


def apply_edits(plan: Dict[str, Any], edits: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Return a NEW plan dict with every edit applied. Never mutates `plan`.

    Each edit is ``{"path": str, "value": <any>}``. Path forms:
      - ``"<field>"``               a top-level key (dataFlow, complexity, edgeCases, …)
      - ``"<coll>[<key>]"``         a whole capabilities/persistence element
      - ``"<coll>[<key>].<field>"`` one field on that element

    Raises ``PatchError`` on a malformed edit or an unresolvable path. Schema
    correctness is NOT checked here — the caller re-validates the result.
    """
    if not isinstance(edits, list) or not edits:
        raise PatchError("edits must be a non-empty list of {path, value} objects")

    out = deepcopy(plan)
    for i, edit in enumerate(edits):
        if not isinstance(edit, dict) or "path" not in edit or "value" not in edit:
            raise PatchError(f"edit[{i}] must be an object with 'path' and 'value'")
        path = str(edit["path"]).strip()
        _set_path(out, path, edit["value"])
    return out


def _set_path(root: Dict[str, Any], path: str, value: Any) -> None:
    if not path:
        raise PatchError("empty path")
    head, _, tail = path.partition(".")
    m = _INDEXED.match(head)
    if m:
        coll, key = m.group("coll"), m.group("key").strip()
        elem = _find_element(root, coll, key)
        if tail:
            elem[tail] = value  # schema (extra="forbid") rejects a bad field name
        else:
            if not isinstance(value, dict):
                raise PatchError(
                    f"{coll}[{key}]: replacing a whole element needs an object value"
                )
            elem.clear()
            elem.update(value)
        return
    # Top-level field.
    if tail:
        raise PatchError(
            f"unsupported nested path {path!r}; address elements as "
            f"capabilities[<id>] / persistence[<name>]"
        )
    root[head] = value


def _find_element(root: Dict[str, Any], coll: str, key: str) -> Dict[str, Any]:
    key_field = _KEY_FIELD.get(coll)
    if key_field is None:
        raise PatchError(
            f"collection {coll!r} is not addressable by key "
            f"(addressable: {sorted(_KEY_FIELD)})"
        )
    items = root.get(coll)
    if not isinstance(items, list):
        raise PatchError(f"{coll!r} is not a list in the plan")
    matches = [it for it in items if isinstance(it, dict) and it.get(key_field) == key]
    if not matches:
        raise PatchError(f"no {coll} element with {key_field}={key!r}")
    if len(matches) > 1:
        raise PatchError(f"{len(matches)} {coll} elements with {key_field}={key!r} (ambiguous)")
    return matches[0]
