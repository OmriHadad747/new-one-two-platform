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
read-only catalog lookups are exposed here; the coding agent's
write/tsc/done tools are not registered, so the model cannot call them.

The loop serves the whole HLD family — architect (emit_hld_plan), revise
(patch_plan), and the hld_v validator (emit_hld_findings) — on ONE request
shape: identical tools array, the architect's system text as the first
cached block. Anthropic's prompt cache is a prefix match over
[tools][system][messages], so this sharing is what lets revise and hld_v
READ the architect's ~38KB cached system block (~10% input price) instead
of each stage writing its own entry.
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
from subagents.e_hld_v_agent.schema import HLDVOutput
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
FINDINGS_TOOL = "emit_hld_findings"

# The read-only catalog lookups the HLD agent may call during Phase-2
# resolution. Defined in the coding agent; filtered by name here so the two
# agents share one implementation and one schema.
_CATALOG_TOOL_NAMES = frozenset(
    {
        "list_webhook_family",
        "get_webhook_topic",
        "search_shopify_ops",
        "list_shopify_ops",
        "get_shopify_op",
    }
)

# Fixed order for the catalog tools so the serialized tools array is
# byte-identical on every call — Anthropic's prompt cache is a prefix match
# over [tools][system][messages], so any reordering invalidates everything.
_CATALOG_TOOL_ORDER = (
    "list_webhook_family",
    "get_webhook_topic",
    "search_shopify_ops",
    "list_shopify_ops",
    "get_shopify_op",
)


@dataclass
class HLDLoopResult:
    # Validated terminal output, or None. Architect/revise: the plan dict
    # (by_alias wire shape). Validate: the HLDVOutput dict ({"findings": [...]}).
    plan: Optional[Dict[str, Any]]
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


def _findings_tool_definition() -> Dict[str, Any]:
    return {
        "name": FINDINGS_TOOL,
        "description": (
            "Emit the HLD validation findings — the terminal tool for the "
            "REVIEWER role only. Call exactly once with the full findings "
            "list (up to 5, highest severity first; an empty list is the "
            "correct answer for a clean plan)."
        ),
        "input_schema": HLDVOutput.model_json_schema(),
    }


def _tool_definitions() -> List[Dict[str, Any]]:
    """The SAME tools array for every HLD-family stage — architect, revise,
    and validate — in a fixed order.

    This is deliberate cache engineering, not sloppiness: Anthropic caches
    the request prefix [tools][system][messages], so the three stages share
    the architect's cached ~38KB system block ONLY if their serialized
    tools arrays are byte-identical. Offering all three terminals
    everywhere costs a few hundred tokens of definitions; per-stage
    enforcement of which terminal is legal lives in the loop (wrong
    terminal → corrective error result), and the user templates name the
    one expected terminal.
    """
    by_name = {d["name"]: d for d in _CODING_TOOL_DEFINITIONS}
    catalog = [by_name[n] for n in _CATALOG_TOOL_ORDER]
    return catalog + [
        _emit_tool_definition(),
        _patch_tool_definition(),
        _findings_tool_definition(),
    ]


def _format_pydantic_errors(err: ValidationError) -> List[str]:
    out: List[str] = []
    for e in err.errors():
        loc = ".".join(str(p) for p in e.get("loc", ())) or "<root>"
        out.append(f"{loc}: {e.get('msg', 'validation error')}")
    return out


