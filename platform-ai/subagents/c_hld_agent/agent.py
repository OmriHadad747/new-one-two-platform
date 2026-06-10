"""
HLD (high-level design) agent runner — Shopify-aware, two-phase.

The coding agent consumes this plan directly (there is no LLD agent). The
agent runs a multi-turn tool-using loop (`loop.run_hld_loop`):

  Phase 1 (domain): reason about archetype, data model, capabilities,
    triggers, contracts — the integration-agnostic layer.
  Phase 2 (Shopify resolution): use the catalog tools
    (list_webhook_family / get_webhook_topic / list_shopify_ops /
    get_shopify_op) to bind each external event to a real topic + payload
    bindings and each shopify-* capability to its resolved op(s).

The loop ends when the model calls `emit_hld_plan` with a plan that passes
`HLDPlan` validation; on validation failure the model gets the errors back
and re-emits in the same loop (no outer retry).

Returns the parsed plan as a JSON-shape dict (wire aliases — transitions use
`from`, not `from_`) plus token totals.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from models.adapter import dump_input, dump_structured_output
from models.agent_models import get_agent_model
from subagents.c_hld_agent.loop import DEFAULT_MAX_TURNS, run_hld_loop
from subagents.c_hld_agent.prompt import build_system_prompt
from subagents.w_coding_agent.tools import RunnerContext

# platform-ai/subagents/c_hld_agent/agent.py → repo root is parents[3].
REPO_ROOT = Path(__file__).resolve().parents[3]

# Bumped from 8000: the emit_hld_plan tool's input is the FULL plan JSON,
# which for complex apps (3+ topics × payloadBindings + 15+ capabilities ×
# shopifySteps + 5+ tables) can be 10-15K tokens. The old cap silently
# truncated emit calls and surfaced as "stopped without emit". See
# loop.py:DEFAULT_MAX_TOKENS for the full rationale.
_MAX_TOKENS = 32000


_USER_TEMPLATE = """\
Product-agent intent — the AUTHORITATIVE, complete spec. Build EXACTLY the
app it describes: pick the archetype, capabilities, and contracts from this
intent alone. The qualityBrief is the full requirement set — design nothing
outside it, and never design a capability, table, trigger, contract, or
metric for anything listed in `excluded`.
{intent_json}

