"""
TypeScript compilation gate for generated handler bundles.

Why
---
After the regex/contract validators pass, the handler bundle still might
fail to compile — wrong import shape, typo'd req.platform.shopDomain,
mismatched generic on a sql<T> tagged template, missing await, etc. tsc
catches every one of those mechanically and produces actionable error
messages the backend agent can fix on retry.

How
---
1. Parse the bundle (===FILE: ... === markers) into individual files.
2. Make a tempdir that mirrors a real handler container:
   - Copy the template baseline (platform-back/templates/handler) without
     node_modules / dist / .env / .git.
   - Symlink the template's node_modules into the tempdir (fast — no copy,
     no `npm install` per validation).
   - Drop the bundle files at their declared paths, overwriting any
     template placeholders of the same path.
3. Run `tsc --noEmit -p tsconfig.json` against the tempdir with a wall-
   clock timeout.
4. Parse `path(line,col): error TSxxxx: message` lines back into validator
   findings, stripping the tempdir prefix.

Graceful skip: if the template root, node_modules, or tsc binary is
missing, log a warning and return `[]`. Sandbox / CI without Node should
not crash the pipeline — the regex + LLM validators still run.

Template-bug filter: errors whose file path matches a template-owned
file (server.ts, lib/db.ts, etc. — see template_tables.TEMPLATE_OWNED_FILES)
are logged loudly but excluded from findings. The backend agent can't fix
template bugs by regenerating handler code, so feeding those errors back
would dead-cycle the retry loop until abort.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Iterable, List, Optional

from subagents.f_codegen_agent.backend_agent.constants import TEMPLATE_OWNED_FILES as _TEMPLATE_OWNED_FILES
from utils.file_bundle import is_file_bundle, parse_file_bundle

log = logging.getLogger(__name__)

# Match `path/to/file.ts(line,col): error TSxxxx: message`. tsc always emits
# this exact shape from `--noEmit -p tsconfig.json` runs.
_TSC_ERROR_RE = re.compile(
    r"^(?P<path>[^()\n]+?)\((?P<line>\d+),(?P<col>\d+)\): "
    r"error (?P<code>TS\d+): (?P<message>.+)$",
    re.MULTILINE,
)

# Default location of the handler template baseline relative to this file.
# platform-ai/subagents/f_codegen_agent/backend_agent/typecheck.py -> platform-back/templates/handler
_DEFAULT_TEMPLATE_ROOT = (
    Path(__file__).resolve().parent.parent.parent.parent.parent
    / "platform-back"
    / "templates"
    / "handler"
)

_DEFAULT_TIMEOUT_SEC = 60


def validate_backend_typecheck(
    handler_bundle: str,
    template_root: Optional[Path] = None,
    timeout_sec: int = _DEFAULT_TIMEOUT_SEC,
) -> List[str]:
    """
    Compile the assembled handler bundle with `tsc --noEmit`.

    Parameters
    ----------
    handler_bundle:
        Raw ===FILE: ... === markered string from BackendGenerator.
    template_root:
        Path to platform-back/templates/handler. Defaults to the location
        relative to this file.
    timeout_sec:
        Wall-clock cap on the tsc run. On timeout, treat as graceful skip
        (return []) and log — the model can't fix "tsc hung".

    Returns
    -------
    List of finding strings, one per tsc diagnostic, in the format
        "[<path>:<line>:<col>] <code>: <message>"
    where <path> is relative to the bundle root (matches the file paths
    the generator emits). Empty list = clean compile or graceful skip.
    """
    template_root = (template_root or _DEFAULT_TEMPLATE_ROOT).resolve()

    if not is_file_bundle(handler_bundle):
        # The bundle parser will already have flagged this; skip silently.
        return []
    try:
        files = parse_file_bundle(handler_bundle)
    except Exception as err:
        log.warning("typecheck: bundle parse failed, skipping (%s)", err)
        return []
    if not files:
        return []

    if not (template_root / "tsconfig.json").exists():
        log.warning(
            "typecheck: template_root %s has no tsconfig.json — skipping gate",
            template_root,
        )
        return []
    if not (template_root / "node_modules").exists():
        log.warning(
            "typecheck: template_root %s has no node_modules (run `npm install` "
            "in the handler template once) — skipping gate",
            template_root,
        )
        return []

    tsc_cmd = _resolve_tsc_command(template_root)
    if tsc_cmd is None:
        log.warning(
            "typecheck: neither template node_modules/.bin/tsc nor `npx tsc` "
            "is available — skipping gate"
        )
        return []

    with tempfile.TemporaryDirectory(prefix="handler-tsc-") as tmp_str:
        tmp = Path(tmp_str)
        try:
            _stage_template(template_root, tmp)
            _stage_bundle(files, tmp)
        except Exception as err:
            log.warning("typecheck: staging failed, skipping gate (%s)", err)
            return []

        try:
            proc = subprocess.run(
                tsc_cmd,
                cwd=tmp,
                capture_output=True,
                text=True,
                timeout=timeout_sec,
                check=False,
            )
        except subprocess.TimeoutExpired:
            log.warning(
                "typecheck: tsc timed out after %ds — skipping gate", timeout_sec
            )
            return []
        except FileNotFoundError as err:
            log.warning("typecheck: tsc binary disappeared (%s) — skipping gate", err)
            return []

        if proc.returncode == 0:
            return []

        return _parse_findings(proc.stdout + "\n" + proc.stderr, tmp)


# ── Internals ──────────────────────────────────────────────────────────────────


def _resolve_tsc_command(template_root: Path) -> Optional[List[str]]:
    """Prefer the template's pinned tsc; fall back to `npx tsc`."""
    local = template_root / "node_modules" / ".bin" / "tsc"
    if local.exists():
        return [str(local), "--noEmit", "-p", "tsconfig.json"]
    npx = shutil.which("npx")
    if npx is not None:
        return [npx, "--no-install", "tsc", "--noEmit", "-p", "tsconfig.json"]
    return None


