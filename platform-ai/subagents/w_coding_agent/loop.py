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
    DEFAULT_TOOL_RESULT_BYTES,
    TOOL_DEFINITIONS,
    RunnerContext,
    call_tool,
)

# ── Defaults ────────────────────────────────────────────────────────────────

DEFAULT_MODEL = "claude-sonnet-4-6"
DEFAULT_MAX_TURNS = 140
# Per-turn output cap. Sized so a single write_file of a typical UI/route
# file (admin.ts is often 600+ lines ≈ 6-8K tokens of content plus tool-
# use JSON overhead) fits with headroom and ~1.5× safety margin. The
# previous 6000 truncated admin.ts mid-write and killed the run — the
# loop's "stop_reason != 'tool_use'" exit treats max_tokens as a halt.
# "Force focused turns" is now handled by the OUTPUT DISCIPLINE section
# of the system prompt, not by squeezing the output cap below what
# legitimate work needs. Generic — applies to any loop whose tool args
# can carry a file body. Stays well under the SDK's ~21K streaming
# threshold so no streaming switch is needed here (unlike HLD).
DEFAULT_MAX_TOKENS = 12000
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


def _attempt_dir(ctx: RunnerContext) -> Path:
    """Per-attempt artifacts (tool_calls/, manifest.jsonl, turns/, the
    prompts) live under `inputs/coding/attempt_1/` so the coding agent's
    layout mirrors product/hld/hld_v. Run-level aggregates
    (token_usage.json, final_tsc.json, forced_completion.json) stay at
    run_dir."""
    d = ctx.run_dir / "inputs" / "coding" / "attempt_1"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _tool_calls_dir(ctx: RunnerContext) -> Path:
    d = _attempt_dir(ctx) / "tool_calls"
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
    # and post-hoc inspection. Lives alongside tool_calls/ under the
    # attempt dir.
    ok = result.get("ok") if isinstance(result, dict) else None
    has_error = isinstance(result, dict) and "error" in result
    manifest_line = {
        "idx": idx,
        "tool": name,
        "ms": ms_elapsed,
        "ok": (not has_error) if ok is None else ok,
    }
    with (_attempt_dir(ctx) / "manifest.jsonl").open("a") as f:
        f.write(json.dumps(manifest_line) + "\n")


def _cli_line(
    idx: int, name: str, tool_input: Dict[str, Any], result: Dict[str, Any]
) -> str:
    """One-line CLI summary: '[003] write_file   scaffold/app.json ✓'"""
    summary = ""
    if name in ("read_file", "write_file"):
        summary = tool_input.get("path", "")
    elif name == "edit_file":
        path = tool_input.get("path", "")
        repls = result.get("replacements") if isinstance(result, dict) else None
        summary = f"{path} ({repls} repl)" if repls else path
    elif name in ("get_shopify_op", "get_webhook_topic"):
        summary = tool_input.get("name", "")
    elif name == "list_shopify_ops":
        cluster = tool_input.get("cluster", "")
        surface = tool_input.get("surface", "")
        summary = f"{cluster} ({surface})" if surface else cluster
    elif name == "list_webhook_family":
        summary = tool_input.get("prefix", "")
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


def _truncate_tool_result_json(payload: str, *, cap_bytes: int) -> str:
    """Hard cap on a single tool_result content blob. Saves ~3-15K
    fresh-input tokens per oversized result (run_tsc with hundreds of
    errors, read_file of a large file). The agent can re-read with
    offset/limit if it needs more. Generic — applies to any tool result."""
    if len(payload) <= cap_bytes:
        return payload
    # Keep the head — JSON keys at the front are usually the most
    # informative ("ok": false, "errors": [...]). Append a marker the
    # model can recognise.
    head = payload[: cap_bytes - 200]
    tail = (
        f'\n  ... [TRUNCATED — original was {len(payload)} bytes; '
        f"showing first {cap_bytes - 200}. Re-fetch with offset/limit if "
        f"you need more.]"
    )
    return head + tail


