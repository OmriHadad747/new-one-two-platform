"""
Shopify Dev MCP client — live API context with disk caching.

Wraps the official @shopify/dev-mcp Node.js server (spawned via npx) using
the MCP Python SDK. All public functions are synchronous; async internals are
isolated here and never leak to callers.

Public API
----------
  prefetch_for_run(resources, intent_description) -> str
      Main entry point. Call once per pipeline run before the Architect agent.
      Searches Shopify docs for the feature intent; returns api_context string.
      Side-effect: warms the webhook-topics cache. Both calls are batched into
      one NPX session when topics cache is cold; one call when hot.

  get_webhook_topics() -> list[str]
      Returns the cached webhook topic list (REST format, e.g. "orders/create").
      Populated by prefetch_for_run. Falls back to [] on cache miss so callers
      can apply their own hardcoded fallback.

  validate_handler_graphql(handler_js) -> list[str]
      Extract GraphQL operations from handler.js and validate them against the
      live Shopify schema via validate_graphql_codeblocks. Returns a list of
      error strings (empty = all valid or MCP unavailable).

  search_docs(query) -> str
      Free-text doc search for specific edge cases. Not cached.

Caching
-------
  Results are stored under generator/shopify_mcp/cache/ as JSON files:
    webhook_topics.json              — full topic list, 24 h TTL

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
    payload = json.dumps(
        {"fetched_at": time.time(), "ttl_seconds": ttl, "data": data},
        indent=2,
        ensure_ascii=False,
    )
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


_TOOL_TIMEOUT_SECONDS = 30  # per-tool call timeout
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
        async with stdio_client(server_params, errlog=open(os.devnull, "w")) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()

                # Step 1: obtain conversationId
                conversation_id: str | None = None
                try:
                    learn_result = await asyncio.wait_for(
                        session.call_tool(
                            "learn_shopify_api",
                            {"api": "admin", "model": "claude-sonnet-4-6"},
                        ),
                        timeout=_TOOL_TIMEOUT_SECONDS,
                    )
                    learn_text = _extract_text(learn_result)
                    cid_match = re.search(
                        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                        learn_text,
                        re.IGNORECASE,
                    )
                    if cid_match:
                        conversation_id = cid_match.group(0)
                        log.debug("MCP conversationId: %s", conversation_id)
                    else:
                        log.warning(
                            "MCP: could not extract conversationId from learn_shopify_api response"
                        )
                except asyncio.TimeoutError:
                    log.warning(
                        "MCP learn_shopify_api timed out after %ds",
                        _TOOL_TIMEOUT_SECONDS,
                    )
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
                        log.warning(
                            "MCP tool %r timed out after %ds — skipping",
                            tool_name,
                            _TOOL_TIMEOUT_SECONDS,
                        )
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

    Only scans for SCREAMING_SNAKE_CASE tokens (WebhookSubscriptionTopic enum values).
    REST-format word/word patterns are intentionally NOT extracted — they appear
    in documentation prose and URL paths and produce false positives.
    Returns [] when the response contains no enum values (callers will not cache).
    """
    log.debug(
        "MCP _parse_topics_from_text: received %d chars, preview: %.300s",
        len(text),
        text,
    )

    topics: list[str] = []
    seen: set[str] = set()

    for value in re.findall(r"\b([A-Z][A-Z0-9_]{3,60})\b", text):
        if "_" not in value:
            continue  # skip single-word caps tokens (NULL, TRUE, NOT, etc.)
        topic = _enum_to_rest_topic(value)
        if topic not in seen:
            seen.add(topic)
            topics.append(topic)

    if not topics:
        log.warning(
            "MCP _parse_topics_from_text: 0 enum values found in %d-char response — "
            "introspect_graphql_schema may have returned documentation prose instead of schema. "
            "Cache will NOT be written. Raw preview: %.500s",
            len(text),
            text,
        )
    else:
        log.info("MCP _parse_topics_from_text: extracted %d topics", len(topics))

    return topics


# ── Public API ────────────────────────────────────────────────────────────────


