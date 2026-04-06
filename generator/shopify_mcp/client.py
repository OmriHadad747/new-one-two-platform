"""
Shopify Dev MCP client — live API context with disk caching.

Wraps the official @shopify/dev-mcp Node.js server (spawned via npx) using
the MCP Python SDK. All public functions are synchronous; async internals are
isolated here and never leak to callers.

Public API
----------
  prefetch_for_run(resources, intent_description) -> str
      Main entry point. Call once per pipeline run before the Architect agent.
      Warms the webhook-topics cache and the per-resource REST/doc cache in a
      single MCP session. Returns the combined API context string.

  refetch_for_operations(operations) -> str
      Called after the Architect locks its specific API operations and before
      the CodeSpec agent starts. Fetches precise GraphQL schemas and REST docs
      for each operation. Results are written to cache (keyed by operation set)
      but the cache is never read — ensures fresh data per run while avoiding
      duplicate MCP traffic on retries within the same pipeline run.

  get_webhook_topics() -> list[str]
      Returns the cached webhook topic list (REST format, e.g. "orders/create").
      Populated by prefetch_for_run. Falls back to [] on cache miss so callers
      can apply their own hardcoded fallback.

  search_docs(query) -> str
      Free-text doc search for edge cases not covered by prefetch. Not cached.

Caching
-------
  Results are stored under generator/shopify_mcp/cache/ as JSON files:
    webhook_topics.json              — full topic list, 24 h TTL
    resources_<sha256>.json          — per resource-set context, 24 h TTL
    operations_<sha256>.json         — per operation-set precise schemas, 24 h TTL

  Cache reads: prefetch_for_run and get_webhook_topics read from cache.
  Cache writes: all three fetch functions write results to cache.
  refetch_for_operations always executes MCP calls (never reads cache) but
  writes its result so repeated identical operation sets in future runs are free.

  Thread-safe: each disk write is an atomic rename-replace (write temp → rename).

Graceful degradation
--------------------
  Every public function catches all exceptions and returns an empty
  value. Callers are responsible for falling back to static content.
  A warning is logged with enough detail to diagnose the problem.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import json
import logging
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# ── MCP SDK import (optional dependency) ──────────────────────────────────────

try:
    from mcp import ClientSession
    from mcp.client.stdio import stdio_client, StdioServerParameters
    _MCP_AVAILABLE = True
except ImportError:
    _MCP_AVAILABLE = False
    log.debug("mcp package not installed — Shopify Dev MCP integration disabled")

# ── Constants ─────────────────────────────────────────────────────────────────

_CACHE_DIR = Path(__file__).parent / "cache"
_CACHE_TTL_SECONDS = 24 * 60 * 60  # 24 hours

# ── Cache helpers ─────────────────────────────────────────────────────────────


def _cache_key_path(key: str) -> Path:
    digest = hashlib.sha256(key.encode()).hexdigest()[:16]
    safe = re.sub(r"[^a-z0-9_]", "_", key.lower())[:40]
    return _CACHE_DIR / f"{safe}_{digest}.json"


def _read_cache(key: str) -> Any | None:
    path = _cache_key_path(key)
    try:
        if not path.exists():
            return None
        entry = json.loads(path.read_text(encoding="utf-8"))
        if time.time() - entry["fetched_at"] < entry["ttl_seconds"]:
            return entry["data"]
    except Exception:
        pass  # treat corrupt/missing cache as miss
    return None


def _write_cache(key: str, data: Any, ttl: int = _CACHE_TTL_SECONDS) -> None:
    """Atomic write: write to a temp file then rename to prevent partial reads."""
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target = _cache_key_path(key)
    payload = json.dumps({"fetched_at": time.time(), "ttl_seconds": ttl, "data": data},
                         indent=2, ensure_ascii=False)
    fd, tmp = tempfile.mkstemp(dir=_CACHE_DIR, suffix=".json.tmp")
    try:
        os.write(fd, payload.encode("utf-8"))
        os.close(fd)
        os.replace(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ── Async MCP session ─────────────────────────────────────────────────────────


_TOOL_TIMEOUT_SECONDS = 30   # per-tool call timeout
_SESSION_TIMEOUT_SECONDS = 120  # total MCP session timeout (all calls combined)


async def _run_session_async(calls: list[tuple[str, dict[str, Any]]]) -> list[Any]:
    """
    Spawn the MCP server exactly once and execute all tool calls in order.

    Always calls learn_shopify_api first to obtain a conversationId, then
    injects it into every subsequent call that requires it.

    Returns results in the same order as the input calls list (learn_shopify_api
    result is NOT included in the returned list).

    Each individual tool call is guarded by _TOOL_TIMEOUT_SECONDS. The entire
    session is also bounded by _SESSION_TIMEOUT_SECONDS so a hung MCP server
    process can never block the pipeline indefinitely.
    """
    server_params = StdioServerParameters(
        command="npx",
        args=["--yes", "@shopify/dev-mcp@latest"],
        env={**os.environ, "npm_config_loglevel": "silent"},
    )

    async def _run() -> list[Any]:
        results: list[Any] = []
        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()

                # Step 1: obtain conversationId
                conversation_id: str | None = None
                try:
                    learn_result = await asyncio.wait_for(
                        session.call_tool("learn_shopify_api", {"api": "admin", "model": "claude-sonnet-4-6"}),
                        timeout=_TOOL_TIMEOUT_SECONDS,
                    )
                    learn_text = _extract_text(learn_result)
                    cid_match = re.search(
                        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                        learn_text, re.IGNORECASE,
                    )
                    if cid_match:
                        conversation_id = cid_match.group(0)
                        log.debug("MCP conversationId: %s", conversation_id)
                    else:
                        log.warning("MCP: could not extract conversationId from learn_shopify_api response")
                except asyncio.TimeoutError:
                    log.warning("MCP learn_shopify_api timed out after %ds", _TOOL_TIMEOUT_SECONDS)
                except Exception as exc:
                    log.warning("MCP learn_shopify_api failed: %s", exc)

                # Step 2: run the actual calls, injecting conversationId where needed
                for tool_name, tool_args in calls:
                    enriched = dict(tool_args)
                    if conversation_id and "conversationId" not in enriched:
                        enriched["conversationId"] = conversation_id
                    try:
                        result = await asyncio.wait_for(
                            session.call_tool(tool_name, enriched),
                            timeout=_TOOL_TIMEOUT_SECONDS,
                        )
                        results.append(result)
                    except asyncio.TimeoutError:
                        log.warning("MCP tool %r timed out after %ds — skipping", tool_name, _TOOL_TIMEOUT_SECONDS)
                        results.append(None)
                    except Exception as exc:
                        log.warning("MCP tool %r failed: %s", tool_name, exc)
                        results.append(None)
        return results

    return await asyncio.wait_for(_run(), timeout=_SESSION_TIMEOUT_SECONDS)


def _run_async(coro: Any) -> Any:
    """
    Execute a coroutine synchronously, safe in both sync and already-running
    async contexts (e.g. FastAPI lifespan or pytest-asyncio).
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None and loop.is_running():
        # We are inside an event loop — run the coroutine in a fresh thread
        # with its own event loop so we don't deadlock.
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(asyncio.run, coro).result()
    else:
        return asyncio.run(coro)


