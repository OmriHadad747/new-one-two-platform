"""
Real tsc runner for the coding agent.

Strategy:

  1. Stage `<work_dir>/_tsc/` as a fresh build dir for this run.
  2. Symlink the template's `tsconfig.json`, `package.json`, and
     `node_modules` into the build dir — avoids a multi-MB copy.
  3. Copy the template's `src/` into the build dir.
  4. Overlay `scaffold/src/*` and `scaffold/src/types/contracts.ts` on top
     of the template's src — same-path scaffold files win.
  5. Run `npx tsc --noEmit -p tsconfig.json` in the build dir.
  6. Parse compiler output into structured errors.

The build dir is cleaned and rebuilt on every call so we never see stale
artifacts. Symlinks make rebuild cheap (~100ms for the file ops).

`scaffold/{admin,widget}/*.ts` are NOT included — those are compiled
separately by the platform's admin/widget build paths and have their
own type-checking configuration.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List


TEMPLATE_REL = "platform-back/templates/handler"
TSC_TIMEOUT_SECONDS = 90

# ── UI (admin panel + storefront widget) type-check ──────────────────────────
#
# The backend pass above (run_tsc_on_scaffold) deliberately excludes
# scaffold/{admin,widget}/*.ts — they run in the browser, not Node, so they
# can't be checked against the backend's tsconfig. They were therefore never
# type-checked at all, which is where whole-feature bugs hide. This second
# pass checks them against a DOM tsconfig with the SDK contracts resolvable.
#
# SDK contracts (resolved via tsconfig `paths`, single source of truth):
#   @platform/admin-sdk      → platform-shopify-admin/src/types.ts  (AdminBridge…)
#   @platform/storefront-sdk → platform-ai/context/ui_types/storefront.ts (Host…)
ADMIN_SDK_REL = "platform-shopify-admin/src/types.ts"
STOREFRONT_SDK_REL = "platform-ai/context/ui_types/storefront.ts"

# (scaffold-relative UI file, build-relative dest, SDK type the param must use)
_UI_SURFACES = [
    ("admin/ui.ts", "admin/ui.ts", "AdminBridge"),
    ("widget/widget.ts", "widget/widget.ts", "Host"),
]

_MOUNT_SIG_RE = re.compile(
    r"export\s+function\s+mount\s*\(\s*[^,)]+,\s*(?P<param>[A-Za-z_$][\w$]*)\s*:\s*(?P<type>[^,)]+)\)"
)

# Matches tsc's default error output:
#   src/routes/widget.ts(42,5): error TS2304: Cannot find name 'Foo'.
# and the alternative pretty form:
#   src/routes/widget.ts:42:5 - error TS2304: Cannot find name 'Foo'.
_ERROR_PATTERNS = [
    re.compile(r"^(?P<file>.+?)\((?P<line>\d+),(?P<col>\d+)\): error TS\d+: (?P<msg>.+)$"),
    re.compile(r"^(?P<file>.+?):(?P<line>\d+):(?P<col>\d+) - error TS\d+: (?P<msg>.+)$"),
]


def run_tsc_on_scaffold(repo_root: Path, work_dir: Path) -> List[Dict[str, Any]]:
    """Build + type-check the assembled scaffold. Returns a list of
    `{file, line, col, message}` errors. Empty list = clean."""
    template = repo_root / TEMPLATE_REL
    if not (template / "tsconfig.json").exists():
        # Should never happen on a healthy checkout, but surface as a
        # tsc error so the agent loop can see it.
        return [
            {
                "file": str(template / "tsconfig.json"),
                "line": 0,
                "col": 0,
                "message": "template tsconfig.json not found — repo layout problem",
            }
        ]

    build = work_dir / "_tsc"
    _rebuild_build_dir(template, work_dir, build)

    proc = subprocess.run(
        ["npx", "--no-install", "tsc", "--noEmit", "-p", "tsconfig.json"],
        cwd=build,
        capture_output=True,
        text=True,
        timeout=TSC_TIMEOUT_SECONDS,
    )

    return _parse_tsc_output(proc.stdout, proc.stderr)


# ── Internals ───────────────────────────────────────────────────────────────


def _rebuild_build_dir(template: Path, work_dir: Path, build: Path) -> None:
    """Wipe build/, then stage template + scaffold-overlay."""
    if build.exists():
        # Remove symlinks AND copied tree
        for child in build.iterdir():
            if child.is_symlink() or child.is_file():
                child.unlink()
            else:
                shutil.rmtree(child)
    else:
        build.mkdir(parents=True)

    # Symlink shared, large, immutable entries.
    for entry in ("tsconfig.json", "package.json", "node_modules"):
        src = template / entry
        if src.exists():
            (build / entry).symlink_to(src)

    # Copy template's src/ wholesale; this is small (~2.8k LOC across 18 files).
    shutil.copytree(template / "src", build / "src")

    # Overlay scaffold/src/* on top — same-path scaffold files win.
    scaffold_src = work_dir / "scaffold" / "src"
    if scaffold_src.exists():
        for path in scaffold_src.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(scaffold_src)
            dst = build / "src" / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dst)


def _parse_tsc_output(stdout: str, stderr: str) -> List[Dict[str, Any]]:
    """Walk every line of stdout+stderr, extract structured error rows."""
    errors: List[Dict[str, Any]] = []
    for line in (stdout + "\n" + stderr).splitlines():
        for pat in _ERROR_PATTERNS:
            m = pat.match(line)
            if m:
                errors.append(
                    {
                        "file": m.group("file"),
                        "line": int(m.group("line")),
                        "col": int(m.group("col")),
                        "message": m.group("msg"),
                    }
                )
                break
    return errors


# ── UI type-check pass ───────────────────────────────────────────────────────


def run_tsc_on_ui_scaffold(repo_root: Path, work_dir: Path) -> List[Dict[str, Any]]:
    """Type-check scaffold/admin/ui.ts + scaffold/widget/widget.ts against a
    DOM tsconfig with the SDK contracts resolvable. Returns the same
    `{file, line, col, message}` rows as the backend pass. No-op (empty list)
    when neither UI file exists (backend-only apps).

    Two layers run:
      1. A deterministic SDK-typing pre-check (the mount param must be typed
         with the real SDK type, never `any` or untyped) — without it the
         body type-check is vacuous, since `bridge: any` silences everything.
      2. `tsc --noEmit` over the present UI files.
    """
    scaffold = work_dir / "scaffold"
    present = [
        (src_rel, dst_rel, sdk_type)
        for (src_rel, dst_rel, sdk_type) in _UI_SURFACES
        if (scaffold / src_rel).is_file()
    ]
    if not present:
        return []

    errors: List[Dict[str, Any]] = []

    # Layer 1 — deterministic SDK-typing pre-check.
    for src_rel, _dst_rel, sdk_type in present:
        errors.extend(_check_ui_sdk_typing(scaffold / src_rel, src_rel, sdk_type))

    # Layer 2 — tsc against a DOM config with the SDK contracts path-mapped.
    template = repo_root / TEMPLATE_REL
    node_modules = template / "node_modules"
    if not node_modules.exists():
        # Can't run tsc without the compiler; the pre-check still ran.
        return errors

    build = work_dir / "_tsc_ui"
    _build_ui_dir(repo_root, scaffold, build, present)

    try:
        proc = subprocess.run(
            ["npx", "--no-install", "tsc", "--noEmit", "-p", "tsconfig.json"],
            cwd=build,
            capture_output=True,
            text=True,
            timeout=TSC_TIMEOUT_SECONDS,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        errors.append(
            {
                "file": "ui",
                "line": 0,
                "col": 0,
                "message": f"UI tsc could not run: {e!r}",
            }
        )
        return errors

    errors.extend(_parse_tsc_output(proc.stdout, proc.stderr))
    return errors


def _check_ui_sdk_typing(
    path: Path, rel: str, sdk_type: str
) -> List[Dict[str, Any]]:
    """The mount() SDK param must be annotated with `sdk_type`, not `any` or
    left untyped — otherwise the tsc pass checks nothing in the body."""
    text = path.read_text()
    m = _MOUNT_SIG_RE.search(text)
    if not m:
        return [
            {
                "file": rel,
                "line": 1,
                "col": 1,
                "message": (
                    "could not find `export function mount(container, "
                    f"{sdk_type.lower()})` — the module must export exactly that."
                ),
            }
        ]
    line = text[: m.start()].count("\n") + 1
    annotated = m.group("type").strip()
    if annotated != sdk_type:
        return [
            {
                "file": rel,
                "line": line,
                "col": 1,
                "message": (
                    f"mount's SDK parameter is typed `{annotated}` — it MUST be "
                    f"`{sdk_type}` (import type from the SDK), never `any` or "
                    "untyped, or the type-check is vacuous."
                ),
            }
        ]
    return []


def _build_ui_dir(
    repo_root: Path,
    scaffold: Path,
    build: Path,
    present: List[tuple[str, str, str]],
) -> None:
    """Stage a fresh _tsc_ui/ build dir: node_modules symlink, copied SDK
    contracts under sdk/, copied UI files, and a generated DOM tsconfig."""
    if build.exists():
        shutil.rmtree(build)
    build.mkdir(parents=True)

    template = repo_root / TEMPLATE_REL
    (build / "node_modules").symlink_to(template / "node_modules")

    # SDK contracts → build/sdk/* (copied so the build dir is self-contained;
    # the source files remain the single source of truth).
    sdk_dir = build / "sdk"
    sdk_dir.mkdir()
    shutil.copy2(repo_root / ADMIN_SDK_REL, sdk_dir / "admin.ts")
    shutil.copy2(repo_root / STOREFRONT_SDK_REL, sdk_dir / "storefront.ts")

    include: List[str] = []
    for src_rel, dst_rel, _sdk_type in present:
        dst = build / dst_rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(scaffold / src_rel, dst)
        include.append(dst_rel)

    # contracts.ts is shared between backend and UI: the UI files import their
    # request/response/row types from `../src/types/contracts.js`. Stage it so
    # that import resolves here — without it the UI files fail with "cannot
    # find module" and the agent is pushed to inline-duplicate the types.
    contracts = scaffold / "src" / "types" / "contracts.ts"
    if contracts.is_file():
        dst = build / "src" / "types" / "contracts.ts"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(contracts, dst)

    tsconfig = {
        "compilerOptions": {
            "target": "ES2022",
            "module": "ESNext",
            "moduleResolution": "bundler",
            "lib": ["ES2022", "DOM", "DOM.Iterable"],
            "types": [],
            "strict": True,
            "exactOptionalPropertyTypes": True,
            "noUncheckedIndexedAccess": True,
            "skipLibCheck": True,
            "noEmit": True,
            "baseUrl": ".",
            "paths": {
                "@platform/admin-sdk": ["./sdk/admin"],
                "@platform/storefront-sdk": ["./sdk/storefront"],
            },
        },
        "include": include,
    }
    (build / "tsconfig.json").write_text(json.dumps(tsconfig, indent=2))
