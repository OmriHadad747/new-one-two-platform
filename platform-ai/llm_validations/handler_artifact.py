"""
Handler-artifact validation — runs on the handler bundle after codegen.

Public entry points:
  validate_handler_artifact   — full handler-bundle check
  FORBIDDEN_HANDLER_PATTERNS  — regex/message pairs (also consumed by tests)
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from subagents.prompts.capabilities import NPM
from subagents.prompts.topics.template_tables import (
    TEMPLATE_OWNED_FILES,
    TEMPLATE_OWNED_TABLES,
)
from subagents.prompts.topics.webhook import WEBHOOK_TOPICS as _VALID_WEBHOOK_TOPICS
from utils.static_validations.js_parse import (
    js_is_syntactically_complete as _js_is_syntactically_complete,
    pkg_base as _pkg_base,
    scan_balanced_paren as _scan_balanced_paren,
    split_top_level as _split_top_level,
    string_literal_value as _string_literal_value,
)
from utils.static_validations.shared_checks import (
    find_setTimeout_violations as _find_setTimeout_violations,
)
from utils.static_validations.sql_parse import (
    is_inside_sql_begin as _is_inside_sql_begin,
)


FORBIDDEN_HANDLER_PATTERNS = [
    # Structural — always forbidden regardless of file role.
    (r"\beval\s*\(", "eval() is not allowed"),
    (r"\bnew\s+Function\s*\(", "new Function() is not allowed"),
    (
        r"\bsetInterval\s*\(",
        "setInterval is not allowed — handlers are short-lived; use the "
        "cron runner (src/routes/cron.ts) for scheduled work",
    ),
    (r"\bsetImmediate\s*\(", "setImmediate is not allowed"),
    (r"\bprocess\.exit\b", "process.exit is not allowed"),
    (r"\bprocess\.kill\b", "process.kill is not allowed"),
    # Legacy CommonJS surface — generator output is ESM TypeScript.
    (
        r"\brequire\s*\(",
        "require() is not allowed — use ESM `import` syntax (this is "
        "TypeScript, tsc compiles to ESM for Node 20)",
    ),
    (
        r"\bmodule\.exports\b",
        "module.exports is not allowed — use ESM `export` / `export const` " "syntax",
    ),
    # Legacy ctx.* surface — prompt has been retargeted to req.platform + sql
    # + platform.*. Any ctx.* reference is carry-over from the
    # pre-Phase-2 prompt set and the model is regressing.
    (
        r"\bctx\.(?:db|tenantId|shopify|payload|trigger|widgetPath|widgetBody|adminPath|adminBody|logger|shop|services|http|storefront)\b",
        "ctx.* references are no longer available — use req.platform, `sql` "
        "from ../lib/db.js, `platform` from "
        "../lib/platform.js, or the shopify client from ../lib/shopify.js",
    ),
    # Local-disk writes — always forbidden on Cloud Run (ephemeral FS).
    # Rewritten to point at the new /services/files/upload path.
    (
        r"\bsharp\s*\([^)]*\)[\s\S]*?\.toFile\s*\(",
        "sharp(...).toFile(path) writes to the local filesystem which is "
        "ephemeral on Cloud Run — use sharp(...).toBuffer() and hand the "
        "Buffer (base64) to /services/files/upload instead.",
    ),
    (
        r"\.pipe\s*\(\s*fs\.createWriteStream\s*\(",
        ".pipe(fs.createWriteStream(...)) writes to the local filesystem "
        "which is ephemeral on Cloud Run — buffer the stream in memory and "
        "hand the Buffer (base64) to /services/files/upload.",
    ),
    (
        r"\.xlsx\.writeFile\s*\(",
        "wb.xlsx.writeFile(path) writes to the local filesystem which is "
        "ephemeral on Cloud Run — use wb.xlsx.writeBuffer() and hand the "
        "Buffer (base64) to /services/files/upload.",
    ),
    (
        r"""import\s+.*?\s+from\s+['"]\.\.\/lib\/platform-call\.js['"]""",
        "direct import from ../lib/platform-call.js is not allowed — "
        "use `platform` from ../lib/platform.js instead",
    ),
    # Template-owned tables — must not appear in any DML inside a `sql`
    # tagged-template literal. The table-name list is sourced from
    # template_tables.TEMPLATE_OWNED_TABLES so the prompt guidance and
    # this enforcement layer stay in lockstep when a new template-owned
    # table is added.
    (
        (
            r"(?i)sql\s*(?:<[^>]*>)?\s*`[^`]*"
            r"\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|JOIN)\s+"
            rf"(?:{'|'.join(re.escape(t) for t in sorted(TEMPLATE_OWNED_TABLES))})\b"
        ),
        "handler must not read or write template-owned tables ("
        + ", ".join(sorted(TEMPLATE_OWNED_TABLES))
        + ") directly — use `enqueueJob` from ../lib/cron-enqueue.js for "
        "ad-hoc cron triggers; processed_webhooks is owned by the template "
        "webhook router and is written before your handler runs",
    ),
]

