"""
Coding-agent tools — Anthropic tool definitions + Python implementations.

The agent calls one tool per turn. The runner (separate module) handles the
multi-turn loop and per-call logging. This file only owns:

  - TOOL_DEFINITIONS — Anthropic-format JSON schemas the model sees.
  - The seven tool callables — pure Python functions that take a
    `RunnerContext` and the tool input, returning a JSON-serialisable dict.
  - TOOL_DISPATCH — name → callable map for the loop to use.
  - The write allowlist enforcer.

Conventions:
  - Every tool returns a dict. The dispatcher serialises it to JSON when
    packing into the tool_result message.
  - Errors that the agent should see are returned as `{"error": "<msg>"}`,
    not raised. Raising is reserved for runner bugs.
  - All filesystem paths in tool inputs are repo-relative (e.g.
    "scaffold/app.json", "platform-ai/context/component_rules/backend.md").
    The dispatcher resolves them against `ctx.repo_root`.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


# ── Constants ───────────────────────────────────────────────────────────────

SHOPIFY_API_VERSION = "2026-04"
DEFAULT_READ_LIMIT = 2000  # lines


# ── Runner context ──────────────────────────────────────────────────────────


@dataclass
class RunnerContext:
    """Per-run state shared across tool calls.

    `repo_root` is the directory all repo-relative paths resolve against.
    `work_dir` is the run's working directory — `scaffold/` lives directly
    underneath it. `run_dir` is the on-disk dir for this run's logs and
    outputs (test_results/<ts>_<slug>/codegen/).
    """

    repo_root: Path
    work_dir: Path
    run_dir: Path
    todos: List[Dict[str, str]] = field(default_factory=list)
    done_called: bool = False


# ── Write allowlist ─────────────────────────────────────────────────────────


def _classify_write_path(path: str) -> tuple[bool, str]:
    """Return (allowed, reason). Empty reason means allowed."""
    # Explicit allows
    if path == "scaffold/app.json":
        return True, ""
    if path == "scaffold/src/types/contracts.ts":
        return True, ""
    if not path.endswith(".ts"):
        return False, "only .ts and scaffold/app.json are writable"

    parts = path.split("/")
    # scaffold/src/routes/<name>.ts
    if path.startswith("scaffold/src/routes/") and len(parts) == 4:
        return True, ""
    # scaffold/src/webhooks/<name>.ts
    if path.startswith("scaffold/src/webhooks/") and len(parts) == 4:
        return True, ""
    # scaffold/src/lib/<...>.ts (any depth)
    if path.startswith("scaffold/src/lib/"):
        return True, ""
    # scaffold/admin/<name>.ts
    if path.startswith("scaffold/admin/") and len(parts) == 3:
        return True, ""
    # scaffold/widget/<name>.ts
    if path.startswith("scaffold/widget/") and len(parts) == 3:
        return True, ""

    # Explicit denies with reason
    if path == "scaffold/src/server.ts":
        return False, "rendered from app.json by the runner — do not write"
    if path.startswith("migrations/"):
        return False, "rendered from app.json by the runner — do not write"
    if path.startswith("platform-back/templates/"):
        return False, "platform template is read-only"

    return False, "path not in write allowlist"


# ── Tool implementations ────────────────────────────────────────────────────


def tool_read_file(
    ctx: RunnerContext,
    path: str,
    offset: Optional[int] = None,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    """Read any file in the repo or under the run's working dir.

    Path resolution:
      - Paths starting with `scaffold/` resolve under `work_dir` (the
        agent's own writes live here).
      - Anything else resolves under `repo_root` (catalogs, template,
        component_rules, etc.).
    """
    if path.startswith("scaffold/"):
        p = (ctx.work_dir / path).resolve()
        root = ctx.work_dir
    else:
        p = (ctx.repo_root / path).resolve()
        root = ctx.repo_root

    # Path-traversal guard: must stay inside the chosen root
    if not str(p).startswith(str(root)):
        return {"error": f"path {path!r} resolves outside its allowed root"}

    if not p.exists():
        return {"error": f"file not found: {path}"}
    if not p.is_file():
        return {"error": f"not a regular file: {path}"}

    try:
        text = p.read_text()
    except UnicodeDecodeError:
        return {"error": f"file is not UTF-8 text: {path}"}

    lines = text.splitlines()
    total = len(lines)
    start = offset or 0
    end = start + (limit if limit is not None else DEFAULT_READ_LIMIT)
    sliced = lines[start:end]

    return {
        "content": "\n".join(sliced),
        "total_lines": total,
        "returned_lines": [start, min(end, total)],  # half-open [start, end)
    }


def tool_write_file(
    ctx: RunnerContext, path: str, content: str
) -> Dict[str, Any]:
    """Write to `scaffold/`. Allowlist enforced; denied writes return a reason."""
    allowed, reason = _classify_write_path(path)
    if not allowed:
        return {"ok": False, "denied_reason": reason}

    p = ctx.work_dir / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return {"ok": True, "bytes_written": len(content)}


def tool_todo_write(
    ctx: RunnerContext, todos: List[Dict[str, str]]
) -> Dict[str, Any]:
    """Store the agent's task list. Minimal validation."""
    valid_statuses = {"pending", "in_progress", "completed"}
    in_progress = 0
    for i, t in enumerate(todos):
        if "content" not in t or "status" not in t or "activeForm" not in t:
            return {"error": f"todo[{i}] missing required field (content / status / activeForm)"}
        if t["status"] not in valid_statuses:
            return {"error": f"todo[{i}].status must be one of {sorted(valid_statuses)}"}
        if t["status"] == "in_progress":
            in_progress += 1
    if in_progress > 1:
        return {"error": f"only one todo may be in_progress at a time (found {in_progress})"}

    ctx.todos = todos
    return {"ok": True, "count": len(todos)}


def tool_get_shopify_op(
    ctx: RunnerContext, name: str, surface: str
) -> Dict[str, Any]:
    """Detail lookup from `<surface>/<version>/operations_detail.json`."""
    if surface not in ("admin", "storefront"):
        return {"error": f"surface must be 'admin' or 'storefront', got {surface!r}"}

    detail_path = (
        ctx.repo_root
        / "platform-ai"
        / "catalogs"
        / f"shopify_{surface}"
        / SHOPIFY_API_VERSION
        / "operations_detail.json"
    )
    if not detail_path.exists():
        return {"error": f"operations_detail.json missing for {surface}"}

    try:
        detail = json.loads(detail_path.read_text())
    except json.JSONDecodeError as e:
        return {"error": f"operations_detail.json parse error: {e}"}

    if name not in detail:
        return {"error": f"op {name!r} not in {surface} catalog — check summary for valid names"}

    return detail[name]


def tool_list_shopify_ops(
    ctx: RunnerContext, cluster: str, surface: str
) -> Dict[str, Any]:
    """List every Shopify GraphQL op in a cluster (queries + mutations)
    with its full signature line.

    Use BEFORE `get_shopify_op` so siblings are visible side-by-side.
    Example: `list_shopify_ops("discount", "admin")` returns all 30
    discount-related mutations + 7 queries, with their signatures, so
    you pick the right one (e.g. `discountCodeBasicCreate` vs
    `discountAutomaticBasicCreate`) before fetching full SDL + examples.
    """
    if surface not in ("admin", "storefront"):
        return {"error": f"surface must be 'admin' or 'storefront', got {surface!r}"}

    summary_path = (
        ctx.repo_root
        / "platform-ai"
        / "catalogs"
        / f"shopify_{surface}"
        / SHOPIFY_API_VERSION
        / "summary.md"
    )
    if not summary_path.exists():
        return {"error": f"summary.md missing for {surface}"}

    text = summary_path.read_text()
    queries: list[str] = []
    mutations: list[str] = []
    current: Optional[list] = None

    q_marker = f"## Queries — {cluster} ("
    m_marker = f"## Mutations — {cluster} ("

    for line in text.splitlines():
        if line.startswith("## "):
            if line.startswith(q_marker):
                current = queries
            elif line.startswith(m_marker):
                current = mutations
            else:
                current = None
            continue
        if current is not None and line.strip() and not line.startswith("#"):
            # Skip bullet lines from ToC (they start with "- ")
            if line.startswith("- "):
                continue
            current.append(line.rstrip())

    if not queries and not mutations:
        return {
            "error": f"no ops found for cluster {cluster!r} on {surface!r} surface — "
            "check the cluster index in the system prompt for valid names"
        }

    return {
        "cluster": cluster,
        "surface": surface,
        "queries": queries,
        "mutations": mutations,
    }


def tool_list_webhook_family(ctx: RunnerContext, prefix: str) -> Dict[str, Any]:
    """Return every webhook topic in a resource cluster + its description.

    Use this BEFORE `get_webhook_topic` to compare siblings side-by-side
    and avoid name-driven misses. Example: `list_webhook_family("products")`
    returns products/create, products/delete, products/update with their
    descriptions — making it visible that products/update covers variant
    changes (something products/delete does NOT).
    """
    topics_path = (
        ctx.repo_root
        / "platform-ai"
        / "catalogs"
        / "shopify_webhooks"
        / SHOPIFY_API_VERSION
        / "topics.json"
    )
    if not topics_path.exists():
        return {"error": "topics.json missing for webhooks"}

    try:
        catalog = json.loads(topics_path.read_text())
    except json.JSONDecodeError as e:
        return {"error": f"topics.json parse error: {e}"}

    topics = catalog.get("topics", {})
    matching = []
    for name in sorted(topics):
        if name == prefix or name.startswith(prefix + "/"):
            matching.append(
                {
                    "topic": name,
                    "description": topics[name].get("description", ""),
                }
            )

    if not matching:
        return {
            "error": f"no webhook topics found with prefix {prefix!r} — "
            "see the cluster index in the system prompt for valid prefixes"
        }

    return {"prefix": prefix, "topics": matching}


def tool_get_webhook_topic(ctx: RunnerContext, name: str) -> Dict[str, Any]:
    """Detail lookup from `shopify_webhooks/<version>/topics.json`."""
    topics_path = (
        ctx.repo_root
        / "platform-ai"
        / "catalogs"
        / "shopify_webhooks"
        / SHOPIFY_API_VERSION
        / "topics.json"
    )
    if not topics_path.exists():
        return {"error": "topics.json missing for webhooks"}

    try:
        catalog = json.loads(topics_path.read_text())
    except json.JSONDecodeError as e:
        return {"error": f"topics.json parse error: {e}"}

    topics = catalog.get("topics", {})
    if name not in topics:
        return {"error": f"topic {name!r} not in webhook catalog — check summary for valid names"}

    return topics[name]


def tool_run_tsc(ctx: RunnerContext) -> Dict[str, Any]:
    """Type-check the assembled scaffold. Two passes, merged:
      - backend: overlays scaffold/src on the platform template's src.
      - UI: scaffold/{admin,widget}/*.ts against a DOM tsconfig with the
        SDK contracts (AdminBridge / Host) resolvable.
    Returns `npx tsc --noEmit` errors from both."""
    from subagents.w_coding_agent.tsc_runner import (
        run_tsc_on_scaffold,
        run_tsc_on_ui_scaffold,
    )

    try:
        errors = run_tsc_on_scaffold(ctx.repo_root, ctx.work_dir)
        errors = errors + run_tsc_on_ui_scaffold(ctx.repo_root, ctx.work_dir)
    except subprocess.TimeoutExpired as e:
        return {
            "error": f"tsc timed out after {e.timeout}s — investigate by hand",
            "errors": [],
        }
    except FileNotFoundError as e:
        return {
            "error": f"command not found: {e.filename!r} — is npx on PATH?",
            "errors": [],
        }

    return {"errors": errors}


def tool_done(ctx: RunnerContext) -> Dict[str, Any]:
    """Declare completion. Runs the deterministic gate (structural checks +
    tsc); only flips `done_called` when it passes. On failure the issues
    come back as `incomplete_reason` and the loop continues so the agent
    fixes them."""
    from subagents.w_coding_agent.integrity import run_done_gate

    issues = run_done_gate(ctx)
    if issues:
        return {"ok": False, "incomplete_reason": issues}

    ctx.done_called = True
    return {"ok": True}


# ── Dispatch table ──────────────────────────────────────────────────────────


TOOL_DISPATCH: Dict[str, Callable[..., Dict[str, Any]]] = {
    "read_file": tool_read_file,
    "write_file": tool_write_file,
    "todo_write": tool_todo_write,
    "list_shopify_ops": tool_list_shopify_ops,
    "get_shopify_op": tool_get_shopify_op,
    "list_webhook_family": tool_list_webhook_family,
    "get_webhook_topic": tool_get_webhook_topic,
    "run_tsc": tool_run_tsc,
    "done": tool_done,
}


# ── Anthropic tool definitions ──────────────────────────────────────────────


TOOL_DEFINITIONS: List[Dict[str, Any]] = [
    {
        "name": "read_file",
        "description": (
            "Read a file from the repository. Use offset/limit (line-based) "
            "for large files. Returns content plus total_lines and the "
            "returned_lines window."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Repo-relative path (e.g. 'platform-ai/context/component_rules/backend.md').",
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Zero-based line offset to start reading from. Defaults to 0.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Maximum number of lines to return. Defaults to 2000.",
                },
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": (
            "Write a file under scaffold/. Allowlisted paths only: "
            "scaffold/app.json, scaffold/src/types/contracts.ts, "
            "scaffold/src/{routes,webhooks}/*.ts, scaffold/src/lib/**/*.ts, "
            "scaffold/{admin,widget}/*.ts. Denied writes return ok=false "
            "with a denied_reason; do not retry the same path."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "todo_write",
        "description": (
            "Maintain your task list. Each todo has content, status "
            "(pending|in_progress|completed), and activeForm. Exactly ONE "
            "in_progress at any time. Replace the full list on each call."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {"type": "string"},
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"],
                            },
                            "activeForm": {"type": "string"},
                        },
                        "required": ["content", "status", "activeForm"],
                    },
                }
            },
            "required": ["todos"],
        },
    },
    {
        "name": "list_shopify_ops",
        "description": (
            "List every Shopify GraphQL op (queries + mutations) in a "
            "cluster with full signatures, so siblings are visible "
            "side-by-side. ALWAYS call this BEFORE get_shopify_op so you "
            "pick the right one (e.g. discountCodeBasicCreate vs "
            "discountAutomaticBasicCreate). Cluster names come from the "
            "Admin/Storefront index in the system prompt."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "cluster": {
                    "type": "string",
                    "description": "Resource cluster name, e.g. 'discount', 'order', 'product'.",
                },
                "surface": {
                    "type": "string",
                    "enum": ["admin", "storefront"],
                },
            },
            "required": ["cluster", "surface"],
        },
    },
    {
        "name": "get_shopify_op",
        "description": (
            "Detail lookup for a single Shopify GraphQL operation. Returns "
            "args, returnTypeSdl, inputTypesSdl, and examples (working "
            "query/variables/response triples). Call AFTER narrowing to a "
            "single op via list_shopify_ops."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Exact op name as in the summary."},
                "surface": {
                    "type": "string",
                    "enum": ["admin", "storefront"],
                },
            },
            "required": ["name", "surface"],
        },
    },
    {
        "name": "list_webhook_family",
        "description": (
            "List every webhook topic in a resource cluster, with each "
            "topic's description, so siblings are visible side-by-side. "
            "ALWAYS call this for every plausible cluster BEFORE picking a "
            "topic. Example: for a 'variant deletion' event call this "
            "with prefix='products' AND prefix='variants' to see all "
            "candidates. Returns { prefix, topics: [{ topic, description }] }."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "prefix": {
                    "type": "string",
                    "description": "Cluster prefix (without trailing slash), e.g. 'products', 'orders', 'inventory_levels'.",
                }
            },
            "required": ["prefix"],
        },
    },
    {
        "name": "get_webhook_topic",
        "description": (
            "Detail lookup for one webhook topic. Returns description, "
            "payloadFields, access_scopes, related_resource, and a "
            "deprecation flag when relevant. Call AFTER you've narrowed "
            "to a single topic via list_webhook_family."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Exact topic, e.g. 'orders/paid'.",
                }
            },
            "required": ["name"],
        },
    },
    {
        "name": "run_tsc",
        "description": (
            "Type-check the assembled scaffold. Covers BOTH the backend "
            "(template + your src/) AND the UI surfaces (admin/ui.ts against "
            "AdminBridge, widget/widget.ts against Host). Returns errors with "
            "file, line, message; empty list means clean. The UI mount param "
            "must be typed with the SDK type (never `any`) or it flags. Call "
            "proactively, not only at the end."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "done",
        "description": (
            "Declare completion. The runner verifies app.json parses, "
            "contracts.ts exists, tsc passes, and every httpRoute / "
            "webhookTopic has a matching handler file. On incomplete_reason, "
            "the loop continues with that error as feedback."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
]


# ── Convenience: invoke by name ─────────────────────────────────────────────


def call_tool(ctx: RunnerContext, name: str, tool_input: Dict[str, Any]) -> Dict[str, Any]:
    """Dispatch a tool call. Used by the runner's loop after pulling
    tool_name + tool_input off the model's tool_use block.
    """
    fn = TOOL_DISPATCH.get(name)
    if fn is None:
        return {"error": f"unknown tool {name!r}"}
    try:
        return fn(ctx, **tool_input)
    except TypeError as e:
        # Surfaces shape errors as agent-visible errors rather than crashes
        return {"error": f"bad input shape for {name}: {e}"}
