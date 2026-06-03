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
Merchant request: {prompt}

Product-agent intent (use as context — pick the archetype, capabilities,
and contracts from the merchant's actual needs):
{intent_json}

Work in two phases, then call emit_hld_plan:
  1. Design the domain plan (archetype, data model, capabilities, triggers,
     contracts) in domain terms.
  2. Resolve the Shopify bindings with the catalog tools — for each
     external-event trigger pick the topic and bind every signalField to a
     real payload path (verified with get_webhook_topic) or a declared
     resolution hop; for each shopify-* capability resolve the op(s) (use
     list_shopify_ops to compare siblings, get_shopify_op for detail).
Then call emit_hld_plan once with the complete plan."""

_REVISE_TEMPLATE = """\
Merchant request: {prompt}

Product-agent intent (use as context):
{intent_json}

REVISE the prior HLD plan below to address every reviewer finding, then call
emit_hld_plan with the corrected plan.

PRIOR PLAN — sections the reviewer did NOT flag must be carried over
unchanged. Do not drop, rename, reorder, or reword unflagged capabilities,
tables, columns, contracts, bindings, edge cases, or dataFlow phrasing. Do
not add anything beyond what a finding's fix requires. Re-verify any binding
you change against the catalog tools before emitting.

```json
{prior_plan_json}
```

REVIEWER FINDINGS — apply each finding's fix to the relevant section; leave
everything else untouched.

{findings_text}"""


def run_hld_agent(
    prompt: str,
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
    if validator_hint and prior_plan is not None:
        user = _REVISE_TEMPLATE.format(
            prompt=prompt,
            intent_json=json.dumps(intent),
            prior_plan_json=json.dumps(prior_plan),
            findings_text=validator_hint,
        )
    else:
        user = _USER_TEMPLATE.format(prompt=prompt, intent_json=json.dumps(intent))

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
        model=get_agent_model("hld"),
        max_tokens=_MAX_TOKENS,
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