# Fields the old email API used to accept — all of them have moved into the
# merchant-configured template, so a handler passing any of them is calling a
# deprecated shape that will be silently ignored (or worse, break when the
# merchant does configure their template and the handler's values override it).
# Only { to, data } are allowed.
_RESERVED_TEMPLATE_FILES = TEMPLATE_OWNED_FILES

# Node 20 builtins — always allowed in ESM imports (no npm declaration
# needed). Mirrored from the legacy validator's CJS list; TS imports the
# same set via `import ... from "node:X"` or the bare specifier.
_NODE_BUILTINS = frozenset(
    {
        "assert",
        "buffer",
        "child_process",
        "crypto",
        "events",
        "fs",
        "http",
        "https",
        "net",
        "os",
        "path",
        "process",
        "querystring",
        "stream",
        "string_decoder",
        "url",
        "util",
        "zlib",
    }
)

# Packages the handler template ships in package.json — always available
# without an npmPackages declaration. Keep in sync with
# platform-back/templates/handler/package.json.
_TEMPLATE_PACKAGES = frozenset(
    {
        "express",
        "postgres",
        "google-auth-library",
        "jose",
        "@shopify/shopify-api",
    }
)

def validate_handler_artifact(
    artifact: str,
    api_plan_topics: List[str],
    widget_catalog: Optional[List[Dict[str, Any]]] = None,
    admin_catalog: Optional[List[Dict[str, Any]]] = None,
    cron_batching_required: bool = False,
    has_state_machine: bool = False,
    cron_schedule: Optional[str] = None,
    declared_capabilities: Optional[List[str]] = None,
    db_contracts: Optional[List[Dict[str, Any]]] = None,
) -> List[str]:
    """
    Validate the generated handler file bundle.

    The generator now emits a marker-delimited bundle of TypeScript files
    (===FILE: <path>=== / ===END===) that drop into the platform-back
    handler template. This validator parses the bundle, applies per-file
    TS rules, and verifies the required files + routes are present.

    Checks
    ------
    1. Bundle markers parse cleanly (no unclosed / nested ===FILE:===).
    2. No file path writes to a template-reserved path (server.ts,
       middleware, lib/{db,platform-call,shopify,cron-runner}.ts, etc.).
    3. Required files present based on the architect plan:
         - src/routes/webhook-handlers.ts when webhookTopics non-empty
         - src/routes/admin.ts            when adminApiCatalog non-empty
         - src/routes/widget.ts           when widgetApiCatalog non-empty
         - src/routes/cron.ts             when cronSchedule is set
       And NOT present when the plan says no (widgetApiCatalog == []
       means storefront-direct; widget.ts must not be emitted).
    4. Per-file TS rules (every file):
         - Syntax completeness (balanced braces/strings).
         - Forbidden patterns (require, module.exports, ctx.*, eval,
           setInterval, setImmediate, process.exit/kill, disk-writes,
           direct platform-call.js imports).
         - setTimeout bounded-pause check (≤500ms literal, same as legacy).
         - Imports limited to: Node builtins, template-shipped packages,
           architect-approved npm capabilities, or relative ../lib/* paths.
    5. webhook-handlers.ts: exports `webhookHandlers` map; every planned
       topic has a matching key; no res.* calls; no idempotency gate
       (template router owns both).
    6. admin.ts: exports `adminRouter`; every adminApiCatalog path has a
       matching `adminRouter.<method>("<path>", ...)` registration.
    7. widget.ts: exports `widgetRouter`; every widgetApiCatalog path
       registered.
    8. cron.ts: exports `jobs`; has at least one entry.
    9. State-machine flag: any file contains a `sql\`SELECT` before any
       INSERT/UPDATE of the state column (soft-verified; validator_agent
       in step 10 does the full semantic check).
    """
    errors: List[str] = []

    # 1. Parse the file bundle.
    from utils.file_bundle import parse_file_bundle, is_file_bundle, ParseError

    if not is_file_bundle(artifact):
        errors.append(
            "handler output is missing the ===FILE: <path>=== / ===END=== "
            "marker bundle. Emit every file between explicit markers — see "
            "the 'REQUIRED OUTPUT FORMAT' section of the system prompt."
        )
        return errors

    try:
        files = parse_file_bundle(artifact)
    except ParseError as err:
        errors.append(f"handler bundle malformed: {err}")
        return errors

    if not files:
        errors.append("handler bundle parsed to zero files")
        return errors

    files_by_path: Dict[str, str] = {f["path"]: f["contents"] for f in files}

    # 2. No file may target a template-reserved path. Also reject
    # absolute paths and ".." traversal (the deployer re-checks, but
    # catching here gives a better retry error).
    for path in files_by_path.keys():
        if path.startswith("/"):
            errors.append(f"file path '{path}' is absolute — paths must be relative")
            continue
        if ".." in path.split("/"):
            errors.append(f"file path '{path}' contains '..' — traversal not allowed")
            continue
        if path in _RESERVED_TEMPLATE_FILES:
            errors.append(
                f"file path '{path}' is template-owned and must not be emitted by "
                f"the generator — remove it from the output"
            )
        elif not (path.startswith("src/routes/") or path.startswith("src/lib/")):
            errors.append(
                f"file path '{path}' is outside the allowed generator scope — "
                f"emit only src/routes/*.ts and src/lib/*.ts"
            )

    # 3. Required files gate.
    widget_declared = widget_catalog is not None
    widget_used = bool(widget_catalog)
    admin_used = bool(admin_catalog)

    if api_plan_topics and "src/routes/webhook-handlers.ts" not in files_by_path:
        errors.append(
            "webhookTopics is non-empty but src/routes/webhook-handlers.ts is missing — "
            "emit the webhookHandlers map file"
        )
    if admin_used and "src/routes/admin.ts" not in files_by_path:
        errors.append(
            "adminApiCatalog is non-empty but src/routes/admin.ts is missing — "
            "emit the adminRouter file"
        )
    if widget_used and "src/routes/widget.ts" not in files_by_path:
        errors.append(
            "widgetApiCatalog is non-empty but src/routes/widget.ts is missing — "
            "emit the widgetRouter file"
        )
    if cron_schedule and "src/routes/cron.ts" not in files_by_path:
        errors.append(
            "cronSchedule is set but src/routes/cron.ts is missing — "
            "emit the jobs map file"
        )
    # Storefront-direct widget apps explicitly must NOT emit widget.ts.
    if widget_declared and not widget_used and "src/routes/widget.ts" in files_by_path:
        errors.append(
            "widgetApiCatalog is [] (storefront-direct) but src/routes/widget.ts "
            "was emitted — do not emit that file; the template's placeholder is fine"
        )

    # 4. Per-file TS rules.
    declared_caps = set(declared_capabilities or [])
    allowed_import_specifiers = _build_import_allowlist(declared_caps)

    for path, code in files_by_path.items():
        errors.extend(_validate_ts_file(path, code, allowed_import_specifiers))

    # 5-8. Per-role checks.
    if "src/routes/webhook-handlers.ts" in files_by_path:
        errors.extend(
            _validate_webhook_handlers(
                files_by_path["src/routes/webhook-handlers.ts"], api_plan_topics
            )
        )
    if "src/routes/admin.ts" in files_by_path:
        errors.extend(
            _validate_admin_router(
                files_by_path["src/routes/admin.ts"], admin_catalog or []
            )
        )
    if "src/routes/widget.ts" in files_by_path and widget_used:
        errors.extend(
            _validate_widget_router(
                files_by_path["src/routes/widget.ts"], widget_catalog or []
            )
        )
    if "src/routes/cron.ts" in files_by_path:
        errors.extend(_validate_cron_router(files_by_path["src/routes/cron.ts"]))

    # 9. State-machine soft check — every file combined.
    if has_state_machine:
        any_select = any(
            re.search(r"\bsql\s*(?:<[^>]*>)?\s*`\s*SELECT", c, re.IGNORECASE)
            for c in files_by_path.values()
        )
        if not any_select:
            errors.append(
                "stateMachine is declared but no sql`SELECT` read appears in any "
                "handler file — load the last-observed value before comparing to the "
                "incoming event and writing the new state"
            )

    # 10. Concurrency idiom: FOR UPDATE SKIP LOCKED is meaningless outside a
    #     `sql.begin(...)` block — postgres-js auto-commits each `sql\`...\``
    #     call, releasing the lock before the loop body runs. See Finding 5
    #     in docs/FINDINGS_DEFERRED_4_5_6.md.
    for path, code in files_by_path.items():
        errors.extend(_check_skip_locked_in_transaction(path, code))

    # 11. Status enum cross-check: every literal value the handler writes to
    #     a dbContracts column with a declared `enum` must be in that enum.
    #     Without this, the migration emits a CHECK constraint the handler
    #     INSERT silently fails against. See Finding 6 in
    #     docs/FINDINGS_DEFERRED_4_5_6.md.
    errors.extend(_check_enum_writes(files_by_path, db_contracts or []))

    return errors

