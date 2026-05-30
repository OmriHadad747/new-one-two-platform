"""
Downstream micro-validators (Phase 3).

Three narrow, single-invariant checks that run inside `done()` AFTER the
deterministic gate (integrity.py) passes. Each catches a class of bug that
is irreducibly post-hoc and cross-file — it only exists once code is
written, and tsc can't see it:

  1. write-path-integrity   — references written to the DB come from real
                              data, never a literal/placeholder/empty.
  2. shopify-effect-integrity — every declared shopify-* op is actually
                              invoked (whole sequence), with real ids.
  3. persistence-safety     — ON CONFLICT not SELECT-then-INSERT; no
                              feature-disabling early-return on a required
                              field.

Design invariants (see GENERATION_QUALITY_PLAN.md §6):
  - GENERAL, never app-specific. The criteria are universal; the plan only
    supplies intent + aim. The app's domain lives in the data, not the rule.
  - ADVISORY, never mutating. A validator emits findings; the coding agent
    fixes its own code. Findings of critical/important severity block
    done() (returned as incomplete_reason) so the agent addresses them
    in-loop; minor findings do not block.
  - Haiku + minimal inputs + static (cacheable) system prompts.
  - Fail-open: a validator infra error never blocks the pipeline.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from models.adapter import get_llm, invoke_structured
from models.agent_models import get_agent_model

if TYPE_CHECKING:
    from subagents.w_coding_agent.tools import RunnerContext

_MAX_TOKENS = 2500
_BLOCKING_SEVERITIES = frozenset({"critical", "important"})


# ── Findings schema (the tool the validator emits) ───────────────────────────


class Finding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    severity: str = Field(description="critical | important | minor")
    file: str
    line: Optional[int] = None
    issue: str = Field(description="the offending code, quoted, and why it's wrong")
    fix: str = Field(
        description=(
            "ONE imperative sentence that prescribes EXACTLY ONE change. "
            "Forbidden: 'either / or', 'options: (1)... (2)...', 'could / "
            "should / may', 'one approach is...', a menu of alternatives, "
            "or a comment-only suggestion that doesn't change behavior. "
            "If two distinct fixes are defensible, emit two SEPARATE "
            "findings — never one finding with a menu. The coding agent "
            "must be able to act on this sentence verbatim."
        )
    )


class Findings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    findings: List[Finding] = Field(default_factory=list)


# ── Checklists (static system prompts — GENERAL, cacheable) ──────────────────

_PREAMBLE = """\
You review one generated Shopify-app source bundle for a SINGLE invariant.
Your criteria are GENERAL — they hold for every app; the plan only tells you
the app's intent and where to look. Never invent app-specific requirements.

You are given the relevant PLAN excerpt (what the app should do) and the
CODE to review. Judge only the invariant below. tsc already owns type/style
issues — never flag those. Quote the offending code; if you can't quote it
from the provided code, drop the finding (that is your guard against
hallucinating). An empty findings list is the correct answer for clean code;
do not manufacture findings.

severity: critical = silently breaks a feature or corrupts data;
important = a declared behavior is unreliable; minor = cosmetic/no runtime
impact.

FIX FORMAT (strict): each finding's `fix` is ONE imperative sentence that
prescribes EXACTLY ONE change. No options menu, no "either / or", no
"(1)... (2)...", no "could / should / may", no "one approach is...". If
you believe two distinct fixes are defensible, emit two SEPARATE findings
— never a single finding with a menu. The downstream agent must be able
to act on your sentence verbatim. A fix that only adds a comment or
"reframes" the contract WITHOUT changing behavior is not a fix; do not
emit it.

THE INVARIANT:
"""

WRITE_PATH_CHECKLIST = _PREAMBLE + """\
Every value written to a reference/identifier database column must come from
REAL data — a resource-picker result field, a prior response, or genuine
user input — never a hardcoded literal, placeholder, or empty stand-in; and
the field a UI surface sends must be the field the route persists.

Flag when:
  - a UI write sends a constant/placeholder for a reference field
    (e.g. `?? "0"`, `"0"`, `|| 0`, `""`, a hardcoded id) instead of a real
    picked/input value.
  - a UI sends an empty collection where the route inserts rows from it
    (yielding zero rows — an uninhabitable record through the UI).
  - the field name the UI sends differs from the field the route reads (the
    two ends disagree about the contract).

Do NOT flag: backend-internal ids (gen_random_uuid()), legitimately optional
fields with correct defaults, or anything tsc owns.
"""

SHOPIFY_EFFECT_CHECKLIST = _PREAMBLE + """\
Every capability the plan marks integration=shopify-admin/shopify-storefront
must ACTUALLY invoke its resolved op(s) — every step of a multi-step
sequence — and every id/code/gid passed to a Shopify op must come from a
prior op's response or the inbound request, never a fabricated or literal
string. A declared Shopify effect must be performed, not faked.

Flag when:
  - a shopify-* capability's declared op never appears as a real call in the
    code — the effect is missing or faked (e.g. a discount "applied" by
    attaching a cart line-item property or returning a rate, with no
    discount-creating op called).
  - a multi-step sequence drops a step (e.g. creates a discount but never
    applies the returned code to the cart).
  - an id/code/gid handed to a Shopify op is a literal or synthesized string
    (e.g. "BUNDLE-XXXX") rather than sourced from a prior response/request.

