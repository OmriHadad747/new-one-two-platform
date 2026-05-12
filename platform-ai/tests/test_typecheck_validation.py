"""
Tests for the tsc --noEmit post-generation gate.

Two tiers:
  - Unit tests with mocked subprocess.run: cover graceful skip paths,
    template-owned filtering, path stripping, and parse logic. Run in
    every environment, no Node required.
  - One real-tsc smoke test: only runs if the template's node_modules is
    populated. Skipped otherwise (CI without npm install).
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from subagents.e_codegen_agent.backend_agent import typecheck as typecheck_validation
from subagents.e_codegen_agent.backend_agent.typecheck import (
    _DEFAULT_TEMPLATE_ROOT,
    _parse_findings,
    validate_handler_typecheck,
)


# ── Helpers ────────────────────────────────────────────────────────────────────


def _bundle(*files: tuple[str, str]) -> str:
    """Build a generator file-bundle string from (path, contents) tuples."""
    parts = []
    for path, contents in files:
        parts.append(f"===FILE: {path}===\n{contents}\n===END===")
    return "\n".join(parts)


def _fake_proc(
    returncode: int, stdout: str = "", stderr: str = ""
) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(
        args=["tsc"], returncode=returncode, stdout=stdout, stderr=stderr
    )


# ── Graceful skips (no Node required) ─────────────────────────────────────────


def test_returns_empty_for_non_bundle_input() -> None:
    assert validate_handler_typecheck("just plain text, no markers") == []


def test_returns_empty_for_empty_string() -> None:
    assert validate_handler_typecheck("") == []


def test_returns_empty_when_template_root_has_no_tsconfig(tmp_path: Path) -> None:
    bundle = _bundle(("src/routes/admin.ts", "export const x = 1;"))
    # tmp_path is a clean dir with no tsconfig.json — should skip.
    assert validate_handler_typecheck(bundle, template_root=tmp_path) == []


def test_returns_empty_when_template_root_has_no_node_modules(tmp_path: Path) -> None:
    (tmp_path / "tsconfig.json").write_text("{}", encoding="utf-8")
    bundle = _bundle(("src/routes/admin.ts", "export const x = 1;"))
    assert validate_handler_typecheck(bundle, template_root=tmp_path) == []


def test_returns_empty_when_no_tsc_available(tmp_path: Path) -> None:
    (tmp_path / "tsconfig.json").write_text("{}", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    bundle = _bundle(("src/routes/admin.ts", "export const x = 1;"))
    with patch.object(typecheck_validation, "_resolve_tsc_command", return_value=None):
        assert validate_handler_typecheck(bundle, template_root=tmp_path) == []


def test_returns_empty_on_subprocess_timeout(tmp_path: Path) -> None:
    (tmp_path / "tsconfig.json").write_text("{}", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    bundle = _bundle(("src/routes/admin.ts", "export const x = 1;"))
    with patch.object(
        typecheck_validation, "_resolve_tsc_command", return_value=["tsc"]
    ):
        with patch(
            "subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd=["tsc"], timeout=1),
        ):
            assert (
                validate_handler_typecheck(
                    bundle, template_root=tmp_path, timeout_sec=1
                )
                == []
            )


def test_returns_empty_when_tsc_exits_zero(tmp_path: Path) -> None:
    (tmp_path / "tsconfig.json").write_text("{}", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    bundle = _bundle(("src/routes/admin.ts", "export const x = 1;"))
    with patch.object(
        typecheck_validation, "_resolve_tsc_command", return_value=["tsc"]
    ):
        with patch("subprocess.run", return_value=_fake_proc(0)):
            assert validate_handler_typecheck(bundle, template_root=tmp_path) == []


# ── Output parsing ─────────────────────────────────────────────────────────────


def test_parses_single_diagnostic_with_relative_path(tmp_path: Path) -> None:
    output = f"{tmp_path}/src/routes/admin.ts(42,5): error TS2304: Cannot find name 'platfrom'.\n"
    findings = _parse_findings(output, tmp_path)
    assert len(findings) == 1
    assert (
        findings[0] == "[src/routes/admin.ts:42:5] TS2304: Cannot find name 'platfrom'."
    )


def test_parses_multiple_diagnostics(tmp_path: Path) -> None:
    output = (
        f"{tmp_path}/src/routes/admin.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.\n"
        f"{tmp_path}/src/lib/helpers.ts(7,1): error TS2304: Cannot find name 'foo'.\n"
    )
    findings = _parse_findings(output, tmp_path)
    assert len(findings) == 2
    assert any("admin.ts:10:3" in f and "TS2322" in f for f in findings)
    assert any("helpers.ts:7:1" in f and "TS2304" in f for f in findings)


def test_strips_tempdir_prefix_from_paths(tmp_path: Path) -> None:
    output = f"{tmp_path}/src/routes/cron.ts(1,1): error TS1234: oops.\n"
    findings = _parse_findings(output, tmp_path)
    assert len(findings) == 1
    assert findings[0].startswith("[src/routes/cron.ts:")
    assert str(tmp_path) not in findings[0]


def test_template_owned_errors_are_filtered_out(tmp_path: Path, caplog) -> None:
    output = (
        # Template-owned — must not appear in findings
        f"{tmp_path}/src/server.ts(99,1): error TS2304: Cannot find name 'BadThing'.\n"
        f"{tmp_path}/src/lib/db.ts(12,3): error TS2322: type bug.\n"
        # Generator-owned — must appear
        f"{tmp_path}/src/routes/widget.ts(5,5): error TS2304: real generator bug.\n"
    )
    with caplog.at_level("ERROR", logger="subagents.e_codegen_agent.backend_agent.typecheck"):
        findings = _parse_findings(output, tmp_path)

    # Only the generator-owned error survives
    assert len(findings) == 1
    assert "src/routes/widget.ts" in findings[0]
    assert "src/server.ts" not in " ".join(findings)
    assert "src/lib/db.ts" not in " ".join(findings)
    # Both template-owned errors should have been logged loudly
    template_logs = [r.message for r in caplog.records if "TEMPLATE BUG" in r.message]
    assert len(template_logs) == 2


def test_non_zero_exit_with_no_parseable_output_yields_one_generic_finding(
    tmp_path: Path,
) -> None:
    findings = _parse_findings("tsc crashed: ENOMEM\nstack trace gibberish", tmp_path)
    assert len(findings) == 1
    assert "tsc exited non-zero" in findings[0]


# ── Real tsc smoke test ───────────────────────────────────────────────────────
#
# Skipped unless the template's node_modules is present. Catches regressions in
# the staging logic (template copy + node_modules symlink + bundle write) that
# pure mocks would miss.


_TEMPLATE_HAS_DEPS = (
    _DEFAULT_TEMPLATE_ROOT / "node_modules"
).exists() and shutil.which("npx") is not None


@pytest.mark.skipif(
    not _TEMPLATE_HAS_DEPS,
    reason="template node_modules not installed; skipping real-tsc smoke test",
)
def test_real_tsc_catches_unknown_identifier() -> None:
    bundle = _bundle(
        (
            "src/routes/admin.ts",
            (
                "import { Router } from 'express';\n"
                "export const adminRouter = Router();\n"
                "adminRouter.get('/x', (req, res) => {\n"
                "  // 'platfrom' is a typo — tsc must catch it\n"
                "  const shop = req.platfrom?.shopDomain;\n"
                "  res.json({ shop });\n"
                "});\n"
            ),
        ),
    )
    findings = validate_handler_typecheck(bundle)
    # Either: (a) tsc surfaces a TS2339/TS2551 on `platfrom`, or
    # (b) tsc surfaces TS2304/TS18048-class errors on the surrounding express
    # types if the template doesn't expose `req.platform` typing yet.
    # Either way the gate must produce SOMETHING actionable.
    assert findings, "expected tsc to produce at least one finding for the typo"
    assert any("admin.ts" in f for f in findings)
