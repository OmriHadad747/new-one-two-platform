"""
Multi-turn tool-use loop for the coding agent.

Drives the model in a tool-use cycle:
  - Sends system prompt + user message + tool definitions.
  - Receives tool_use blocks.
  - Dispatches each via `tools.call_tool`, logs to disk.
  - Wraps results as tool_result content; appends to the conversation.
  - Re-sends until the model stops calling tools, calls done(), or hits
    the turn cap.

Caching:
  - The system prompt is marked `cache_control: ephemeral, ttl: 1h` so
    the heavy reference content is reused across turns AND across runs
    within the hour.
  - Each turn's tool_result content extends the cached prefix
    automatically (Anthropic caches forward through new turns).
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List

import anthropic

from subagents.w_coding_agent.tools import (
    TOOL_DEFINITIONS,
    RunnerContext,
    call_tool,
)


# ── Defaults ────────────────────────────────────────────────────────────────

DEFAULT_MODEL = "claude-sonnet-4-6"
DEFAULT_MAX_TURNS = 50
DEFAULT_MAX_TOKENS = 16384
CACHE_TTL_BETA_HEADER = "extended-cache-ttl-2025-04-11"


# ── Result type ─────────────────────────────────────────────────────────────


@dataclass
class RunResult:
    turns_used: int
    done_called: bool
    final_stop_reason: str
    total_input_tokens: int
    total_output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    hit_turn_cap: bool


# ── Logging ─────────────────────────────────────────────────────────────────


def _tool_calls_dir(ctx: RunnerContext) -> Path:
    d = ctx.run_dir / "tool_calls"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _log_tool_call(
    ctx: RunnerContext,
    idx: int,
    name: str,
    tool_input: Dict[str, Any],
    result: Dict[str, Any],
    ms_elapsed: int,
) -> None:
    """Write input.json + output.{json,txt} + append one manifest line."""
    call_dir = _tool_calls_dir(ctx) / f"{idx:03d}_{name}"
    call_dir.mkdir(parents=True, exist_ok=True)

    (call_dir / "input.json").write_text(json.dumps(tool_input, indent=2))

    # Most results are JSON-friendly. read_file's `content` field is a long
    # string — easier to inspect as plain text. Heuristic: if the result is
    # a single 'content' key with a string value (read_file) OR a single
    # 'errors' / 'note' / 'ok' result, write JSON. We prefer .json
    # uniformly since it round-trips cleanly.
    (call_dir / "output.json").write_text(json.dumps(result, indent=2))

    # Manifest line — append-only, one per call. Used by CLI scan tools
    # and post-hoc inspection.
    ok = result.get("ok") if isinstance(result, dict) else None
    has_error = isinstance(result, dict) and "error" in result
    manifest_line = {
        "idx": idx,
        "tool": name,
        "ms": ms_elapsed,
        "ok": (not has_error) if ok is None else ok,
    }
    with (_tool_calls_dir(ctx).parent / "manifest.jsonl").open("a") as f:
        f.write(json.dumps(manifest_line) + "\n")


def _cli_line(idx: int, name: str, tool_input: Dict[str, Any], result: Dict[str, Any]) -> str:
    """One-line CLI summary: '[003] write_file   scaffold/app.json ✓'"""
    summary = ""
    if name in ("read_file", "write_file"):
        summary = tool_input.get("path", "")
    elif name in ("get_shopify_op", "get_webhook_topic"):
        summary = tool_input.get("name", "")
    elif name == "todo_write":
        summary = f"{len(tool_input.get('todos', []))} todos"
    elif name == "run_tsc":
        errs = result.get("errors", [])
        summary = f"{len(errs)} errors"

    if isinstance(result, dict) and "error" in result:
        mark = "✗"
    elif isinstance(result, dict) and result.get("ok") is False:
        mark = "✗"
    else:
        mark = "✓"
    return f"[{idx:03d}] {name:18s} {summary}  {mark}"


# ── The loop ────────────────────────────────────────────────────────────────


def run_loop(
    ctx: RunnerContext,
    system_prompt: str,
    user_message: str,
    *,
    model: str = DEFAULT_MODEL,
    max_turns: int = DEFAULT_MAX_TURNS,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    on_tool_call: callable = None,  # optional: receives the cli_line string
) -> RunResult:
    """Run the agent loop. Returns a RunResult with token totals.

    `on_tool_call` is invoked with the one-line summary string after each
    tool dispatch so the CLI can render live progress.
    """
    client = anthropic.Anthropic()

    # Mark the initial user message as cached too. It carries the HLD + intent
    # (often 10-20k tokens) and is identical on every subsequent turn — without
    # cache_control it would be re-charged at full input rate each turn.
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

    tot_in = 0
    tot_out = 0
    tot_cache_read = 0
    tot_cache_create = 0
    call_idx = 0
    turn = 0
    final_stop = "unknown"
    hit_cap = False

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
            tools=TOOL_DEFINITIONS,
            messages=messages,
            extra_headers={"anthropic-beta": CACHE_TTL_BETA_HEADER},
        )

        tot_in += resp.usage.input_tokens
        tot_out += resp.usage.output_tokens
        tot_cache_read += getattr(resp.usage, "cache_read_input_tokens", 0) or 0
        tot_cache_create += getattr(resp.usage, "cache_creation_input_tokens", 0) or 0
        final_stop = resp.stop_reason

        # Append the assistant's turn (text + tool_use blocks) to history.
        messages.append({"role": "assistant", "content": resp.content})

        # If the model stopped without calling a tool, exit. This is
        # unexpected — the agent should always call done() — but we
        # surface it cleanly rather than looping forever.
        if resp.stop_reason != "tool_use":
            break

        # Dispatch every tool_use block from this turn.
        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        result_blocks: List[Dict[str, Any]] = []

        for tu in tool_uses:
            call_idx += 1
            tool_input = dict(tu.input)
            t0 = time.monotonic()
            result = call_tool(ctx, tu.name, tool_input)
            ms = int((time.monotonic() - t0) * 1000)

            _log_tool_call(ctx, call_idx, tu.name, tool_input, result, ms)
            if on_tool_call is not None:
                on_tool_call(_cli_line(call_idx, tu.name, tool_input, result))

            result_blocks.append(
                {
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": json.dumps(result, indent=2),
                }
            )

        messages.append({"role": "user", "content": result_blocks})

        if ctx.done_called:
            break
    else:
        hit_cap = True  # for-loop completed without break → exhausted max_turns

    return RunResult(
        turns_used=turn,
        done_called=ctx.done_called,
        final_stop_reason=final_stop,
        total_input_tokens=tot_in,
        total_output_tokens=tot_out,
        cache_read_tokens=tot_cache_read,
        cache_creation_tokens=tot_cache_create,
        hit_turn_cap=hit_cap,
    )