def _call_mcp(calls: list[tuple[str, dict[str, Any]]]) -> list[Any]:
    """Synchronous wrapper. Returns [] on any infrastructure failure."""
    if not _MCP_AVAILABLE:
        log.debug("mcp package unavailable — skipping MCP calls")
        return []
    if not calls:
        return []
    try:
        return _run_async(_run_session_async(calls))
    except Exception as exc:
        log.warning("MCP session failed (%s). Falling back to static context.", exc)
        return []


# ── Result extraction ─────────────────────────────────────────────────────────


def _extract_text(result: Any) -> str:
    """Pull plain text out of an MCP CallToolResult (or None)."""
    if result is None:
        return ""
    # Standard MCP SDK shape: result.content is a list of content items
    if hasattr(result, "content"):
        parts = []
        for item in result.content:
            if hasattr(item, "text") and item.text:
                parts.append(item.text)
        return "\n".join(parts)
    if isinstance(result, str):
        return result
    return ""


# ── Webhook topic parsing ─────────────────────────────────────────────────────


def _enum_to_rest_topic(value: str) -> str:
    """
    Convert a WebhookSubscriptionTopic GraphQL enum value to REST format.

    Pattern: everything up to the last underscore = resource (using underscores),
             last segment = event type.
    Examples:
      ORDERS_CREATE            → orders/create
      INVENTORY_LEVELS_UPDATE  → inventory_levels/update
      APP_UNINSTALLED          → app/uninstalled
    """
    parts = value.strip().lower().split("_")
    if len(parts) < 2:
        return value.lower()
    event = parts[-1]
    resource = "_".join(parts[:-1])
    return f"{resource}/{event}"