# ── Per-file helpers ──────────────────────────────────────────────────────────

def _build_import_allowlist(declared_caps: set) -> frozenset:
    """
    Union of (a) template-shipped packages + (b) npm capability packages
    the architect declared. A capability that's declared grants the
    handler permission to import its package(s); a capability that's NOT
    declared keeps the package unreachable even though it's present in
    the template's package.json.

    Keeps the architect-vs-handler layering tight: the ARCHITECT decides
    what this app needs, the HANDLER writes code against that set.
    """
    allowed = set(_TEMPLATE_PACKAGES)
    for cap_name in declared_caps:
        entry = NPM.get(cap_name)
        if entry:
            allowed.update(entry["packages"])
    return frozenset(allowed)

_SKIP_LOCKED_RE = re.compile(r"FOR\s+UPDATE\s+SKIP\s+LOCKED", re.IGNORECASE)

def _check_skip_locked_in_transaction(path: str, code: str) -> List[str]:
    """
    Reject `FOR UPDATE SKIP LOCKED` that is not inside a `sql.begin(...)`
    block. postgres-js auto-commits each tagged-template invocation, so a
    lock taken by a bare ``sql`SELECT … FOR UPDATE SKIP LOCKED` `` is
    released the moment the SELECT commits — before the handler can act on
    the row. Two overlapping cron ticks then both claim the same row and
    double-execute.

    Heuristic: for each match of FOR UPDATE SKIP LOCKED, walk backwards in
    the file looking for the nearest unmatched-open `sql.begin(`; if we hit
    the file start (or another closing brace before any open `sql.begin(`),
    it's outside a transaction. Coarse but adequate — `sql.begin(` is the
    only legitimate gate here, and the false-positive cost is just a noisier
    retry message.
    """
    errors: List[str] = []
    for match in _SKIP_LOCKED_RE.finditer(code):
        if not _is_inside_sql_begin(code, match.start()):
            line = code.count("\n", 0, match.start()) + 1
            errors.append(
                f"[{path}:{line}] `FOR UPDATE SKIP LOCKED` appears outside a "
                "`sql.begin(async (tx) => {...})` block. Each `sql\\`...\\`` "
                "call auto-commits, so the lock is released before the loop "
                "body runs — overlapping cron/webhook ticks will double-claim "
                "the same row. Either wrap the claim-process-update span in "
                "`sql.begin(...)`, or replace SKIP LOCKED with the canonical "
                "atomic claim idiom: `UPDATE ... WHERE <state>=<prev> "
                "RETURNING <id>` and bail when the result is empty."
            )
    return errors