def run_hld_loop(
    ctx: RunnerContext,
    system_prompt: "str | List[str]",
    user_message: str,
    *,
    model: str,
    mode: str = "architect",
    max_turns: int = DEFAULT_MAX_TURNS,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    on_tool_call: Optional[Callable[[str], None]] = None,
    prior_plan: Optional[Dict[str, Any]] = None,
    thinking_budget: Optional[int] = None,
    log_agent: str = "hld",
) -> HLDLoopResult:
    """Drive an HLD-family stage until its terminal tool yields a valid output
    or the budget runs out.

    `mode` selects which terminal is legal — "architect" (`emit_hld_plan`,
    full plan), "revise" (`patch_plan`, minimal edits applied to `prior_plan`),
    or "validate" (`emit_hld_findings`, reviewer findings; the result's `plan`
    field then carries the validated HLDVOutput dict). All three modes send
    the SAME tools array (`_tool_definitions()`), so they share one cached
    [tools][system] prefix; a call to the wrong terminal gets a corrective
    error result, not a crash.

    `system_prompt` may be a list of segments — each becomes its own cached
    system block, so a stage can prepend the architect's exact system text
    (cache-shared) and append its own wrapper (cached separately). Extended
    thinking (`thinking_budget`) only invalidates message-level cache entries,
    never the tools/system prefix, so the validator can think while still
    reading the architect's cache.
    """
    if mode not in ("architect", "revise", "validate"):
        raise ValueError(f"unknown HLD loop mode {mode!r}")
    if mode == "revise" and prior_plan is None:
        raise ValueError("revise mode requires prior_plan")

    client = anthropic.Anthropic()
    tools = _tool_definitions()

    system_segments = (
        [system_prompt] if isinstance(system_prompt, str) else list(system_prompt)
    )
    system_blocks = [
        {
            "type": "text",
            "text": seg,
            "cache_control": {"type": "ephemeral", "ttl": "1h"},
        }
        for seg in system_segments
    ]

    extra: Dict[str, Any] = {}
    if thinking_budget:
        extra["thinking"] = {"type": "enabled", "budget_tokens": thinking_budget}

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
            system=system_blocks,
            tools=tools,
            messages=messages,
            extra_headers={"anthropic-beta": CACHE_TTL_BETA_HEADER},
            **extra,
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
            # All three terminals exist in every request (shared cache
            # prefix); only the mode's own terminal is honored — the others
            # return a corrective error so the model self-redirects.
            _WRONG_TERMINAL = {
                "architect": (
                    "this is the FIRST-PASS design task — its terminal is "
                    "emit_hld_plan with the complete plan"
                ),
                "revise": (
                    "this is a REVISION — its terminal is patch_plan with the "
                    "minimal edits; do not re-emit the plan or emit findings"
                ),
                "validate": (
                    "you are the REVIEWER — your terminal is emit_hld_findings "
                    "with your findings list; never emit or patch the plan"
                ),
            }
            if tu.name == EMIT_TOOL:
                if mode != "architect":
                    result = {"ok": False, "errors": [_WRONG_TERMINAL[mode]]}
                else:
                    try:
                        plan = HLDPlan.model_validate(tool_input)
                        emitted_plan = plan.model_dump(mode="json", by_alias=True)
                        result = {"ok": True}
                        last_errors = []
                    except ValidationError as e:
                        last_errors = _format_pydantic_errors(e)
                        result = {"ok": False, "errors": last_errors}
            elif tu.name == PATCH_TOOL:
                # Revise terminal: apply the edits to the prior plan and validate
                # the whole candidate. Atomic — on any path or schema error nothing
                # is committed and the model gets the errors back to retry.
                if mode != "revise":
                    result = {"ok": False, "errors": [_WRONG_TERMINAL[mode]]}
                else:
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
            elif tu.name == FINDINGS_TOOL:
                if mode != "validate":
                    result = {"ok": False, "errors": [_WRONG_TERMINAL[mode]]}
                else:
                    try:
                        findings = HLDVOutput.model_validate(tool_input)
                        emitted_plan = findings.model_dump(mode="json")
                        result = {"ok": True}
                        last_errors = []
                    except ValidationError as e:
                        last_errors = _format_pydantic_errors(e)
                        result = {"ok": False, "errors": last_errors}
            else:
                result = call_tool(ctx, tu.name, tool_input)
            ms = int((time.monotonic() - t0) * 1000)

            tool_call_idx += 1
            _log_tool_call(tool_call_idx, tu.name, tool_input, result, ms, log_agent)

            if on_tool_call is not None:
                on_tool_call(_cli_line(tu.name, tool_input, result, log_agent))

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
    log_agent: str = "hld",
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
    base = run_dir / "inputs" / log_agent / "attempt_1" / "tool_calls"
    base.mkdir(parents=True, exist_ok=True)
    call_dir = base / f"{idx:03d}_{name}"
    call_dir.mkdir(parents=True, exist_ok=True)
    (call_dir / "input.json").write_text(json.dumps(tool_input, indent=2))
    (call_dir / "output.json").write_text(json.dumps(result, indent=2))

    manifest = run_dir / "inputs" / log_agent / "attempt_1" / "manifest.jsonl"
    line = {
        "idx": idx,
        "tool": name,
        "ms": ms_elapsed,
        "ok": (result.get("ok") if isinstance(result, dict) and "ok" in result
               else ("error" not in result if isinstance(result, dict) else True)),
    }
    with manifest.open("a") as f:
        f.write(json.dumps(line) + "\n")


def _cli_line(
    name: str,
    tool_input: Dict[str, Any],
    result: Dict[str, Any],
    log_agent: str = "hld",
) -> str:
    if name == "list_webhook_family":
        summary = tool_input.get("prefix", "")
    elif name in ("get_webhook_topic", "get_shopify_op"):
        summary = tool_input.get("name", "")
    elif name == "list_shopify_ops":
        summary = f"{tool_input.get('cluster', '')} ({tool_input.get('surface', '')})"
    elif name == "search_shopify_ops":
        summary = f"{tool_input.get('keyword', '')} ({tool_input.get('surface', '')})"
    elif name == EMIT_TOOL:
        summary = "ok" if result.get("ok") else f"{len(result.get('errors', []))} errors"
    elif name == PATCH_TOOL:
        n = len(tool_input.get("edits") or [])
        status = "ok" if result.get("ok") else f"{len(result.get('errors', []))} errors"
        summary = f"{n} edits → {status}"
    elif name == FINDINGS_TOOL:
        n = len(tool_input.get("findings") or [])
        status = "ok" if result.get("ok") else f"{len(result.get('errors', []))} errors"
        summary = f"{n} findings → {status}"
    else:
        summary = ""
    failed = isinstance(result, dict) and (result.get("ok") is False or "error" in result)
    mark = "✗" if failed else "✓"
    return f"[{log_agent}] {name:20s} {summary}  {mark}"