def _parse_topics_from_text(text: str) -> list[str]:
    """
    Extract REST-format webhook topics from MCP introspection output.
    Handles both SCREAMING_SNAKE_CASE enum values and already-converted REST strings.
    """
    topics: list[str] = []
    seen: set[str] = set()

    for raw_line in text.splitlines():
        line = raw_line.strip().strip(",").strip('"').strip("'")
        if not line or line.startswith("#") or line.startswith("//"):
            continue

        # GraphQL enum value: all caps, underscores, no spaces, reasonable length
        if re.fullmatch(r"[A-Z][A-Z0-9_]{3,60}", line):
            topic = _enum_to_rest_topic(line)
        # REST-format topic: lowercase, one slash, underscores allowed
        elif re.fullmatch(r"[a-z][a-z0-9_]*/[a-z][a-z0-9_]*", line):
            topic = line
        else:
            continue

        if topic not in seen:
            seen.add(topic)
            topics.append(topic)

    return topics


# ── Public API ────────────────────────────────────────────────────────────────


def prefetch_for_run(resources: list[str], intent_description: str = "") -> str:
    """
    Warm all caches relevant to this pipeline run in a single MCP session.

    Fetches (if not already cached):
      1. The complete WebhookSubscriptionTopic enum → writes webhook_topics cache
      2. REST docs + GraphQL schema for each resource → writes resource-context cache

    Returns the combined API context string for injection into agent prompts.
    Never raises — all failures produce warnings and empty fallback values.

    Parameters
    ----------
    resources:
        Resource names from Intent output (e.g. ["orders", "inventory"]).
    intent_description:
        Optional one-liner describing the feature (improves doc-search relevance).
    """
    resource_key = "resources_" + "_".join(sorted(r.lower() for r in resources))

    topics_cached = _read_cache("webhook_topics")
    context_cached = _read_cache(resource_key)

    if topics_cached is not None and context_cached is not None:
        log.debug("MCP cache hit for topics + resources=%s", resources)
        return context_cached

    if not _MCP_AVAILABLE:
        return ""

    # Build the minimal set of MCP calls needed
    calls: list[tuple[str, dict[str, Any]]] = []
    need_topics = topics_cached is None
    need_context = context_cached is None

    if need_topics:
        calls.append(("introspect_graphql_schema", {
            "api": "admin",
            "query": "WebhookSubscriptionTopic",
        }))

    if need_context and resources:
        # One search-docs call per resource (REST docs + webhook payloads)
        for resource in resources:
            prompt = (
                f"Shopify {resource} REST API endpoints fields webhook payload"
                + (f" for: {intent_description}" if intent_description else "")
            )
            calls.append(("search_docs_chunks", {"prompt": prompt, "api_name": "admin"}))


    if not calls:
        return context_cached or ""

    results = _call_mcp(calls)

    # ── Parse topics ──────────────────────────────────────────────────────────
    idx = 0
    if need_topics:
        topics_text = _extract_text(results[idx]) if idx < len(results) else ""
        if topics_text:
            topics = _parse_topics_from_text(topics_text)
            if topics:
                try:
                    _write_cache("webhook_topics", topics)
                    log.info("MCP: cached %d webhook topics", len(topics))
                except Exception as exc:
                    log.warning("Failed to write webhook_topics cache: %s", exc)
        idx += 1

    # ── Parse resource context ─────────────────────────────────────────────────
    api_context = context_cached or ""
    if need_context and resources:
        sections: list[str] = []

        # REST doc chunks (one per resource)
        for resource in resources:
            text = _extract_text(results[idx]) if idx < len(results) else ""
            if text.strip():
                sections.append(f"── {resource.upper()} — REST / docs ──\n{text.strip()}")
            idx += 1

        if sections:
            api_context = "\n\n".join(sections)
            try:
                _write_cache(resource_key, api_context)
                log.info("MCP: cached API context for resources=%s", resources)
            except Exception as exc:
                log.warning("Failed to write resource context cache: %s", exc)

    return api_context