_INSERT_INTO_HEAD_RE = re.compile(
    r"INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(",
    re.IGNORECASE | re.DOTALL,
)
_SET_ASSIGNMENT_RE = re.compile(
    r"\bSET\s+(.+?)(?=\s+(?:WHERE|RETURNING|ON\s+CONFLICT)\b|\s*[`;])",
    re.IGNORECASE | re.DOTALL,
)

def _check_enum_writes(
    files_by_path: Dict[str, str],
    db_contracts: List[Dict[str, Any]],
) -> List[str]:
    """
    Cross-check: literal values the handler writes to enum columns must be
    in the column's declared enum list. Catches divergence before the DB's
    CHECK constraint rejects the INSERT at runtime.

    Only flags TEXT-literal writes ('value') — variable interpolations
    (${value}) are out of scope for static analysis.
    """
    enum_map: Dict[str, Dict[str, List[str]]] = {}
    for contract in db_contracts:
        table = (contract.get("table") or "").lower()
        if not table:
            continue
        for col in contract.get("columns") or []:
            enum_values = col.get("enum")
            if isinstance(enum_values, list) and enum_values:
                enum_map.setdefault(table, {})[(col.get("name") or "").lower()] = list(
                    enum_values
                )
    if not enum_map:
        return []

    errors: List[str] = []
    seen: set = set()
    for path, code in files_by_path.items():
        # INSERT INTO ... VALUES ('literal', ...): match column index → value index.
        for match in _INSERT_INTO_HEAD_RE.finditer(code):
            table = match.group(1).lower()
            col_block = match.group(2)
            val_block = _scan_balanced_paren(code, match.end())
            if val_block is None:
                continue
            cols = [c.strip().strip("`\"").lower() for c in col_block.split(",")]
            vals = _split_top_level(val_block)
            table_enums = enum_map.get(table) or {}
            for idx, col_name in enumerate(cols):
                if col_name not in table_enums or idx >= len(vals):
                    continue
                literal = _string_literal_value(vals[idx])
                if literal is None:
                    continue
                if literal not in table_enums[col_name]:
                    key = (path, table, col_name, literal)
                    if key in seen:
                        continue
                    seen.add(key)
                    errors.append(
                        f"[{path}] writes literal '{literal}' into "
                        f"{table}.{col_name} but the architect declared "
                        f"enum {table_enums[col_name]!r}. The migration "
                        f"emits CHECK ({col_name} IN (...)) — this INSERT "
                        "would be rejected at runtime."
                    )
        # UPDATE ... SET <col> = '<literal>': scan SET clauses for known
        # enum columns. Cheap and catches the common case.
        for assignment in _SET_ASSIGNMENT_RE.findall(code):
            for col_name, literal in re.findall(
                r"\b(\w+)\s*=\s*'([^']*)'", assignment
            ):
                col_lower = col_name.lower()
                for table, table_enums in enum_map.items():
                    if col_lower in table_enums and literal not in table_enums[col_lower]:
                        key = (path, table, col_lower, literal)
                        if key in seen:
                            continue
                        seen.add(key)
                        errors.append(
                            f"[{path}] writes literal '{literal}' into "
                            f"column '{col_lower}' but the architect declared "
                            f"enum {table_enums[col_lower]!r}. The migration "
                            f"emits CHECK ({col_lower} IN (...)) — this UPDATE "
                            "would be rejected at runtime."
                        )
    return errors