Work in two phases, then call emit_hld_plan:
  1. Design the domain plan (archetype, data model, capabilities, triggers,
     contracts) in domain terms.
  2. Resolve the Shopify bindings with the catalog tools — for each
     external-event trigger pick the topic and bind every signalField to a
     real payload path (verified with get_webhook_topic) or a declared
     resolution hop; for each shopify-* capability resolve the op(s) (use
     list_shopify_ops to compare siblings, get_shopify_op for detail;
     search_shopify_ops when you can't name the cluster).
Then call emit_hld_plan once with the complete plan. emit_hld_plan is the
ONLY terminal for this task — patch_plan and emit_hld_findings belong to
other stages; never call them."""

_REVISE_TEMPLATE = """\
Product-agent intent — the AUTHORITATIVE, complete spec (design only what it
describes; never (re-)introduce anything in `excluded`):
{intent_json}

REVISE the prior HLD plan to address every reviewer finding. For THIS task the
ONLY terminal tool is `patch_plan` — NOT `emit_hld_plan` (you do not re-emit
the plan) and NOT `emit_hld_findings` (you are not the reviewer). Call
`patch_plan` ONCE with the minimal set of edits; everything you do not edit is
carried over from the prior plan byte-for-byte.

Address each edit by identity, mirroring the finding's location:
  - a capability field : capabilities[<id>].<field>
        e.g. capabilities[process-restock-queue].kind  ->  "write"
  - a table field      : persistence[<name>].<field>
        e.g. persistence[restock_events].keyedByColumns  ->  ["item_external_id", "status"]
  - a whole element    : capabilities[<id>]  or  persistence[<name>]  (object value)
  - a top-level field  : dataFlow, complexity, edgeCases, ...
For a list field (keyedByColumns, shopifySteps, edgeCases) supply the FULL new
list as the value. Make ONLY the changes a finding's fix requires — do not
touch unflagged capabilities, tables, columns, contracts, bindings, or edge
cases. Re-verify any Shopify binding you change against the catalog tools
first. The edited plan is validated as a whole; if it fails you get the errors
back — fix the edits and call `patch_plan` again.

PRIOR PLAN (reference — do NOT re-emit it):

```json
{prior_plan_json}
```

REVIEWER FINDINGS — apply each fix as one or more edits:

{findings_text}"""


def run_hld_agent(
    intent: Dict[str, Any],
    on_attempt_failed: Optional[Callable[[int, List[str], int, int, int, int], None]] = None,
    validator_hint: Optional[str] = None,
    prior_plan: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, Any], int, int, int, int]:
    """Run the HLD agent. Returns
    `(plan_dict, in_tokens, out_tokens, cache_read_tokens, cache_creation_tokens)`.

    Validation lives inside the loop (the model re-emits on `HLDPlan`
    failure); the caller needs no outer retry loop. `on_attempt_failed` is
    retained for caller compatibility but is no longer invoked — the loop is
    internally self-correcting.

    Raises
    ------
    HLDValidationError
        When the loop exhausts its turn budget, stops without emitting, or
        cannot produce a valid plan. Message carries the last error list.
    """
    system = build_system_prompt()
    is_revise = validator_hint is not None and prior_plan is not None
    if is_revise:
        user = _REVISE_TEMPLATE.format(
            intent_json=json.dumps(intent),
            prior_plan_json=json.dumps(prior_plan),
            findings_text=validator_hint,
        )
    else:
        user = _USER_TEMPLATE.format(intent_json=json.dumps(intent))

    # The first pass runs on the (stronger) "hld" model; the revise is a
    # constrained fix task on the cheaper "hld_revise" model. See
    # models/agent_models.py for the rationale.
    model = get_agent_model("hld_revise" if is_revise else "hld")

    # Catalog tools resolve repo-relative paths off repo_root; the HLD agent
    # has no scaffold, so work_dir / run_dir are unused (set to repo_root).
    ctx = RunnerContext(repo_root=REPO_ROOT, work_dir=REPO_ROOT, run_dir=REPO_ROOT)

    # The loop uses a raw Anthropic client and bypasses invoke(), so it never
    # creates an input-trace dir on its own. Trace the prompt here so the HLD
    # run leaves the same inputs/<agent>/attempt_1/{system.txt,user.txt} trail
    # as the single-shot agents; dump_structured_output below adds output.json.
    dump_input(system, user)

    result = run_hld_loop(
        ctx,
        system_prompt=system,
        user_message=user,
        model=model,
        # The tools array is identical across modes (shared cache prefix);
        # mode selects which terminal the loop honors — patch_plan
        # (edit-in-place) for revise, emit_hld_plan for the first pass.
        mode="revise" if is_revise else "architect",
        max_tokens=_MAX_TOKENS,
        prior_plan=prior_plan if is_revise else None,
    )

    if result.plan is not None:
        # Persist the final plan next to the prompt files (no-op outside an
        # active input_log block).
        dump_structured_output(result.plan)
        return (
            result.plan,
            result.total_input_tokens,
            result.total_output_tokens,
            result.cache_read_tokens,
            result.cache_creation_tokens,
        )

    if result.hit_turn_cap:
        errors = result.validation_errors or [
            f"HLD agent hit the {DEFAULT_MAX_TURNS}-turn cap without emitting a valid plan"
        ]
    elif result.stopped_without_emit:
        # Surface the actual stop_reason — "max_tokens" means the emit call
        # was truncated mid-tool-use (raise max_tokens); "end_turn" means the
        # model decided to stop with prose instead of calling the tool.
        reason = result.final_stop_reason or "unknown"
        why = {
            "max_tokens": (
                "the response was cut off mid-tool-use — emit_hld_plan "
                "carries the full plan JSON and overflowed the per-turn "
                "output cap. Raise DEFAULT_MAX_TOKENS in c_hld_agent/loop.py."
            ),
            "end_turn": (
                "the model ended its turn with prose instead of calling "
                "emit_hld_plan. The system prompt's terminal-action "
                "instructions may not be firm enough."
            ),
            "refusal": "the model refused — inspect the assistant text.",
        }.get(reason, f"unexpected stop_reason {reason!r}")
        tail = ""
        if result.final_assistant_text:
            snippet = result.final_assistant_text[:500].replace("\n", " ")
            tail = f' Last assistant text (truncated): "{snippet}"'
        errors = result.validation_errors or [
            f"HLD agent stopped without calling emit_hld_plan "
            f"(stop_reason={reason}): {why}{tail}"
        ]
        # Persist the final assistant text for post-hoc debugging.
        try:
            from pathlib import Path as _Path
            trace_dir = _Path("inputs") / "hld" / "attempt_1"
            if trace_dir.exists() and result.final_assistant_text is not None:
                (trace_dir / "final_assistant_text.txt").write_text(
                    f"stop_reason: {reason}\nturns_used: {result.turns_used}\n\n"
                    + result.final_assistant_text
                )
        except Exception:
            pass  # never let trace-writing block the error path
    else:
        errors = result.validation_errors or ["HLD agent failed to emit a valid plan"]

    raise HLDValidationError(
        result.turns_used,
        errors,
        result.total_input_tokens,
        result.total_output_tokens,
        result.cache_read_tokens,
        result.cache_creation_tokens,
    )


# ── Internals ─────────────────────────────────────────────────────────


class HLDValidationError(RuntimeError):
    """Raised when the HLD agent fails to produce a valid plan."""

    def __init__(
        self,
        attempts: int,
        errors: List[str],
        in_tokens: int,
        out_tokens: int,
        cache_read_tokens: int = 0,
        cache_creation_tokens: int = 0,
    ) -> None:
        self.attempts = attempts
        self.errors = errors
        self.in_tokens = in_tokens
        self.out_tokens = out_tokens
        self.cache_read_tokens = cache_read_tokens
        self.cache_creation_tokens = cache_creation_tokens
        bullets = "\n".join(f"  - {e}" for e in errors)
        super().__init__(f"HLD agent failed after {attempts} turn(s):\n{bullets}")