def _dump_turn(
    ctx: RunnerContext,
    *,
    turn: int,
    response: Any,
) -> None:
    """After every model turn, dump a small JSON blob with the turn's
    stop_reason, the assistant's text content (if any), and the names of
    tool_use blocks it emitted. This closes the visibility gap for
    coding failures: when the loop exits with stop_reason != "tool_use"
    you can read exactly what the model said on its final turn instead
    of guessing. Cheap (one tiny file per turn) and generic — applies
    to any tool-using loop."""
    turns_dir = _attempt_dir(ctx) / "turns"
    turns_dir.mkdir(parents=True, exist_ok=True)
    text_parts: list = []
    tool_names: list = []
    for block in response.content:
        btype = getattr(block, "type", None)
        if btype == "text":
            text_parts.append(getattr(block, "text", "") or "")
        elif btype == "tool_use":
            tool_names.append(getattr(block, "name", "?"))
    payload = {
        "turn": turn,
        "stop_reason": response.stop_reason,
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "cache_read_tokens": getattr(response.usage, "cache_read_input_tokens", 0) or 0,
        "cache_creation_tokens": getattr(response.usage, "cache_creation_input_tokens", 0) or 0,
        "tool_uses": tool_names,
        "assistant_text": "\n".join(text_parts).strip(),
    }
    (turns_dir / f"turn_{turn:03d}.json").write_text(json.dumps(payload, indent=2))


def _flush_progress(
    ctx: RunnerContext,
    *,
    turn: int,
    tot_in: int,
    tot_out: int,
    tot_cache_read: int,
    tot_cache_create: int,
) -> None:
    """Write the running coding+validator token totals to disk after each
    turn. This is the ONLY source of truth for halted/killed runs — the
    end-of-run `_persist_token_usage` doesn't fire if the loop exits
    abnormally. Cheap (one small JSON write per turn) and generic."""
    payload = {
        "coding_agent": {
            "input_tokens": tot_in,
            "output_tokens": tot_out,
            "cache_read_tokens": tot_cache_read,
            "cache_creation_tokens": tot_cache_create,
            "turns_used": turn,
        },
        "validators": dict(ctx.validator_usage),
    }
    (ctx.run_dir / "token_usage.json").write_text(json.dumps(payload, indent=2))


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
    # The most-recent user message in `messages` that carries a
    # cache_control marker. Each turn we rotate the marker forward onto
    # the newest tool_result message so the growing conversation history
    # stays in cache_read territory (~$0.30/M) instead of paying full
    # input on every turn (~$3/M). The system prompt + user_msg_0 keep
    # their own markers; this is the THIRD breakpoint (within Anthropic's
    # 4-marker-per-request limit). Generic — applies to any agent loop
    # with a growing conversation.
    prev_user_msg_idx_with_cache: int | None = None

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

        # Per-turn dump for post-hoc debug: stop_reason, assistant text,
        # tool_use names, usage. Without this, a loop exit on
        # stop_reason="end_turn" is a black box.
        _dump_turn(ctx, turn=turn, response=resp)

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

            content = _truncate_tool_result_json(
                json.dumps(result, indent=2),
                cap_bytes=DEFAULT_TOOL_RESULT_BYTES,
            )
            block = {
                "type": "tool_result",
                "tool_use_id": tu.id,
                "content": content,
            }
            result_blocks.append(block)

        # Rotate the conversation-history cache breakpoint onto the last
        # block of the user message we're about to send. This keeps the
        # full prior conversation (~50-200K tokens by mid-run) in cheap
        # cache_read territory on the NEXT turn instead of charging full
        # input ($3/M → $0.30/M). Remove the previous user-message
        # marker first so we stay under Anthropic's 4-per-request limit.
        if prev_user_msg_idx_with_cache is not None:
            for block_ in messages[prev_user_msg_idx_with_cache]["content"]:
                if isinstance(block_, dict):
                    block_.pop("cache_control", None)
        if result_blocks:
            result_blocks[-1]["cache_control"] = {
                "type": "ephemeral",
                "ttl": "1h",
            }
        messages.append({"role": "user", "content": result_blocks})
        prev_user_msg_idx_with_cache = len(messages) - 1

        # Flush running token totals after EVERY turn so halted/killed runs
        # still leave a usable cost record on disk. Generic — applies to any
        # agent loop that may exit abnormally.
        _flush_progress(
            ctx,
            turn=turn,
            tot_in=tot_in,
            tot_out=tot_out,
            tot_cache_read=tot_cache_read,
            tot_cache_create=tot_cache_create,
        )

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