def _validate_ts_file(
    path: str, code: str, allowed_import_specifiers: frozenset
) -> List[str]:
    """Generic per-TypeScript-file checks applied to every emitted file."""
    errors: List[str] = []

    # Syntax completeness — catches truncated output.
    if not _js_is_syntactically_complete(code):
        errors.append(
            f"[{path}] code is syntactically incomplete (truncated?) — "
            "unbalanced braces, unclosed string, or unmatched brackets"
        )
        return errors  # further checks meaningless on broken code

    # Forbidden structural patterns.
    for pattern, message in FORBIDDEN_HANDLER_PATTERNS:
        m = re.search(pattern, code)
        if m:
            errors.append(f"[{path}] {message}")

    # setTimeout bounded-pause check.
    for err in _find_setTimeout_violations(code):
        errors.append(f"[{path}] {err}")

    # Import allowlist. Supports:
    #   import x from "specifier"
    #   import { a, b } from "specifier"
    #   import "side-effect-only"
    #   import * as x from "specifier"
    for m in re.finditer(r"""import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]""", code):
        spec = m.group(1)
        if spec.startswith("./") or spec.startswith("../"):
            continue  # relative imports are always fine
        base = _pkg_base(spec)
        if base in _NODE_BUILTINS or base.removeprefix("node:") in _NODE_BUILTINS:
            continue
        if base not in allowed_import_specifiers:
            errors.append(
                f"[{path}] import from '{spec}' is not allowed — the architect "
                f"did not declare the capability that would authorize it. "
                f"Allowed package imports for this handler: "
                f"{sorted(allowed_import_specifiers)}"
            )

    return errors