def prefetch_for_run(resources: list[str], intent_description: str = "") -> str:
    """
    Fetch Shopify docs for this pipeline run and return them as api_context.

    Batches two calls into one NPX session:
      1. introspect_graphql_schema — warms the webhook topics cache (skipped when hot).
      2. search_docs_chunks — searches docs using the feature intent as the query.
         Uses intent_description (desiredOutcome) not resource names: intent language
         matches how Shopify docs are written and yields high-precision results.

    Returns the docs text as api_context for injection into the handler prompt.
    Returns "" when intent_description is empty or MCP is unavailable.
    Never raises — all failures produce warnings and return "".

    Parameters
    ----------
    resources:
        Resource names from Intent output. Not used in the search query — kept for
        call-site compatibility.
    intent_description:
        The desiredOutcome from the product agent, used directly as the search query.
        e.g. "add tags to high-value orders when they are created"
    """
    if not _MCP_AVAILABLE:
        return ""

    calls: list[tuple[str, dict[str, Any]]] = []
    topics_cached = _read_cache("webhook_topics")
    needs_topics = topics_cached is None

    if needs_topics:
        calls.append(
            ("introspect_graphql_schema", {"api": "admin", "query": "WebhookSubscriptionTopic"})
        )

    if intent_description:
        calls.append(
            ("search_docs_chunks", {"prompt": intent_description, "api_name": "admin"})
        )

    if not calls:
        log.debug("MCP prefetch: nothing to fetch (topics cached, no intent)")
        return ""

    results = _call_mcp(calls)

    # Consume results positionally — order matches the calls list above
    idx = 0
    if needs_topics:
        topics_text = _extract_text(results[idx]) if results and len(results) > idx else ""
        # Always cache — even when MCP returns empty or parsing yields 0 topics.
        # Not caching would cause a repeated MCP call on every run.
        # get_webhook_topics() returning [] causes static validation to skip topic checking.
        topics = _parse_topics_from_text(topics_text) if topics_text else []
        try:
            _write_cache("webhook_topics", topics)
            log.info("MCP: cached %d webhook topics", len(topics))
        except Exception as exc:
            log.warning("Failed to write webhook_topics cache: %s", exc)
        idx += 1

    if intent_description:
        docs_result = results[idx] if results and len(results) > idx else None
        docs_text = _extract_text(docs_result) if docs_result else ""
        if docs_text:
            log.info("MCP api_context: %d chars for intent %.80s", len(docs_text), intent_description)
        return docs_text

    return ""


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
    results = _call_mcp(
        [("search_docs_chunks", {"prompt": query, "api_name": "admin"})]
    )
    return _extract_text(results[0]) if results else ""


# Match template literals whose trimmed content starts with a GraphQL keyword.
# Uses a non-greedy match; stops at the next backtick not preceded by a backslash.
_GQL_TEMPLATE_RE = re.compile(
    r"`\s*((?:mutation|query|fragment|subscription)[\s({][\s\S]*?)`",
    re.IGNORECASE,
)


def validate_handler_graphql(handler_js: str) -> list[str]:
    """
    Extract GraphQL operations from handler.js and validate them against the
    live Shopify Admin schema via validate_graphql_codeblocks.

    Used by HandlerGenerator.validate() to catch hallucinated mutation/query names
    before the retry loop runs. Errors are returned in the same format as static
    validation errors so they slot into previous_errors cleanly.

    Returns [] when:
    - No GraphQL operations found in the handler
    - MCP is unavailable (graceful degradation — never blocks generation)
    - validate_graphql_codeblocks reports all operations valid

    Returns a list of error strings when Shopify's schema rejects any operation.
    """
    if not _MCP_AVAILABLE:
        return []

    operations = _GQL_TEMPLATE_RE.findall(handler_js)
    if not operations:
        return []

    codeblocks = [{"content": op.strip()} for op in operations if op.strip()]
    if not codeblocks:
        return []

    results = _call_mcp(
        [("validate_graphql_codeblocks", {"codeblocks": codeblocks})]
    )
    if not results:
        return []

    validation_text = _extract_text(results[0])
    if not validation_text or "error" not in validation_text.lower():
        return []

    # Parse error details out of the validation response.
    # The MCP tool returns a markdown summary — extract the Details lines.
    errors: list[str] = []
    for line in validation_text.splitlines():
        line = line.strip()
        if line.startswith("**Details:**"):
            detail = line.removeprefix("**Details:**").strip()
            if detail:
                errors.append(f"GraphQL validation: {detail}")
        elif "GraphQL validation error" in line or "Cannot query field" in line:
            errors.append(f"GraphQL validation: {line.lstrip('*- ')}")

    # Fallback: if we know there are errors but couldn't parse specifics,
    # return the raw summary so the handler has something to act on.
    if not errors:
        errors = ["GraphQL validation: one or more operations failed Shopify schema validation — see details and fix mutation/query names and argument shapes"]

    log.info("MCP GraphQL validation: %d error(s) in handler", len(errors))
    return errors
