#!/usr/bin/env python3
"""
Test: MCP-driven GraphQL validation loop for handler code.

Flow:
  1. learn_shopify_api → get conversationId
  2. search_docs_chunks → get real examples from Shopify docs
  3. Deliberately generate a BROKEN GraphQL mutation (to test detection)
  4. validate_graphql_codeblocks → catch the errors
  5. LLM fixes the mutation using validation feedback
  6. validate_graphql_codeblocks again → confirm it passes

Prints token counts and timing at every step.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

_HERE = Path(__file__).parent
os.chdir(_HERE)
sys.path.insert(0, str(_HERE))

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from shopify_mcp.client import _extract_text
from models.adapter import get_llm, invoke

# ── MCP helpers ───────────────────────────────────────────────────────────────

async def _mcp_session(calls: list[tuple[str, dict]]) -> tuple[str, list[str]]:
    """
    Open one MCP session, call learn_shopify_api first, then run all calls.
    Returns (conversation_id, [result_text_per_call]).
    """
    server_params = StdioServerParameters(
        command="npx",
        args=["--yes", "@shopify/dev-mcp@latest"],
        env={**os.environ, "npm_config_loglevel": "silent"},
    )
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            # Step 1: learn_shopify_api
            learn_result = await asyncio.wait_for(
                session.call_tool("learn_shopify_api", {"api": "admin", "model": "claude-sonnet-4-6"}),
                timeout=60,
            )
            learn_text = _extract_text(learn_result)
            cid = re.search(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                learn_text, re.IGNORECASE,
            )
            conversation_id = cid.group(0) if cid else ""

            results = []
            for tool_name, tool_args in calls:
                enriched = dict(tool_args)
                if conversation_id and "conversationId" not in enriched:
                    enriched["conversationId"] = conversation_id
                r = await asyncio.wait_for(
                    session.call_tool(tool_name, enriched),
                    timeout=60,
                )
                results.append(_extract_text(r))

            return conversation_id, results


def mcp_call(calls: list[tuple[str, dict]]) -> tuple[str, list[str]]:
    return asyncio.run(_mcp_session(calls))


# ── Token counter ─────────────────────────────────────────────────────────────

def tok(text: str) -> int:
    return len(text) // 4


# ── Main test ─────────────────────────────────────────────────────────────────

def sep(title: str) -> None:
    print(f"\n{'━'*70}")
    print(f"  {title}")
    print('━'*70)


def main() -> None:
    total_input_tokens = 0
    total_output_tokens = 0

    # ── Step 1+2: MCP — search docs ──────────────────────────────────────────
    sep("STEP 1+2: learn_shopify_api + search_docs_chunks")
    t0 = time.monotonic()
    cid, [docs_text] = mcp_call([
        ("search_docs_chunks", {"prompt": "add tags to order using GraphQL mutation", "api_name": "admin"}),
    ])
    ms = int((time.monotonic() - t0) * 1000)
    print(f"  conversationId : {cid}")
    print(f"  docs length    : {len(docs_text):,} chars  (~{tok(docs_text):,} tokens)")
    print(f"  time           : {ms}ms")
    print(f"\n  Docs preview:\n  {docs_text[:600].replace(chr(10), chr(10)+'  ')}")

    # ── Step 3: Deliberately generate a BROKEN mutation ───────────────────────
    sep("STEP 3: Deliberately broken GraphQL mutation (to test detection)")

    # This mutation has intentional errors:
    # - wrong mutation name: "orderAddTags" (should be "tagsAdd")
    # - wrong input field: "orderId" (should be "id")
    # - wrong return type: "order { id }" (tagsAdd returns "node { id }")
    broken_mutation = """mutation AddTagsToOrder($orderId: ID!, $tags: [String!]!) {
  orderAddTags(orderId: $orderId, tags: $tags) {
    order {
      id
      tags
    }
    userErrors {
      field
      message
    }
  }
}"""
    print(f"\n  Broken mutation:\n```graphql\n{broken_mutation}\n```")

    # ── Step 4: validate_graphql_codeblocks ───────────────────────────────────
    sep("STEP 4: validate_graphql_codeblocks → catch errors")
    t0 = time.monotonic()
    _, [validation_result] = mcp_call([
        ("validate_graphql_codeblocks", {
            "conversationId": cid,
            "codeblocks": [{"content": broken_mutation}],
        }),
    ])
    ms = int((time.monotonic() - t0) * 1000)
    print(f"  time           : {ms}ms")
    print(f"  validation result ({len(validation_result):,} chars):")
    print(f"\n  {validation_result[:800].replace(chr(10), chr(10)+'  ')}")

    errors_found = len(validation_result) > 10 and "error" in validation_result.lower()
    print(f"\n  ✓ Errors detected: {errors_found}")

    # ── Step 5: LLM fixes the mutation ────────────────────────────────────────
    sep("STEP 5: LLM fixes mutation using validation feedback + docs")

    fix_system = "You are an expert Shopify GraphQL developer. Output ONLY the corrected GraphQL mutation — no explanation, no markdown fences."
    fix_prompt = f"""The following GraphQL mutation has validation errors.

