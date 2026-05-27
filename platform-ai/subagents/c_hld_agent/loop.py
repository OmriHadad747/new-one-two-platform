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
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

import anthropic
from pydantic import ValidationError

from subagents.c_hld_agent.schema import HLDPlan
from subagents.w_coding_agent.tools import (
    TOOL_DEFINITIONS as _CODING_TOOL_DEFINITIONS,
    RunnerContext,
    call_tool,
)

CACHE_TTL_BETA_HEADER = "extended-cache-ttl-2025-04-11"
DEFAULT_MAX_TURNS = 40
DEFAULT_MAX_TOKENS = 8000

EMIT_TOOL = "emit_hld_plan"

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


def _tool_definitions() -> List[Dict[str, Any]]:
    catalog = [d for d in _CODING_TOOL_DEFINITIONS if d["name"] in _CATALOG_TOOL_NAMES]
    return catalog + [_emit_tool_definition()]


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
) -> HLDLoopResult:
    """Drive the HLD agent until it emits a valid plan or the budget runs out."""
    client = anthropic.Anthropic()
    tools = _tool_definitions()

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

    for turn in range(1, max_turns + 1):
        resp = client.messages.create(
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
        )

        tot_in += resp.usage.input_tokens
        tot_out += resp.usage.output_tokens
        tot_cache_r += getattr(resp.usage, "cache_read_input_tokens", 0) or 0
        tot_cache_c += getattr(resp.usage, "cache_creation_input_tokens", 0) or 0

        messages.append({"role": "assistant", "content": resp.content})

        if resp.stop_reason != "tool_use":
            # Model stopped without emitting — surface cleanly.
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
            )

        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        result_blocks: List[Dict[str, Any]] = []
        emitted_plan: Optional[Dict[str, Any]] = None

        for tu in tool_uses:
            tool_input = dict(tu.input)
            if tu.name == EMIT_TOOL:
                try:
                    plan = HLDPlan.model_validate(tool_input)
                    emitted_plan = plan.model_dump(mode="json", by_alias=True)
                    result: Dict[str, Any] = {"ok": True}
                    last_errors = []
                except ValidationError as e:
                    last_errors = _format_pydantic_errors(e)
                    result = {"ok": False, "errors": last_errors}
            else:
                result = call_tool(ctx, tu.name, tool_input)

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


def _cli_line(name: str, tool_input: Dict[str, Any], result: Dict[str, Any]) -> str:
    if name == "list_webhook_family":
        summary = tool_input.get("prefix", "")
    elif name in ("get_webhook_topic", "get_shopify_op"):
        summary = tool_input.get("name", "")
    elif name == "list_shopify_ops":
        summary = f"{tool_input.get('cluster', '')} ({tool_input.get('surface', '')})"
    elif name == EMIT_TOOL:
        summary = "ok" if result.get("ok") else f"{len(result.get('errors', []))} errors"
    else:
        summary = ""
    mark = "✗" if (isinstance(result, dict) and (result.get("ok") is False or "error" in result)) else "✓"
    return f"[hld] {name:20s} {summary}  {mark}"
