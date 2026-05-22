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

import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List


TEMPLATE_REL = "platform-back/templates/handler"
TSC_TIMEOUT_SECONDS = 90

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
