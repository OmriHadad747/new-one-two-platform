"""
Codegen validator agent runner.

Same shape as `e_hld_v_agent.agent` and `k_lld_v_agent.agent`: a single
validator that reads the LLD plan, the pre-codegen alignment notes, and
every emitted artifact, and returns a list of findings. The pipeline
then routes findings back to the originating codegen agent's retry path
(per-artifact) — there is no separate revision agent in this flow.

Sonnet + extended thinking (8192 budget). Fails open: any LLM or parse
error returns an empty findings list and logs a warning rather than
raising, so a validator failure never blocks the pipeline.

Flow
----
1. Build the system prompt via `prompt.build_system_prompt()`.
2. Build a user message with the LLD plan + pre-codegen alignment notes
   + artifacts index + verbatim artifacts.
3. Invoke the LLM, extract JSON, parse with `CodegenVOutput.model_validate_json`.
4. Return `(findings, in_tok, out_tok, cache_read, cache_create)`.

Findings shape (per dict):
  artifact     — "backend" | "db" | "storefront" | "admin_ui" | "plan"
  location     — file:symbol / route / table.column / recipe id
  issue        — one sentence
  failure_mode — one sentence
  confidence   — "high" (medium is dropped silently)
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Tuple

from pydantic import ValidationError

from models.adapter import dump_output, extract_json, get_llm, invoke
from models.agent_models import get_agent_model
from subagents.base import CodegenContext
from subagents.q_codegen_v_agent.prompt import build_system_prompt
from subagents.q_codegen_v_agent.schema import CodegenVOutput

log = logging.getLogger(__name__)


_MAX_OUTPUT_TOKENS = 2_000
_THINKING_BUDGET = 8_192


def _build_user_prompt(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> str:
    """
    Render the per-run user prompt with four sections, in stability order:

      1. LLD PLAN              — the spec the codegen agents built against
      2. ALIGNMENT NOTES       — the pre-codegen cross-agent rules
      3. ARTIFACTS INDEX       — one-line summary of every file
      4. ARTIFACTS             — verbatim file contents + email-metadata sidecar

    The LLD is dumped as compact JSON (no indent) so byte-for-byte
    matches other agents that also dump `lld` with `json.dumps(lld)` —
    Anthropic's prefix cache reuses the block when an earlier call
    (same run) already saw it.
    """
    # 1. LLD plan — the spec, not the legacy `ctx.plan` (empty on this pipeline).
    lld = ctx.lld or {}
    lld_block = "LLD PLAN\n════════\n\n" + json.dumps(lld)

    # 2. Pre-codegen alignment notes — the cross-agent contracts every
    #    codegen agent was instructed to honour.
    notes = ctx.alignment_notes or []
    if notes:
        rendered = "\n".join(
            f"  - [{n.get('concern', '?')} → {','.join(n.get('target_agents') or [])}] "
            f"{n.get('instruction', '').strip()}"
            for n in notes
        )
        alignment_block = (
            "PRE-CODEGEN ALIGNMENT NOTES\n"
            "═══════════════════════════\n\n"
            "Every codegen agent below was told to honour these rules. "
            "Do NOT duplicate them as findings — instead use them to spot "
            "where the generated code violates one.\n\n" + rendered
        )
    else:
        alignment_block = (
            "PRE-CODEGEN ALIGNMENT NOTES\n"
            "═══════════════════════════\n\n"
            "(none — codegen had no cross-agent alignment to honour)"
        )

    # 3. Artifacts index — short summary so the model can navigate
    #    before reading the full dump.
    handler = artifacts.get("backend") or ""
    migration = artifacts.get("db") or ""
    widget = artifacts.get("storefront") or ""
    admin = artifacts.get("admin_ui") or ""

    def _summary(label: str, content: str) -> str:
        if not content:
            return f"  {label}: (missing)"
        lines = content.count("\n") + 1
        return f"  {label}: {len(content)} chars, {lines} lines"

    index_lines = ["ARTIFACTS INDEX", "═══════════════", ""]
    index_lines.append(_summary("backend bundle (src/routes/*.ts)", handler))
    index_lines.append(_summary("db migration (db.sql)", migration))
    if is_storefront:
        index_lines.append(_summary("storefront widget (widget.js)", widget))
    if is_admin_ui:
        index_lines.append(_summary("admin panel (admin_ui.js)", admin))
    if ctx.backend_email_metadata:
        index_lines.append("  email-metadata sidecar: present")
    index_block = "\n".join(index_lines)

    # 4. Artifacts — verbatim, with clear file boundaries.
    artifacts_lines = ["ARTIFACTS", "═════════", ""]
    artifacts_lines += ["── backend bundle ──", handler or "(missing)"]
    artifacts_lines += ["", "── db migration (db.sql) ──", migration or "(missing)"]
    if is_storefront:
        artifacts_lines += [
            "",
            "── storefront widget (widget.js) ──",
            widget or "(missing)",
        ]
    if is_admin_ui:
        artifacts_lines += [
            "",
            "── admin panel (admin_ui.js) ──",
            admin or "(missing)",
        ]
    if ctx.backend_email_metadata:
        artifacts_lines += [
            "",
            "── email-metadata sidecar ──",
            json.dumps(ctx.backend_email_metadata, indent=2),
        ]
    artifacts_block = "\n".join(artifacts_lines)

    return "\n\n".join([lld_block, alignment_block, index_block, artifacts_block])


def run_codegen_validator(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> Tuple[List[Dict[str, Any]], int, int, int, int]:
    """
    Run the codegen validator. Returns
    `(findings, in_tokens, out_tokens, cache_read_tokens, cache_creation_tokens)`.

    `findings` is a list of dicts with keys: `artifact`, `location`,
    `issue`, `failure_mode`, `confidence`. Empty list means either no
    issues were found or the validator failed open.

    `cache_read_tokens` are the prefix tokens served from Anthropic's
    prompt cache at ~10% of the normal input price; `cache_creation_tokens`
    were written to the cache on this call at ~125%. Both are reported
    separately from `in_tokens` so the CLI can show actual cost rather
    than raw totals.
    """
    system = build_system_prompt()
    user = _build_user_prompt(artifacts, ctx, is_storefront, is_admin_ui)
    llm = get_llm(
        model=get_agent_model("codegen_v"),
        max_tokens=_MAX_OUTPUT_TOKENS,
        thinking_budget=_THINKING_BUDGET,
    )

    # 1-hour TTL — codegen_v often runs once, then again after a
    # codegen retry that fixed its findings (within the same pipeline,
    # 5-15 min total). Default 5-min TTL evicts the prefix in between;
    # 1h spans the full pipeline so the system prompt + LLD + alignment
    # block hits cache on the second call.
    response = invoke(llm, system, user, cache_ttl="1h")
    in_tok = response.input_tokens
    out_tok = response.output_tokens
    cache_r = response.cache_read_tokens
    cache_c = response.cache_creation_tokens
    dump_output(response.content)

    if response.stop_reason == "max_tokens":
        log.warning(
            "codegen_v: output truncated at max_tokens=%d — fail-open",
            _MAX_OUTPUT_TOKENS,
        )
        return [], in_tok, out_tok, cache_r, cache_c

    try:
        raw_json = extract_json(response.content)
        output = CodegenVOutput.model_validate_json(raw_json)
    except (ValidationError, ValueError, json.JSONDecodeError) as exc:
        log.warning("codegen_v: failed to parse response (%s) — fail-open", exc)
        return [], in_tok, out_tok, cache_r, cache_c

    # Drop MEDIUM findings — the prompt asks the model not to emit them,
    # but if it does we silently filter. HIGH-only acts on the retry loop.
    findings = [
        f.model_dump(mode="json")
        for f in output.findings
        if f.confidence == "high"
    ]
    for f in findings:
        log.info(
            "codegen_v[%s] %s — %s",
            f["artifact"],
            f["location"],
            f["issue"],
        )

    return findings, in_tok, out_tok, cache_r, cache_c


def group_findings_by_artifact(
    findings: List[Dict[str, Any]],
) -> Dict[str, List[str]]:
    """
    Group codegen-v findings by artifact, returning the shape
    `run_codegen_parallel` expects for `error_map` — `Dict[agent_name,
    List[error_string]]`.

    Each finding becomes one error string: `[location] issue — failure_mode`.
    The codegen agent receiving this error in `previous_errors` already
    has its `prior_<x>_code` populated, so it patches its previous output
    instead of regenerating from scratch.

    Returns empty dict when there are no actionable findings — callers
    branch on `if grouped` to skip the retry round entirely.
    """
    grouped: Dict[str, List[str]] = {}
    for f in findings:
        artifact = f.get("artifact") or ""
        # Only artifacts that map to a codegen agent. "plan" findings are
        # informational — the LLD has already shipped; there's no codegen
        # agent to patch the spec. Surface them as warnings only.
        if artifact not in ("backend", "db", "storefront", "admin_ui"):
            continue
        loc = (f.get("location") or "").strip()
        issue = (f.get("issue") or "").strip()
        failure = (f.get("failure_mode") or "").strip()
        msg = (
            f"[{loc}] {issue} — {failure}"
            if loc
            else f"{issue} — {failure}"
        )
        grouped.setdefault(artifact, []).append(msg)
    return grouped
