#!/usr/bin/env python3
"""
One-shot script: call learn_shopify_api directly, save the full response to
../mcp_learn_response.txt so we can inspect size and content.

_call_mcp discards the learn_shopify_api text (uses it only for conversationId),
so this script reaches into the MCP session directly to capture it.
"""
from __future__ import annotations
import asyncio, os, sys
from pathlib import Path

_HERE = Path(__file__).parent
os.chdir(_HERE)
sys.path.insert(0, str(_HERE))

from shopify_mcp.client import _extract_text
from mcp import ClientSession
from mcp.client.stdio import stdio_client, StdioServerParameters

async def fetch() -> str:
    server_params = StdioServerParameters(
        command="npx",
        args=["--yes", "@shopify/dev-mcp@latest"],
        env={**os.environ, "npm_config_loglevel": "silent"},
    )
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await asyncio.wait_for(
                session.call_tool("learn_shopify_api", {"api": "admin", "model": "claude-sonnet-4-6"}),
                timeout=60,
            )
            return _extract_text(result)

print("Calling learn_shopify_api (direct session)...")
text = asyncio.run(fetch())

if not text:
    print("ERROR: got empty response")
    sys.exit(1)

out = _HERE.parent / "mcp_learn_response.txt"
out.write_text(text, encoding="utf-8")

tokens_est = len(text) // 4
print(f"Saved to {out}")
print(f"Length : {len(text):,} chars  (~{tokens_est:,} tokens estimated)")
print(f"\nFirst 500 chars:\n{'-'*60}\n{text[:500]}\n{'-'*60}")
