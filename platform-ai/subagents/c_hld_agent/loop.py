"""
Two-phase tool-using loop for the HLD agent (Shopify-aware HLD, Phase 2).

Mirrors `w_coding_agent/loop.py`: raw Anthropic client, multi-turn tool use,
1-hour prompt cache. The agent reasons about the domain plan (Phase 1) and
resolves the Shopify bindings (Phase 2 — topic, payload bindings, ops) using
the SAME catalog tools the coding agent has, then calls a terminal
`emit_hld_plan` tool with the full plan. The loop ends when `emit_hld_plan`
validates against `HLDPlan`; on validation errors the model gets them back
and re-emits in the same loop.

Catalog tools and their dispatch are reused verbatim from the coding agent
(`w_coding_agent.tools`) — single source of truth, no duplication. Only the
four read-only catalog lookups are exposed here; the coding agent's
write/tsc/done tools are not registered, so the model cannot call them.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

import anthropic
from pydantic import ValidationError

from subagents.c_hld_agent.patch import PatchError, apply_edits
from subagents.c_hld_agent.schema import HLDPlan
from subagents.w_coding_agent.tools import (
    TOOL_DEFINITIONS as _CODING_TOOL_DEFINITIONS,
)
from subagents.w_coding_agent.tools import (
    RunnerContext,
    call_tool,
)

CACHE_TTL_BETA_HEADER = "extended-cache-ttl-2025-04-11"
DEFAULT_MAX_TURNS = 40
# The emit_hld_plan tool's input IS the whole plan JSON — for complex apps
# (3+ webhook topics with payloadBindings + 15+ capabilities with shopifySteps
# + 5+ tables) it can run 10-15K output tokens just for the structured object,
# plus a few hundred tokens of preamble. The previous 8000 cap silently
# truncated emit calls mid-tool-use, surfacing as "stopped without calling
# emit_hld_plan". Sonnet 4.6 supports up to 64K output; 32K is the right
# headroom — pay only when the model uses it. Generic — applies to any
# loop whose terminal tool carries a large structured output.
DEFAULT_MAX_TOKENS = 32000

EMIT_TOOL = "emit_hld_plan"
PATCH_TOOL = "patch_plan"

# The read-only catalog lookups the HLD agent may call during Phase-2
# resolution. Defined in the coding agent; filtered by name here so the two
# agents share one implementation and one schema.
_CATALOG_TOOL_NAMES = frozenset(
    {
        "list_webhook_family",
        "get_webhook_topic",
        "list_shopify_ops",
        "get_shopify_op",
    }
)


@dataclass
class HLDLoopResult:
    plan: Optional[Dict[str, Any]]  # validated plan (by_alias wire shape), or None
    validation_errors: List[str]  # last emit_hld_plan validation errors, if any
    stopped_without_emit: bool
    hit_turn_cap: bool
    turns_used: int
    total_input_tokens: int
    total_output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    # The raw stop_reason from the final API response when the loop ended
    # without an emit. "end_turn" means the model decided it was done.
    # "max_tokens" means we cut it off mid-response — often the emit call
    # itself, since the tool input carries the entire plan JSON.
    final_stop_reason: Optional[str] = None
    # The last assistant text the model produced when it stopped without
    # emitting. Captured so post-hoc debug can see what the model "said"
    # instead of emitting. None when the loop ended via a successful emit.
    final_assistant_text: Optional[str] = None


def _emit_tool_definition() -> Dict[str, Any]:
    return {
        "name": EMIT_TOOL,
        "description": (
            "Emit the complete HLD plan — the domain design AND the resolved "
            "Shopify bindings (shopifyTopic + payloadBindings per external "
            "event; shopifySteps per shopify-* capability). Call this only "
            "after you have confirmed every topic, op, and payload field via "
            "the catalog tools. If the plan fails validation you receive the "
            "errors back; fix them and call again."
        ),
        "input_schema": HLDPlan.model_json_schema(),
    }


def _patch_tool_definition() -> Dict[str, Any]:
    return {
        "name": PATCH_TOOL,
        "description": (
            "Revise the prior HLD plan by applying ONLY the edits each reviewer "
            "finding requires, then finish — this is the terminal tool for a "
            "revision (there is no emit step). Everything you do not edit is "
            "carried over from the prior plan unchanged. Address each edit by "
            "identity, not position: a capability field as "
            "`capabilities[<id>].<field>` (e.g. `capabilities[process-restock-queue].kind`), "
            "a table field as `persistence[<name>].<field>`, a whole element as "
            "`capabilities[<id>]` / `persistence[<name>]`, or a top-level field by "
            "name (`dataFlow`, `complexity`, `edgeCases`). For a list field "
            "(keyedByColumns, shopifySteps, edgeCases) supply the FULL new list as "
            "the value. The edited plan is validated as a whole; if it fails you "
            "get the errors back — fix the edits and call again. Call once with all "
            "edits."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "edits": {
                    "type": "array",
                    "minItems": 1,
                    "description": "Every change the findings require, addressed by id/name.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": (
                                    "Where to set: '<field>' (top-level), "
                                    "'capabilities[<id>]' / 'persistence[<name>]' (whole "
                                    "element), or '<coll>[<key>].<field>' (one field)."
                                ),
                            },
                            "value": {
                                "description": "The full new value for that path (any JSON type)."
                            },
                        },
                        "required": ["path", "value"],
                    },
                }
            },
            "required": ["edits"],
        },
    }


def _tool_definitions(prior_plan: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    catalog = [d for d in _CODING_TOOL_DEFINITIONS if d["name"] in _CATALOG_TOOL_NAMES]
    # Revise mode (a prior plan to edit) exposes patch_plan as the terminal;
    # the first pass exposes emit_hld_plan. Only one terminal is ever offered.
    terminal = _patch_tool_definition() if prior_plan is not None else _emit_tool_definition()
    return catalog + [terminal]


def _format_pydantic_errors(err: ValidationError) -> List[str]:
    out: List[str] = []
    for e in err.errors():
        loc = ".".join(str(p) for p in e.get("loc", ())) or "<root>"
        out.append(f"{loc}: {e.get('msg', 'validation error')}")
    return out


def run_hld_loop(
    ctx: RunnerContext,
    system_prompt: str,
    user_message: str,
    *,
    model: str,
    max_turns: int = DEFAULT_MAX_TURNS,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    on_tool_call: Optional[Callable[[str], None]] = None,
    prior_plan: Optional[Dict[str, Any]] = None,
) -> HLDLoopResult:
    """Drive the HLD agent until it produces a valid plan or the budget runs out.

    First pass (`prior_plan is None`): the terminal tool is `emit_hld_plan` and
    the model submits the whole plan. Revise (`prior_plan` set): the terminal is
    `patch_plan` — the model submits only the edits each finding needs, applied to
    the prior plan and re-validated as a whole. Either way the loop ends when a
    valid plan results.
    """
    client = anthropic.Anthropic()
    tools = _tool_definitions(prior_plan)

    messages: List[Dict[str, Any]] = [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": user_message,
                    "cache_control": {"type": "ephemeral", "ttl": "1h"},
                }
            ],
        }
    ]

    tot_in = tot_out = tot_cache_r = tot_cache_c = 0
    last_errors: List[str] = []
    turn = 0
    tool_call_idx = 0

    for turn in range(1, max_turns + 1):
        # Streamed — the Anthropic SDK refuses non-streaming calls whose
        # max_tokens could imply >10 min of processing. With our 32K cap
        # (sized so emit_hld_plan can carry the full plan JSON), .create()
        # raises before sending. .stream() places the call and we collect
        # the final message; the shape is identical to .create()'s return.
        with client.messages.stream(
            model=model,
            max_tokens=max_tokens,
            system=[
                {
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral", "ttl": "1h"},
                }
            ],
            tools=tools,
            messages=messages,
            extra_headers={"anthropic-beta": CACHE_TTL_BETA_HEADER},
        ) as stream:
            resp = stream.get_final_message()

        tot_in += resp.usage.input_tokens
        tot_out += resp.usage.output_tokens
        tot_cache_r += getattr(resp.usage, "cache_read_input_tokens", 0) or 0
        tot_cache_c += getattr(resp.usage, "cache_creation_input_tokens", 0) or 0

        messages.append({"role": "assistant", "content": resp.content})

        if resp.stop_reason != "tool_use":
            # Model stopped without emitting — surface cleanly with what
            # the model actually said and why it stopped.
            text_parts: List[str] = []
            for b in resp.content:
                if getattr(b, "type", None) == "text":
                    text_parts.append(b.text or "")
            final_text = "\n".join(text_parts).strip() or None
            return HLDLoopResult(
                plan=None,
                validation_errors=last_errors,
                stopped_without_emit=True,
                hit_turn_cap=False,
                turns_used=turn,
                total_input_tokens=tot_in,
                total_output_tokens=tot_out,
                cache_read_tokens=tot_cache_r,
                cache_creation_tokens=tot_cache_c,
                final_stop_reason=resp.stop_reason,
                final_assistant_text=final_text,
            )

        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        result_blocks: List[Dict[str, Any]] = []
        emitted_plan: Optional[Dict[str, Any]] = None

        for tu in tool_uses:
            tool_input = dict(tu.input)
            t0 = time.monotonic()
            if tu.name == EMIT_TOOL:
                try:
                    plan = HLDPlan.model_validate(tool_input)
                    emitted_plan = plan.model_dump(mode="json", by_alias=True)
                    result: Dict[str, Any] = {"ok": True}
                    last_errors = []
                except ValidationError as e:
                    last_errors = _format_pydantic_errors(e)
                    result = {"ok": False, "errors": last_errors}
            elif tu.name == PATCH_TOOL:
                # Revise terminal: apply the edits to the prior plan and validate
                # the whole candidate. Atomic — on any path or schema error nothing
                # is committed and the model gets the errors back to retry.
                try:
                    if prior_plan is None:
                        raise PatchError("patch_plan called with no prior plan to edit")
                    candidate = apply_edits(prior_plan, tool_input.get("edits"))
                    plan = HLDPlan.model_validate(candidate)
                    emitted_plan = plan.model_dump(mode="json", by_alias=True)
                    result = {"ok": True}
                    last_errors = []
                except PatchError as e:
                    last_errors = [f"patch: {e}"]
                    result = {"ok": False, "errors": last_errors}
                except ValidationError as e:
                    last_errors = _format_pydantic_errors(e)
                    result = {"ok": False, "errors": last_errors}
            else:
                result = call_tool(ctx, tu.name, tool_input)
            ms = int((time.monotonic() - t0) * 1000)

            tool_call_idx += 1
            _log_tool_call(tool_call_idx, tu.name, tool_input, result, ms)

            if on_tool_call is not None:
                on_tool_call(_cli_line(tu.name, tool_input, result))

            result_blocks.append(
                {
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": json.dumps(result, indent=2),
                }
            )

        messages.append({"role": "user", "content": result_blocks})

        if emitted_plan is not None:
            return HLDLoopResult(
                plan=emitted_plan,
                validation_errors=[],
                stopped_without_emit=False,
                hit_turn_cap=False,
                turns_used=turn,
                total_input_tokens=tot_in,
                total_output_tokens=tot_out,
                cache_read_tokens=tot_cache_r,
                cache_creation_tokens=tot_cache_c,
            )

    return HLDLoopResult(
        plan=None,
        validation_errors=last_errors,
        stopped_without_emit=False,
        hit_turn_cap=True,
        turns_used=turn,
        total_input_tokens=tot_in,
        total_output_tokens=tot_out,
        cache_read_tokens=tot_cache_r,
        cache_creation_tokens=tot_cache_c,
    )


def _log_tool_call(
    idx: int,
    name: str,
    tool_input: Dict[str, Any],
    result: Dict[str, Any],
    ms_elapsed: int,
) -> None:
    """Mirror w_coding_agent.loop._log_tool_call: per-call input.json +
    output.json under inputs/hld/attempt_1/tool_calls/, plus one
    manifest line. Gives the HLD the same observability the coding agent
    already has — without this you can't see whether the architect
    actually called list_webhook_family or just guessed.

    Reads the active run_dir from `current_input_log_run_dir()`; no-op
    outside an input_log block (so unit tests of the loop don't write to
    repo root)."""
    from models.adapter import current_input_log_run_dir
    run_dir = current_input_log_run_dir()
    if run_dir is None:
        return
    base = run_dir / "inputs" / "hld" / "attempt_1" / "tool_calls"
    base.mkdir(parents=True, exist_ok=True)
    call_dir = base / f"{idx:03d}_{name}"
    call_dir.mkdir(parents=True, exist_ok=True)
    (call_dir / "input.json").write_text(json.dumps(tool_input, indent=2))
    (call_dir / "output.json").write_text(json.dumps(result, indent=2))

    manifest = run_dir / "inputs" / "hld" / "attempt_1" / "manifest.jsonl"
    line = {
        "idx": idx,
        "tool": name,
        "ms": ms_elapsed,
        "ok": (result.get("ok") if isinstance(result, dict) and "ok" in result
               else ("error" not in result if isinstance(result, dict) else True)),
    }
    with manifest.open("a") as f:
        f.write(json.dumps(line) + "\n")


def _cli_line(name: str, tool_input: Dict[str, Any], result: Dict[str, Any]) -> str:
    if name == "list_webhook_family":
        summary = tool_input.get("prefix", "")
    elif name in ("get_webhook_topic", "get_shopify_op"):
        summary = tool_input.get("name", "")
    elif name == "list_shopify_ops":
        summary = f"{tool_input.get('cluster', '')} ({tool_input.get('surface', '')})"
    elif name == EMIT_TOOL:
        summary = "ok" if result.get("ok") else f"{len(result.get('errors', []))} errors"
    elif name == PATCH_TOOL:
        n = len(tool_input.get("edits") or [])
        status = "ok" if result.get("ok") else f"{len(result.get('errors', []))} errors"
        summary = f"{n} edits → {status}"
    else:
        summary = ""
    failed = isinstance(result, dict) and (result.get("ok") is False or "error" in result)
    mark = "✗" if failed else "✓"
    return f"[hld] {name:20s} {summary}  {mark}"