Do NOT flag: ops the plan didn't declare, internal/DB-only logic, or
anything tsc owns.
"""

PERSISTENCE_CHECKLIST = _PREAMBLE + """\
Two persistence-safety rules:
  (1) Idempotent/dedup writes must use `INSERT ... ON CONFLICT`, never a
      `SELECT existing; if none INSERT` pattern (a race). This applies to
      any write that must be idempotent — especially webhook handlers and
      any table the plan keys for dedup.
  (2) A payload field the plan treats as required/non-null must NOT be
      guarded by an early-return that disables the handler (the
      `if (!field) return;` pattern that silently kills a feature).

Flag when:
  - a SELECT-then-INSERT race is used where ON CONFLICT is required.
  - an early-return guards a field the plan declares present, disabling the
    handler's effect.

Do NOT flag: legitimate guards on fields the plan/payload marks nullable,
correct ON CONFLICT usage, or anything tsc owns.
"""


# ── File selection (deterministic aim) ───────────────────────────────────────


def _read_existing(scaffold, rels: List[str]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for rel in rels:
        p = scaffold / rel
        if p.is_file():
            out[rel] = p.read_text()
    return out


def _glob_existing(scaffold, *globs: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for g in globs:
        for p in sorted(scaffold.glob(g)):
            if p.is_file():
                out[str(p.relative_to(scaffold))] = p.read_text()
    return out


def _select_write_path(scaffold) -> Dict[str, str]:
    files = _read_existing(scaffold, ["admin/ui.ts", "widget/widget.ts"])
    files.update(_glob_existing(scaffold, "src/routes/*.ts"))
    return files


def _select_shopify_effect(scaffold) -> Dict[str, str]:
    return _glob_existing(
        scaffold,
        "src/routes/*.ts",
        "src/webhooks/*.ts",
        "src/lib/**/*.ts",
    ) | _read_existing(scaffold, ["widget/widget.ts", "admin/ui.ts"])


def _select_persistence(scaffold) -> Dict[str, str]:
    return _glob_existing(
        scaffold, "src/routes/*.ts", "src/webhooks/*.ts", "src/lib/**/*.ts"
    )


# (name, checklist, file-selector, applies?) — `applies` lets a validator
# skip cheaply when the plan implies it has nothing to judge.
_VALIDATORS = [
    ("write-path-integrity", WRITE_PATH_CHECKLIST, _select_write_path),
    ("shopify-effect-integrity", SHOPIFY_EFFECT_CHECKLIST, _select_shopify_effect),
    ("persistence-safety", PERSISTENCE_CHECKLIST, _select_persistence),
]


# ── Orchestration ────────────────────────────────────────────────────────────


def run_validators(
    ctx: "RunnerContext",
    on_tool_call: Optional[Callable[[str], None]] = None,
) -> List[str]:
    """Run the three micro-validators over the scaffold. Returns blocking
    findings (critical/important) as actionable strings; empty = clean.
    Fail-open: any validator that errors is skipped, never blocks."""
    scaffold = ctx.work_dir / "scaffold"
    plan_json = json.dumps(ctx.plan, indent=2) if getattr(ctx, "plan", None) else "{}"
    schema = Findings.model_json_schema()
    model = get_agent_model("codegen_v")

    blocking: List[str] = []

    for name, checklist, selector in _VALIDATORS:
        files = selector(scaffold)
        if not files:
            continue
        user = _build_user_message(plan_json, files)
        try:
            llm = get_llm(model=model, max_tokens=_MAX_TOKENS)
            result = invoke_structured(
                llm,
                checklist,
                user,
                tool_name="emit_findings",
                tool_description=(
                    "Emit findings for the single invariant in the system "
                    "prompt. Empty list if the code is clean."
                ),
                tool_input_schema=schema,
                cache_ttl="1h",
            )
            _accumulate_usage(ctx, result)
            findings = Findings.model_validate(result.structured_output).findings
        except Exception as e:  # fail-open — infra error must not block done()
            if on_tool_call is not None:
                on_tool_call(f"[validator] {name}: skipped ({type(e).__name__})")
            continue

        n_block = 0
        for f in findings:
            if f.severity in _BLOCKING_SEVERITIES:
                n_block += 1
                loc = f"{f.file}:{f.line}" if f.line else f.file
                blocking.append(f"[{name}] {f.severity} {loc} — {f.issue} FIX: {f.fix}")
        if on_tool_call is not None:
            on_tool_call(
                f"[validator] {name}: {n_block} blocking / {len(findings)} total"
            )

    return blocking


def _accumulate_usage(ctx: "RunnerContext", result: Any) -> None:
    """Sum one validator call's tokens onto ctx.validator_usage (the run's
    running total across every done() invocation)."""
    u = ctx.validator_usage
    u["input_tokens"] += getattr(result, "input_tokens", 0) or 0
    u["output_tokens"] += getattr(result, "output_tokens", 0) or 0
    u["cache_read_tokens"] += getattr(result, "cache_read_tokens", 0) or 0
    u["cache_creation_tokens"] += getattr(result, "cache_creation_tokens", 0) or 0


def _build_user_message(plan_json: str, files: Dict[str, str]) -> str:
    parts = [
        "═══ PLAN (intent — what the app should do; use for aim, not as the rule) ═══",
        plan_json,
        "",
        "═══ CODE TO REVIEW ═══",
    ]
    for path, text in files.items():
        parts.append(f"\n--- {path} ---\n{text}")
    return "\n".join(parts)