_TEMPLATE_EXCLUDE_DIRS = {"node_modules", "dist", ".git"}
_TEMPLATE_EXCLUDE_FILES = {".env", ".env.local"}


def _stage_template(template_root: Path, dest: Path) -> None:
    """
    Copy the template into `dest`, then symlink node_modules so tsc resolves
    every dependency without paying a `cp -r node_modules` cost per call.
    """
    def _ignore(_dir: str, names: Iterable[str]) -> List[str]:
        return [n for n in names if n in _TEMPLATE_EXCLUDE_DIRS or n in _TEMPLATE_EXCLUDE_FILES]

    shutil.copytree(template_root, dest, ignore=_ignore, dirs_exist_ok=True)
    os.symlink(template_root / "node_modules", dest / "node_modules")


def _stage_bundle(files: List[dict], dest: Path) -> None:
    """Write each generated file into `dest`, creating parent dirs as needed."""
    for entry in files:
        rel = entry["path"]
        # Defensive — parse_file_bundle already rejects ../ and absolute paths,
        # but resolve once more before touching the filesystem.
        target = (dest / rel).resolve()
        if not str(target).startswith(str(dest.resolve())):
            raise ValueError(f"bundle path escapes tempdir: {rel}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(entry["contents"], encoding="utf-8")


def _parse_findings(output: str, tmp: Path) -> List[str]:
    """Convert raw tsc output into validator finding strings."""
    findings: List[str] = []
    template_bug_count = 0
    tmp_str = str(tmp.resolve())

    for match in _TSC_ERROR_RE.finditer(output):
        raw_path = match.group("path").strip()
        # Normalise to a path relative to the bundle root so the model sees
        # the same paths it emitted, not the tempdir.
        try:
            abs_path = Path(raw_path)
            if not abs_path.is_absolute():
                abs_path = (tmp / raw_path).resolve()
            rel = abs_path.relative_to(tmp.resolve())
        except (ValueError, OSError):
            rel = Path(raw_path)
        rel_str = rel.as_posix()

        if rel_str in _TEMPLATE_OWNED_FILES:
            # Template bug — not actionable by the backend agent. Log loudly
            # so the platform team notices, but keep it out of the retry loop.
            template_bug_count += 1
            log.error(
                "typecheck: TEMPLATE BUG at %s:%s:%s %s — %s",
                rel_str,
                match.group("line"),
                match.group("col"),
                match.group("code"),
                match.group("message"),
            )
            continue

        findings.append(
            f"[{rel_str}:{match.group('line')}:{match.group('col')}] "
            f"{match.group('code')}: {match.group('message')}"
        )

    if template_bug_count > 0:
        log.error(
            "typecheck: %d template-owned errors filtered out of retry feedback "
            "— investigate the template before next deploy",
            template_bug_count,
        )

    # Belt-and-suspenders: if tsc returned non-zero but we extracted nothing
    # parseable (e.g. tsc itself crashed), surface a single generic finding so
    # the operator sees that the gate ran and produced something, rather than
    # silently passing on a non-zero exit.
    if not findings and not template_bug_count:
        snippet = (output[:400] + "…") if len(output) > 400 else output
        findings.append(
            f"[handler_tsc] tsc exited non-zero with no parseable diagnostics; "
            f"raw output: {snippet}"
        )

    return findings