ORIGINAL MUTATION:
```graphql
{broken_mutation}
```

VALIDATION ERRORS:
{validation_result}

RELEVANT SHOPIFY DOCS:
{docs_text[:2000]}

Output the corrected mutation only."""

    total_input_tokens += tok(fix_system) + tok(fix_prompt)
    t0 = time.monotonic()
    llm = get_llm(model="claude-haiku-4-5-20251001", max_tokens=512)
    fix_result = invoke(llm, fix_system, fix_prompt)
    ms = int((time.monotonic() - t0) * 1000)
    fixed_mutation = fix_result.content.strip().strip("`").strip()
    if fixed_mutation.startswith("graphql"):
        fixed_mutation = fixed_mutation[7:].strip()
    total_output_tokens += tok(fixed_mutation)

    print(f"  time           : {ms}ms")
    print(f"  fixed mutation:\n```graphql\n{fixed_mutation}\n```")

    # ── Step 6: validate_graphql_codeblocks again ─────────────────────────────
    sep("STEP 6: validate_graphql_codeblocks → confirm fix passes")
    t0 = time.monotonic()
    _, [validation_result_2] = mcp_call([
        ("validate_graphql_codeblocks", {
            "conversationId": cid,
            "codeblocks": [{"content": fixed_mutation}],
        }),
    ])
    ms = int((time.monotonic() - t0) * 1000)
    print(f"  time           : {ms}ms")
    print(f"  validation result ({len(validation_result_2):,} chars):")
    print(f"\n  {validation_result_2[:600].replace(chr(10), chr(10)+'  ')}")

    passed = "error" not in validation_result_2.lower() or "no error" in validation_result_2.lower() or len(validation_result_2) < 50
    print(f"\n  ✓ Validation passed: {passed}")

    # ── Cost estimate ─────────────────────────────────────────────────────────
    sep("COST ESTIMATE (per handler generation)")
    # MCP calls: 3 sessions × ~30s each = cold start overhead
    # LLM: fix prompt uses haiku
    # Baseline handler already uses sonnet (~3000 input + ~1500 output tokens)
    baseline_input = 3000
    baseline_output = 1500
    mcp_search_tokens = tok(docs_text)
    mcp_validation_tokens = tok(validation_result) + tok(validation_result_2)
    fix_input = tok(fix_system) + tok(fix_prompt)
    fix_output = tok(fixed_mutation)

    # Prices (per 1M tokens, as of 2025)
    sonnet_in  = 3.00 / 1_000_000
    sonnet_out = 15.00 / 1_000_000
    haiku_in   = 0.80 / 1_000_000
    haiku_out  = 4.00 / 1_000_000

    baseline_cost = baseline_input * sonnet_in + baseline_output * sonnet_out
    # The fix call is haiku; the extra context passed to the original handler would be sonnet
    # (docs injected into handler prompt = extra input tokens)
    extra_handler_input = mcp_search_tokens  # docs injected into handler prompt
    extra_sonnet_cost = extra_handler_input * sonnet_in
    fix_cost = fix_input * haiku_in + fix_output * haiku_out

    total_extra = extra_sonnet_cost + fix_cost

    print(f"\n  Baseline handler (sonnet, no MCP):")
    print(f"    input  {baseline_input:>5} tokens  → ${baseline_input * sonnet_in * 1000:.4f} per 1000 runs")
    print(f"    output {baseline_output:>5} tokens  → ${baseline_output * sonnet_out * 1000:.4f} per 1000 runs")
    print(f"    total baseline                     ${baseline_cost * 1000:.4f} per 1000 runs")
    print(f"\n  MCP-enriched handler (additional cost):")
    print(f"    docs injected  ~{mcp_search_tokens:>4} tokens  → ${extra_sonnet_cost * 1000:.4f} per 1000 runs (sonnet input)")
    print(f"    validation text ~{mcp_validation_tokens:>3} tokens")
    print(f"    fix call (haiku) {fix_input:>4}+{fix_output} tokens  → ${fix_cost * 1000:.4f} per 1000 runs")
    print(f"    total extra                        ${total_extra * 1000:.4f} per 1000 runs")
    print(f"\n  Overhead: +{total_extra/baseline_cost*100:.0f}% vs baseline")
    print(f"  Note: MCP NPX spawns add ~10-30s wall time per validation round")


if __name__ == "__main__":
    main()
