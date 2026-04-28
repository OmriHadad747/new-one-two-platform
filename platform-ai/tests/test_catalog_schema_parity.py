"""
Pydantic CatalogEntry ↔ Zod CatalogEntrySchema parity test.

The Bundle is published as JSON via Pub/Sub; the Python publisher uses
the Pydantic CatalogEntry model and the TypeScript subscriber parses
with the Zod CatalogEntrySchema. If the two drift, a Bundle that passes
Pydantic gets rejected at Zod parse and silently dead-letters.

Loading Zod from Python is impractical, so we pin Pydantic against the
Zod constraints declared in
`platform-back/apps/api/src/pubsub/schemas.ts`. If anyone tightens or
relaxes one side, this test fails until they update the constants here
to match the new Zod schema.

Failure here is a signal: re-read `schemas.ts:CatalogEntrySchema` and
update the constants below + Pydantic CatalogEntry in lockstep.
"""

from __future__ import annotations

from contract.validators import CatalogEntry


# ── Constants pinned to Zod ──────────────────────────────────────────────────
# Keep in sync with platform-back/apps/api/src/pubsub/schemas.ts
# (`CatalogEntrySchema = z.object({ path: z.string().min(1).max(512), method: z.enum(["GET", "POST"]) })`).
ZOD_PATH_MIN_LEN = 1
ZOD_PATH_MAX_LEN = 512
ZOD_METHOD_VALUES = ("GET", "POST")


def _path_constraints() -> dict:
    """Extract min_length / max_length from the Pydantic CatalogEntry path field."""
    field = CatalogEntry.model_fields["path"]
    out = {}
    for meta in field.metadata or []:
        if hasattr(meta, "min_length"):
            out["min_length"] = meta.min_length
        if hasattr(meta, "max_length"):
            out["max_length"] = meta.max_length
    return out


def test_pydantic_path_min_length_matches_zod() -> None:
    constraints = _path_constraints()
    assert constraints.get("min_length") == ZOD_PATH_MIN_LEN, (
        f"Pydantic min_length={constraints.get('min_length')} but Zod requires "
        f"{ZOD_PATH_MIN_LEN}. If you changed Zod, update Pydantic CatalogEntry "
        "in platform-ai/contract/validators.py to match."
    )


def test_pydantic_path_max_length_matches_zod() -> None:
    constraints = _path_constraints()
    assert constraints.get("max_length") == ZOD_PATH_MAX_LEN, (
        f"Pydantic max_length={constraints.get('max_length')} but Zod requires "
        f"max {ZOD_PATH_MAX_LEN}. If you changed Zod, update Pydantic "
        "CatalogEntry in platform-ai/contract/validators.py to match."
    )


def test_pydantic_method_enum_matches_zod() -> None:
    """Pydantic stores the Literal as the method field's annotation."""
    import typing

    field = CatalogEntry.model_fields["method"]
    annotation = field.annotation
    # typing.Literal["GET", "POST"] → typing.get_args returns ("GET", "POST")
    args = typing.get_args(annotation)
    assert tuple(sorted(args)) == tuple(sorted(ZOD_METHOD_VALUES)), (
        f"Pydantic method Literal={args} but Zod enum is {ZOD_METHOD_VALUES}. "
        "If you changed Zod, update Pydantic CatalogEntry in "
        "platform-ai/contract/validators.py to match."
    )


def test_pydantic_rejects_zod_rejected_inputs() -> None:
    """End-to-end: every input Zod rejects, Pydantic must also reject."""
    from pydantic import ValidationError

    rejections = [
        {"path": "", "method": "GET"},  # min(1)
        {"path": "/" + "x" * (ZOD_PATH_MAX_LEN), "method": "GET"},  # max(512), this is 513 chars
        {"path": "/foo", "method": "DELETE"},  # enum
        {"path": "/foo", "method": "PATCH"},
        {"path": "/foo", "method": ""},
    ]
    for inp in rejections:
        try:
            CatalogEntry(**inp)
            raise AssertionError(
                f"Pydantic accepted Zod-rejected input: {inp!r}. "
                "Schemas have drifted."
            )
        except ValidationError:
            pass


def test_pydantic_accepts_zod_accepted_inputs() -> None:
    """End-to-end: inputs Zod accepts must build a CatalogEntry."""
    accepts = [
        {"path": "/", "method": "GET"},  # min length 1
        {"path": "/foo", "method": "GET"},
        {"path": "/foo", "method": "POST"},
        {"path": "/" + "x" * (ZOD_PATH_MAX_LEN - 1), "method": "GET"},  # exactly max
    ]
    for inp in accepts:
        e = CatalogEntry(**inp)
        assert e.path == inp["path"]
        assert e.method == inp["method"]