def _validate_webhook_handlers(code: str, plan_topics: List[str]) -> List[str]:
    errors: List[str] = []

    if not re.search(r"\bexport\s+const\s+webhookHandlers\b", code):
        errors.append(
            "[src/routes/webhook-handlers.ts] must export `webhookHandlers` — "
            "the template's webhook.ts imports by that exact name"
        )

    # Handlers must never write responses — the template router owns that.
    if re.search(r"\bres\s*\.\s*(json|status|send)\b", code):
        errors.append(
            "[src/routes/webhook-handlers.ts] handlers must not call "
            "res.json/res.status/res.send — the template router owns all "
            "response writes; throw to signal failure"
        )

    # Handlers must not include the idempotency gate — the template owns it.
    if re.search(r"INSERT\s+INTO\s+processed_webhooks", code, re.IGNORECASE):
        errors.append(
            "[src/routes/webhook-handlers.ts] must not include the idempotency "
            "gate — the template's webhook.ts handles processed_webhooks; "
            "remove it from the handlers file"
        )

    # Plan topics must match the map keys.
    # Match `"orders/create": async (` or `'products/update': (` style entries.
    key_topics = set(re.findall(r"""['"]([^'"]+)['"]\s*:\s*(?:async\s+)?\(""", code))
    topic_keys = {k for k in key_topics if "/" in k}

    # "_cron/*" keys are legacy — flag them.
    bogus_cron = {t for t in topic_keys if t.startswith("_cron/")}
    if bogus_cron:
        errors.append(
            f"[src/routes/webhook-handlers.ts] keys {sorted(bogus_cron)} look "
            f"like cron dispatch — cron ticks arrive via src/routes/cron.ts "
            f"(jobs map), not the webhook handlers map"
        )
    real_keys = topic_keys - bogus_cron

    valid_topics = _VALID_WEBHOOK_TOPICS
    unknown = real_keys - valid_topics
    if unknown:
        errors.append(
            f"[src/routes/webhook-handlers.ts] unknown webhook topics as keys: "
            f"{sorted(unknown)}"
        )

    planned = set(plan_topics)
    if planned:
        missing = planned - real_keys
        if missing:
            errors.append(
                f"[src/routes/webhook-handlers.ts] missing handler for planned "
                f"topics: {sorted(missing)}"
            )
        extra = real_keys - planned
        if extra:
            errors.append(
                f"[src/routes/webhook-handlers.ts] handler key for topic(s) not "
                f"in the architect plan: {sorted(extra)}"
            )
    elif real_keys:
        errors.append(
            f"[src/routes/webhook-handlers.ts] declares handler keys "
            f"{sorted(real_keys)} but the plan has no webhookTopics — remove "
            f"the file or align the plan"
        )

    return errors

def _validate_admin_router(code: str, admin_catalog: List[Dict[str, Any]]) -> List[str]:
    errors: List[str] = []

    if not re.search(r"\bexport\s+const\s+adminRouter\b", code):
        errors.append("[src/routes/admin.ts] must export a named const `adminRouter`")

    for entry in admin_catalog:
        method = (entry.get("method") or "POST").lower()
        path = entry.get("path", "")
        if not path:
            continue
        # adminRouter.<method>("<path>", ...) OR  adminRouter[<method>]("<path>", ...)
        pattern = rf"""adminRouter\s*\.\s*{re.escape(method)}\s*\(\s*['"]{re.escape(path)}['"]"""
        if not re.search(pattern, code):
            errors.append(
                f"[src/routes/admin.ts] missing route {method.upper()} "
                f"'{path}' — register via "
                f'adminRouter.{method}("{path}", ...). Every '
                f"adminApiCatalog entry MUST be registered."
            )

    return errors

def _validate_widget_router(
    code: str, widget_catalog: List[Dict[str, Any]]
) -> List[str]:
    errors: List[str] = []

    if not re.search(r"\bexport\s+const\s+widgetRouter\b", code):
        errors.append("[src/routes/widget.ts] must export a named const `widgetRouter`")

    for entry in widget_catalog:
        method = (entry.get("method") or "POST").lower()
        path = entry.get("path", "")
        if not path:
            continue
        pattern = rf"""widgetRouter\s*\.\s*{re.escape(method)}\s*\(\s*['"]{re.escape(path)}['"]"""
        if not re.search(pattern, code):
            errors.append(
                f"[src/routes/widget.ts] missing route {method.upper()} "
                f"'{path}' — register via "
                f'widgetRouter.{method}("{path}", ...). Every '
                f"widgetApiCatalog entry MUST be registered."
            )

    return errors

def _validate_cron_router(code: str) -> List[str]:
    errors: List[str] = []

    if not re.search(r"\bexport\s+const\s+jobs\b", code):
        errors.append(
            "[src/routes/cron.ts] must export a named const `jobs` "
            "(Record<string, JobFn>) — the template's cron runner imports "
            "by that exact name"
        )
        return errors

    # Require at least one job in the map.
    has_any_job = bool(
        re.search(r"""\bjobs\b[^=]*=\s*\{[^}]*\w+\s*:""", code, re.DOTALL)
    )
    if not has_any_job:
        errors.append("[src/routes/cron.ts] jobs map must include at least one entry")

    return errors