def get_webhook_topics() -> list[str]:
    """
    Return the cached list of valid webhook topics in REST format.
    Returns [] on cache miss — callers must apply their own hardcoded fallback.
    """
    cached = _read_cache("webhook_topics")
    return list(cached) if cached else []


def search_docs(query: str) -> str:
    """
    One-shot documentation search. Useful for edge cases not covered by
    prefetch_for_run (e.g. obscure resources, Shopify Functions, B2B APIs).
    Results are NOT cached since queries are dynamic.
    """
    results = _call_mcp([("search_docs_chunks", {"prompt": query, "api_name": "admin"})])
    return _extract_text(results[0]) if results else ""


def refetch_for_operations(operations: list[dict]) -> str:
    """
    Fetch precise MCP documentation for the specific operations the Architect locked.

    Called after the Architect agent completes and before the CodeSpec agent starts.
    Queries MCP for:
      - GraphQL: introspect_graphql_schema for each unique root operation name
        extracted from operationHint (e.g. "stagedUploadsCreate(input: ...)" → "stagedUploadsCreate")
      - REST: search_docs_chunks for each unique resource derived from the path
        (e.g. /admin/api/.../products/images.json → "products images")

    Always executes MCP calls (never reads cache) to ensure the CodeSpec agent
    always gets the latest schemas for this run. Results are written to cache
    so identical operation sets in future pipeline runs avoid redundant MCP traffic.

    Returns context string to append to the upfront api_context.
    Returns "" on any failure or when MCP is unavailable.
    """
    if not operations or not _MCP_AVAILABLE:
        return ""

    calls: list[tuple[str, dict[str, Any]]] = []
    labels: list[str] = []
    seen_graphql: set[str] = set()
    seen_rest: set[str] = set()

    for op in operations:
        protocol = op.get("protocol", "")

        if protocol == "graphql":
            hint = (op.get("operationHint") or "").strip()
            # Extract root name: "stagedUploadsCreate(input: ...)" → "stagedUploadsCreate"
            m = re.match(r"(\w+)", hint)
            if m:
                name = m.group(1)
                if name and name not in seen_graphql:
                    seen_graphql.add(name)
                    calls.append(("introspect_graphql_schema", {"api": "admin", "query": name}))
                    labels.append(f"GraphQL:{name}")

        elif protocol == "rest":
            path = (op.get("path") or "").strip()
            if path and path not in seen_rest:
                seen_rest.add(path)
                # Derive a human-readable resource label from the REST path.
                # Skip: version segments (2026-01), numeric IDs, template vars (${...}),
                # .json suffix parts, and generic path components (admin, api).
                parts = [
                    p for p in path.split("/")
                    if p
                    and not p.startswith("${")
                    and p not in ("admin", "api")
                    and not re.fullmatch(r"\d{4}-\d{2}", p)  # version segment
                    and "." not in p  # skip segments containing ".json"
                    and not p[0].isdigit()  # skip numeric IDs
                ]
                resource_hint = " ".join(parts[-2:]) if len(parts) >= 2 else " ".join(parts)
                if resource_hint:
                    calls.append(("search_docs_chunks", {
                        "prompt": f"Shopify {resource_hint} REST API endpoint fields parameters responses",
                        "api_name": "admin",
                    }))
                    labels.append(f"REST:{resource_hint}")

    if not calls:
        return ""

    results = _call_mcp(calls)

    sections: list[str] = []
    for label, result in zip(labels, results):
        text = _extract_text(result)
        if text.strip():
            sections.append(f"── {label} — precise schema ──\n{text.strip()}")

    context = "\n\n".join(sections)

    if context:
        # Build a stable cache key from the sorted set of operation identifiers
        op_key = "operations_" + "_".join(sorted(
            f"{op.get('protocol','')}-{op.get('operationHint') or op.get('path','')}"
            for op in operations
        ))
        try:
            _write_cache(op_key, context)
            log.debug("MCP: cached operation schemas for %d operations", len(operations))
        except Exception as exc:
            log.warning("Failed to write operations cache: %s", exc)

    return context
