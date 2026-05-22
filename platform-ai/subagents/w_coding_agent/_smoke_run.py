"""
Smoke test for the coding agent — drives one real end-to-end run against
the Anthropic API.

Loads `prompt`, `intent`, and `plan` from a prior pipeline run's
`state.json`, then invokes `run_coding_agent` with a fresh run directory
so we don't clobber existing test results.

Cost: one full agent run (~$1 typical at current input rates).

Run from anywhere:
  python platform-ai/subagents/w_coding_agent/_smoke_run.py [path/to/state.json]
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve()
PLATFORM_AI = HERE.parents[2]
REPO_ROOT = PLATFORM_AI.parent

sys.path.insert(0, str(PLATFORM_AI))

# Load platform-ai/.env so ANTHROPIC_API_KEY is available even when the
# shell hasn't sourced it.
try:
    from dotenv import load_dotenv  # type: ignore

    load_dotenv(PLATFORM_AI / ".env")
except ImportError:
    pass

from subagents.w_coding_agent.agent import run_coding_agent  # noqa: E402


DEFAULT_STATE = (
    PLATFORM_AI
    / "cli"
    / "test_results"
    / "2026-05-13T23-04-26_merchants-create-fixed-and-flexible-product"
    / "state.json"
)


def main() -> int:
    if "ANTHROPIC_API_KEY" not in os.environ:
        print("❌ ANTHROPIC_API_KEY not set — aborting before any API call.")
        return 1

    state_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_STATE
    if not state_path.exists():
        print(f"❌ state.json not found at {state_path}")
        return 1

    state = json.loads(state_path.read_text())

    missing = [k for k in ("prompt", "intent", "plan") if k not in state]
    if missing:
        print(f"❌ state.json missing keys: {missing}")
        return 1

    # Fresh run dir so we don't clobber the existing one.
    ts = time.strftime("%Y-%m-%dT%H-%M-%S")
    smoke_dir = (
        PLATFORM_AI / "cli" / "test_results" / f"{ts}_smoke_w_coding_agent"
    )
    smoke_dir.mkdir(parents=True, exist_ok=False)

    print(f"Input state: {state_path.relative_to(REPO_ROOT)}")
    print(f"Run dir:     {smoke_dir.relative_to(REPO_ROOT)}")
    print(f"Prompt:      {state['prompt'][:80]!r}...")
    print()
    print("─── Live tool calls ───")

    t0 = time.monotonic()
    result = run_coding_agent(
        merchant_prompt=state["prompt"],
        intent=state["intent"],
        plan=state["plan"],
        run_dir=smoke_dir,
        on_tool_call=lambda line: print(line),
    )
    elapsed = time.monotonic() - t0

    rr = result.run_result
    print()
    print("─── Result ───")
    print(f"  turns_used:           {rr.turns_used}")
    print(f"  done_called:          {rr.done_called}")
    print(f"  hit_turn_cap:         {rr.hit_turn_cap}")
    print(f"  final_stop_reason:    {rr.final_stop_reason}")
    print(f"  todos at exit:        {len(result.todos)}")
    print()
    print("─── Tokens ───")
    print(f"  input_tokens:         {rr.total_input_tokens:>10,}")
    print(f"  output_tokens:        {rr.total_output_tokens:>10,}")
    print(f"  cache_read_tokens:    {rr.cache_read_tokens:>10,}")
    print(f"  cache_creation_tokens:{rr.cache_creation_tokens:>10,}")
    print(f"  elapsed:              {elapsed:.1f}s")
    print()
    print(f"Logs:    {(smoke_dir / 'tool_calls').relative_to(REPO_ROOT)}")
    print(f"Output:  {smoke_dir.relative_to(REPO_ROOT)}")

    return 0 if rr.done_called else 2


if __name__ == "__main__":
    raise SystemExit(main())
