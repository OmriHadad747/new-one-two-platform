"""
Handler-artifact validation — runs on the handler bundle after codegen.

Public entry points:
  validate_handler_artifact   — full handler-bundle check
  FORBIDDEN_HANDLER_PATTERNS  — regex/message pairs (also consumed by tests)
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

from subagents.prompts.capabilities import NPM
from subagents.prompts.topics.template_tables import (
    TEMPLATE_OWNED_FILES,
    TEMPLATE_OWNED_TABLES,
)
from subagents.prompts.topics.webhook import WEBHOOK_TOPICS as _VALID_WEBHOOK_TOPICS
from utils.static_validations.js_parse import (
    pkg_base as _pkg_base,
    scan_balanced_paren as _scan_balanced_paren,
    split_top_level as _split_top_level,
    string_literal_value as _string_literal_value,
)
from utils.static_validations.shared_checks import (
    find_setTimeout_violations as _find_setTimeout_violations,
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
    # require() / module.exports / ctx.* — covered by tsc in ESM-only project
    # (template-owned tsconfig.json pins module: ESM). Reclassified as
    # paranoid — see HANDLER_RULES.md rows 10 and 17.
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
       middleware, lib/{db,platform-call,shopify,cron-runner}.ts, etc.);
       no absolute paths; no `..` traversal; emit only under
       src/routes/*.ts and src/lib/*.ts.
    3. Per-file TS rules (every file):
         - Forbidden patterns (eval, setInterval, setImmediate,
           process.exit/kill, disk-writes [sharp.toFile,
           fs.createWriteStream pipes, xlsx.writeFile], direct
           platform-call.js imports, template-table DML).
         - setTimeout bounded-pause check (≤500ms literal).
         - Imports limited to: Node builtins, template-shipped packages,
           architect-approved npm capabilities, or relative ../lib/* paths.
         - No `tenant_id` reference inside any `sql\`...\`` tagged template.
         - No hand-rolled fetch() to Shopify (.myshopify.com / /admin/api/).
         - shopify.bulkQuery() argument is a query, not a mutation.
    4. webhook-handlers.ts: every planned topic has a matching key;
       no res.* calls. (Missing exports + handler signatures are caught
       by tsc.)
    5. admin.ts: every adminApiCatalog path has a matching
       `adminRouter.<method>("<path>", ...)` registration.
    6. widget.ts: every widgetApiCatalog path registered.
    7. cron.ts: jobs map has at least one entry.
    8. Status enum cross-check: every literal value the handler writes
       to a dbContracts column with a declared `enum` must be in that
       enum (otherwise the migration's CHECK constraint rejects the
       INSERT/UPDATE at runtime).
    9. Email metadata sidecar (artifact-level): the ```email-metadata```
       fenced JSON block is emitted iff the handler calls
       platform.email.send/sendBatch; exactly one block when present;
       every {{placeholder}} in starterContent has a matching entry in
       `variables` and vice versa.

    Checks intentionally NOT enforced (see HANDLER_RULES.md):
      - File-presence triggers per architect plan (paranoid; tsc catches
        missing files via the template's named imports).
      - Syntactic completeness / truncation (not a prompt rule; tsc).
      - require()/module.exports/ctx.* (not in current prompt; tsc).
      - SKIP LOCKED inside sql.begin (not a handler-prompt rule).
      - State-machine SELECT presence (tautological soft check).
      - ctaLabel/ctaUrl pairing (non-catastrophic; merchants notice).
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

    # 3. Per-trigger gate flags.
    #    (File-presence checks dropped as paranoid — `handler_typecheck` (tsc)
    #    catches missing files via the template's named imports of
    #    webhookHandlers / adminRouter / widgetRouter / jobs. Inverse "must
    #    not emit when …" cases are dead-code drift, not catastrophic. See
    #    HANDLER_RULES.md rows 6, 7, 8.)
    widget_used = bool(widget_catalog)

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

    # State-machine soft "any SELECT exists" check dropped as tautological /
    # paranoid (HANDLER_RULES.md row 61). The full Inv 4 enforcement (read
    # prior state before deciding) is owned by the LLM `agent_rules` /
    # `bug_finder` validators.

    # SKIP-LOCKED-inside-sql.begin check dropped — not a handler-prompt rule
    # (cron.py:19 mentions FOR UPDATE SKIP LOCKED only as platform-internal
    # mechanism, never as a handler discipline). The atomic-claim idiom the
    # prompt does teach (UPDATE … RETURNING) is owned by `agent_rules` /
    # `bug_finder`. See HANDLER_RULES.md.

    # 11. Status enum cross-check: every literal value the handler writes to
    #     a dbContracts column with a declared `enum` must be in that enum.
    #     Without this, the migration emits a CHECK constraint the handler
    #     INSERT silently fails against. See Finding 6 in
    #     docs/FINDINGS_DEFERRED_4_5_6.md.
    errors.extend(_check_enum_writes(files_by_path, db_contracts or []))

    # 11b. ON CONFLICT target cross-check: every `ON CONFLICT (col1, col2)`
    #      in handler SQL must target either the table's PRIMARY KEY column(s)
    #      or a declared `uniqueConstraint.columns` set in dbContracts.
    #      Without this, Postgres raises `there is no unique or exclusion
    #      constraint matching the ON CONFLICT specification` on the first
    #      INSERT and the cron / route crashes.
    #      Documented case: image-optimizer run 2026-04-28T20-38-51 emitted
    #      `ON CONFLICT (run_id, image_id) DO NOTHING` against
    #      optimization_run_items but the migration declared no
    #      uniqueConstraint on that pair. Every cron invocation died at
    #      item-INSERT time. See HANDLER_RULES.md row 56 audit findings.
    errors.extend(_check_on_conflict_targets(files_by_path, db_contracts or []))

    # 11c. Singleton-table SELECT-without-INSERT cross-check: a settings table
    #      declared with `singleton: true` is always-empty until something
    #      inserts the first (and only) row. If the handler reads
    #      `WHERE singleton = true` but never INSERTs into the table, GET
    #      always returns zero rows and the merchant sees hardcoded defaults
    #      forever. Documented case: image-optimizer settings table read by
    #      GET /settings, written by POST /settings via UPDATE-only — first
    #      tenant boot saw defaults forever even after Save was clicked.
    #      See HANDLER_RULES.md row 100 (added this round).
    errors.extend(_check_singleton_table_has_insert(files_by_path, db_contracts or []))

    # 12. Email metadata sidecar: the ```email-metadata``` fenced JSON block
    #     that follows the bundle is required iff the handler calls
    #     platform.email.send/sendBatch. Validates presence/absence, single
    #     occurrence, JSON shape, ctaLabel+ctaUrl pairing against URL-flavored
    #     variables, and {{placeholder}} ↔ variables consistency.
    errors.extend(_check_email_sidecar(artifact, files_by_path))

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
            cols = [c.strip().strip('`"').lower() for c in col_block.split(",")]
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
            for col_name, literal in re.findall(r"\b(\w+)\s*=\s*'([^']*)'", assignment):
                col_lower = col_name.lower()
                for table, table_enums in enum_map.items():
                    if (
                        col_lower in table_enums
                        and literal not in table_enums[col_lower]
                    ):
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


# Match `INSERT INTO <table> (...) VALUES (...) ... ON CONFLICT (col1, col2)`.
# Captures table name (group 1) and the conflict-target column list (group 2).
# Order-tolerant of intervening clauses (the column list and VALUES tuple may
# span multiple lines, and INSERTs may have RETURNING / WHERE clauses before
# ON CONFLICT). The `[\s\S]*?` is non-greedy and capped by the closing `)` of
# ON CONFLICT — this won't accidentally match across statements because the
# table name in group 1 anchors each match to one INSERT.
_INSERT_ON_CONFLICT_RE = re.compile(
    r"INSERT\s+INTO\s+(\w+)\b[\s\S]*?\bON\s+CONFLICT\s*\(([^)]+)\)",
    re.IGNORECASE,
)
# Named-constraint variant: `ON CONFLICT ON CONSTRAINT <name>`. We capture
# the constraint name but don't validate it (architect's dbContracts doesn't
# carry constraint names — only the column lists). Treat as opaque-but-valid;
# if the constraint doesn't exist, deploy fails at migration-apply time and
# tsc/handler-static can't catch it. Not the same FP class as missing-target.
_INSERT_ON_CONFLICT_NAMED_RE = re.compile(
    r"INSERT\s+INTO\s+(\w+)\b[\s\S]*?\bON\s+CONFLICT\s+ON\s+CONSTRAINT\s+(\w+)",
    re.IGNORECASE,
)


def _check_on_conflict_targets(
    files_by_path: Dict[str, str],
    db_contracts: List[Dict[str, Any]],
) -> List[str]:
    """
    Cross-check: every `ON CONFLICT (col1, col2, ...)` in handler SQL must
    target a unique constraint that the migration WILL emit — i.e. the
    column set must match either:

      - the PRIMARY KEY column(s) of the table (`id` for normal tables;
        `singleton` for singleton tables), OR
      - the `uniqueConstraint.columns` list declared in dbContracts (set
        equality, order-insensitive — postgres treats them as a set), OR
      - a single column the dbContracts declares with `unique: true`
        (rare; supported for completeness).

    Without this, postgres throws `there is no unique or exclusion
    constraint matching the ON CONFLICT specification` on the first
    INSERT and the cron / route crashes before any work happens.
    Documented case: image-optimizer run 2026-04-28T20-38-51 emitted
    `ON CONFLICT (run_id, image_id)` against optimization_run_items
    with no matching uniqueConstraint declaration — every cron run
    crashed at item-INSERT time.

    Skipped silently when:
      - the INSERT targets a table not in dbContracts (template tables,
        or invented table names — those are flagged elsewhere);
      - the conflict uses `ON CONSTRAINT <name>` form (constraint-name
        validation requires DDL parsing of the migration; defer to
        deploy-time);
      - the conflict column list contains a non-identifier token (rare;
        e.g. partial-index expressions — out of scope for static).
    """
    if not db_contracts:
        return []

    # Build per-table set of valid conflict-target column-sets:
    #   { "table": [ frozenset({"id"}), frozenset({"run_id","image_id"}), ... ] }
    valid_targets: Dict[str, List[frozenset]] = {}
    for contract in db_contracts:
        table = (contract.get("table") or "").lower()
        if not table:
            continue
        targets: List[frozenset] = []

        # Singleton tables: PK is `singleton`, no `id` column.
        if contract.get("singleton") is True:
            targets.append(frozenset({"singleton"}))
        else:
            # Normal tables: any column whose constraints contains
            # PRIMARY KEY is the PK. Typically `id UUID PRIMARY KEY ...`.
            for col in contract.get("columns") or []:
                constraints = (col.get("constraints") or "").upper()
                if "PRIMARY KEY" in constraints:
                    name = (col.get("name") or "").lower()
                    if name:
                        targets.append(frozenset({name}))

        # uniqueConstraint at the table level.
        unique = contract.get("uniqueConstraint")
        if isinstance(unique, dict):
            cols = unique.get("columns") or []
            if isinstance(cols, list) and cols:
                targets.append(
                    frozenset(str(c).lower() for c in cols if isinstance(c, str))
                )

        # Inline column-level UNIQUE flag (rare in our contracts; supported
        # for completeness so we don't FP if the architect ever emits one).
        for col in contract.get("columns") or []:
            constraints = (col.get("constraints") or "").upper()
            if "UNIQUE" in constraints and "PRIMARY KEY" not in constraints:
                name = (col.get("name") or "").lower()
                if name:
                    targets.append(frozenset({name}))

        if targets:
            valid_targets[table] = targets

    errors: List[str] = []
    seen: set = set()
    for path, code in files_by_path.items():
        # Skip the named-constraint form — defer to deploy-time validation.
        # Mark those positions so the column-list scan doesn't double-flag.
        named_spans: List[tuple] = [
            (m.start(), m.end()) for m in _INSERT_ON_CONFLICT_NAMED_RE.finditer(code)
        ]

        for match in _INSERT_ON_CONFLICT_RE.finditer(code):
            # Skip if this match overlaps a named-constraint match.
            if any(s <= match.start() < e for s, e in named_spans):
                continue

            table = match.group(1).lower()
            cols_block = match.group(2)
            # Parse columns. Reject non-identifier tokens (expression
            # targets like `(lower(email))` or `WHERE deleted_at IS NULL`
            # partial-index targets — out of scope for this check).
            tokens = [c.strip().strip('`"') for c in cols_block.split(",")]
            if not all(re.fullmatch(r"[a-zA-Z_]\w*", t) for t in tokens):
                continue
            conflict_set = frozenset(t.lower() for t in tokens)

            targets = valid_targets.get(table)
            if targets is None:
                # Table not in dbContracts. Don't flag — either it's a
                # template-owned table (already forbidden by another check)
                # or an invented table (will fail other checks). Avoid
                # double-flagging.
                continue

            if conflict_set in targets:
                continue

            # Mismatch — surface it. Show what dbContracts DID declare so
            # the model can either (a) update the migration to add the
            # constraint, or (b) align the conflict target to a real one.
            key = (path, table, conflict_set)
            if key in seen:
                continue
            seen.add(key)
            declared = sorted(sorted(t) for t in targets)
            errors.append(
                f"[{path}] INSERT INTO {table} ... ON CONFLICT "
                f"({', '.join(sorted(conflict_set))}) — but dbContracts "
                f"declares no matching unique constraint or PRIMARY KEY. "
                f"Valid conflict targets for `{table}` are: {declared}. "
                f"Either add `uniqueConstraint: {{columns: "
                f"{sorted(conflict_set)}}}` to the {table} dbContracts "
                f"row (architect plan), or change the ON CONFLICT target "
                f"to one of the declared sets. Without a matching "
                f"constraint, postgres throws `there is no unique or "
                f"exclusion constraint matching the ON CONFLICT "
                f"specification` on the first INSERT."
            )

    return errors


def _check_singleton_table_has_insert(
    files_by_path: Dict[str, str],
    db_contracts: List[Dict[str, Any]],
) -> List[str]:
    """
    Cross-check: when the architect declares a `singleton: true` table AND
    the handler READs from it (`SELECT … FROM <table> WHERE singleton = true`
    or any SELECT against it), the handler MUST also have an INSERT path —
    otherwise the table is always empty on a fresh deploy and reads return
    zero rows forever. UPDATE-only settings POST handlers (the canonical
    failure pattern) silently degrade to "Save clicked → no row exists →
    UPDATE affects zero rows → GET still returns nothing → merchant sees
    hardcoded defaults forever".

    The check fires only when both reads AND no insert are observed. A
    handler that doesn't touch the singleton at all (e.g. settings read
    elsewhere) doesn't trip this — that's a different gap (dead table).
    The acceptable shapes are:
      - `INSERT INTO <table> ... VALUES (...)`
      - `INSERT INTO <table> ... ON CONFLICT (singleton) DO UPDATE …` (upsert)
      - any SQL that mentions `INSERT INTO <table>` once

    Documented case: image-optimizer run 2026-04-28T20-38-51 — settings
    table had GET/POST handlers, but POST was UPDATE-only. First-deploy
    UX bug.
    """
    if not db_contracts:
        return []

    singleton_tables: set = set()
    for contract in db_contracts:
        if contract.get("singleton") is True:
            name = (contract.get("table") or "").lower()
            if name:
                singleton_tables.add(name)

    if not singleton_tables:
        return []

    errors: List[str] = []
    for table in sorted(singleton_tables):
        # Look for any SELECT against the table — case-insensitive, allow
        # whitespace and column lists between SELECT and FROM.
        select_re = re.compile(
            rf"\bSELECT\b[\s\S]*?\bFROM\s+{re.escape(table)}\b",
            re.IGNORECASE,
        )
        insert_re = re.compile(
            rf"\bINSERT\s+INTO\s+{re.escape(table)}\b",
            re.IGNORECASE,
        )

        reads_in: List[str] = []
        has_insert = False
        for path, code in files_by_path.items():
            if select_re.search(code):
                reads_in.append(path)
            if insert_re.search(code):
                has_insert = True

        if reads_in and not has_insert:
            errors.append(
                f"singleton table `{table}` is read by handler "
                f"({reads_in[0]}) but no `INSERT INTO {table}` exists "
                f"anywhere in the bundle. The table starts empty on first "
                f"deploy, so GET reads return zero rows and the merchant "
                f"sees hardcoded defaults forever — even after the Save / "
                f"settings-write path runs (UPDATE on zero rows is a no-op). "
                f"Add an upsert path: "
                f"`INSERT INTO {table} (singleton, …) VALUES (true, …) "
                f"ON CONFLICT (singleton) DO UPDATE SET … RETURNING …` "
                f"to the settings-write route, OR seed the row at first "
                f"read with INSERT … ON CONFLICT DO NOTHING. The architect's "
                f"`singleton: true` flag means the table holds exactly one "
                f"row — the handler is responsible for ensuring that row "
                f"exists before any read returns useful data."
            )

    return errors


def _validate_ts_file(
    path: str, code: str, allowed_import_specifiers: frozenset
) -> List[str]:
    """Generic per-TypeScript-file checks applied to every emitted file."""
    errors: List[str] = []

    # (Syntactic-completeness check dropped — not a prompt rule. tsc catches
    # truncation as a syntax error with a clearer message. See
    # HANDLER_RULES.md.)

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

    # No `tenant_id` reference inside any `sql\`...\`` tagged template block.
    errors.extend(_check_no_tenant_id_in_sql(path, code))
    # No hand-rolled fetch() to Shopify (must go through shopify.* helpers).
    errors.extend(_check_no_fetch_to_shopify(path, code))
    # shopify.bulkQuery() argument is a query, not a mutation.
    errors.extend(_check_bulkquery_not_mutation(path, code))

    return errors


# ── New per-file static checks (rows 47, 70, 73 in HANDLER_RULES.md) ──────────
# Row 15 ("https:// only inside fetch()") was reclassified static → llm: the
# rule's catastrophic cases are already covered by `_check_no_fetch_to_shopify`
# (row 70) + the email-templateId rule (row 30, llm), and the standalone check
# had a high false-positive surface against JSDoc / comment / error-message
# URLs — exactly the context-dependent judgment `agent_rules` is for.


_SQL_BLOCK_RE = re.compile(r"sql\s*(?:<[^>]*>)?\s*`([^`]*)`", re.DOTALL)
# Strip postgres string literals ('…' with '' as escape) and line comments
# (-- to EOL) before searching for tenant_id, so the literal text inside a
# string ('tenant_id is forbidden') doesn't trigger a false positive.
_SQL_STRING_LITERAL_RE = re.compile(r"'(?:''|[^'])*'")
_SQL_LINE_COMMENT_RE = re.compile(r"--[^\n]*")


def _check_no_tenant_id_in_sql(path: str, code: str) -> List[str]:
    """
    Tenant scoping is search_path-driven; tables in the per-tenant schema
    do NOT carry a `tenant_id` column. A handler that references it either
    invents a non-existent column (empty SELECT / silent INSERT failure)
    or is hand-rolling tenant filtering that the platform's middleware
    already handles.

    String literals and line comments inside the SQL block are stripped
    before the search so that user-facing strings or commentary mentioning
    `tenant_id` don't false-positive.
    """
    errors: List[str] = []
    seen: set = set()
    for match in _SQL_BLOCK_RE.finditer(code):
        block = match.group(1)
        # Replace literals/comments with same-length whitespace to preserve
        # offsets so the reported line number still maps back to `code`.
        scrubbed = _SQL_STRING_LITERAL_RE.sub(lambda m: " " * len(m.group(0)), block)
        scrubbed = _SQL_LINE_COMMENT_RE.sub(lambda m: " " * len(m.group(0)), scrubbed)
        m = re.search(r"\btenant_id\b", scrubbed)
        if not m:
            continue
        # Use match.start(1) — the start of the block contents — so the
        # reported line corresponds to the tenant_id token, not to the
        # opening `sql` prefix.
        line = code.count("\n", 0, match.start(1) + m.start()) + 1
        if (path, line) in seen:
            continue
        seen.add((path, line))
        errors.append(
            f"[{path}:{line}] `sql\\`...\\`` block references `tenant_id` — "
            "the per-tenant schema does not include that column. Tenant "
            "scoping is search_path-driven; remove tenant_id from the query."
        )
    return errors


_FETCH_TO_SHOPIFY_RE = re.compile(
    r"""\bfetch\s*\(\s*['"`][^'"`]*(?:\.myshopify\.com|/admin/api/)""",
    re.IGNORECASE,
)


def _check_no_fetch_to_shopify(path: str, code: str) -> List[str]:
    """
    Hand-rolled fetch() to Shopify bypasses shopify.* helpers, which means
    no cost-based throttle handling, no GID validation, no userErrors-as-
    failure discipline, and a hand-rolled access token. Use
    shopify.graphql / shopify.graphqlPaginate / shopify.bulkQuery instead.
    """
    errors: List[str] = []
    seen: set = set()
    for match in _FETCH_TO_SHOPIFY_RE.finditer(code):
        line = code.count("\n", 0, match.start()) + 1
        if (path, line) in seen:
            continue
        seen.add((path, line))
        errors.append(
            f"[{path}:{line}] hand-rolled fetch() to Shopify is not allowed "
            "— use shopify.graphql / shopify.graphqlPaginate / "
            "shopify.bulkQuery from ../lib/shopify.js so the cost-based "
            "throttle, GID format, and userErrors discipline are enforced."
        )
    return errors


_BULK_QUERY_ARG_RE = re.compile(r"\bbulkQuery\s*\(\s*(['\"`])([\s\S]*?)\1")


def _check_bulkquery_not_mutation(path: str, code: str) -> List[str]:
    """
    shopify.bulkQuery wraps its argument in `bulkOperationRunQuery(query:)`
    — the argument must be a plain GraphQL query, never a mutation. Passing
    a mutation fails at runtime when Shopify's bulk-operation engine
    rejects the wrapped document.
    """
    errors: List[str] = []
    for match in _BULK_QUERY_ARG_RE.finditer(code):
        body = match.group(2).lstrip()
        first_word_match = re.match(r"(\w+)", body)
        if first_word_match and first_word_match.group(1).lower() == "mutation":
            line = code.count("\n", 0, match.start()) + 1
            errors.append(
                f"[{path}:{line}] shopify.bulkQuery() argument starts with "
                "`mutation` — bulkQuery only accepts GraphQL queries (the "
                "helper wraps your string in bulkOperationRunQuery "
                "internally). Use shopify.graphql() for the mutation, or a "
                "batch mutation if one exists for this op."
            )
    return errors


# ── Email metadata sidecar (artifact-level; row 33 + 35 + 36) ─────────────────


_EMAIL_SIDECAR_RE = re.compile(
    r"```email-metadata\s*\n(.*?)\n```",
    re.DOTALL,
)
_PLATFORM_EMAIL_USE_RE = re.compile(r"\bplatform\.email\.(?:send|sendBatch)\s*\(")
_TEMPLATE_PLACEHOLDER_RE = re.compile(r"\{\{(\w+)\}\}")
_SIDECAR_STRING_KEYS = ("subject", "heading", "body", "ctaLabel", "ctaUrl")


def _check_email_sidecar(artifact: str, files_by_path: Dict[str, str]) -> List[str]:
    """
    Artifact-level checks for the ```email-metadata``` sidecar:
      - Sidecar present iff handler calls platform.email.send/sendBatch.
      - Exactly one block when present.
      - JSON parses; `variables` is a list, `starterContent` is an object.
      - ctaLabel + ctaUrl paired iff any URL-flavored variable in
        `variables` (a `url` or `*Url` name).
      - `variables` ↔ `starterContent` `{{x}}` references consistent —
        every placeholder declared, every declared variable referenced.
    """
    errors: List[str] = []
    uses_email = any(
        _PLATFORM_EMAIL_USE_RE.search(code) for code in files_by_path.values()
    )
    blocks = _EMAIL_SIDECAR_RE.findall(artifact)

    if uses_email and not blocks:
        # Inline a minimal correct example in the error message itself.
        # The retry loop feeds error strings straight into the next
        # attempt's user prompt via crew._build_prev_errors. A persistent
        # failure mode (cart-recovery run 2026-04-28: 3 retries in a row
        # all dropped the sidecar despite the rule being in the capability
        # JIT block) suggested the model was deprioritizing a late-prompt
        # rule under bundle-emission cognitive load. The fix has two
        # halves: requirement promoted into HARNESS_BASE next to the
        # ===FILE:=== rules (so it's encountered during the same pass
        # that produces the bundle), AND this enriched error string so
        # the retry feedback shows the format inline rather than naming
        # a rule the model has already proven it doesn't act on.
        errors.append(
            "handler calls platform.email.send/sendBatch but no "
            "```email-metadata``` sidecar block was emitted. After your "
            "final ===END=== marker, append exactly ONE fenced block in "
            "this format (replace placeholders with the actual camelCase "
            "keys you pass in `data: {...}`):\n"
            "```email-metadata\n"
            "{\n"
            '  "variables": ["customerName", "actionUrl"],\n'
            '  "starterContent": {\n'
            '    "subject": "{{customerName}}, an action is waiting",\n'
            '    "body": "Quick reminder — tap below to continue.",\n'
            '    "ctaLabel": "Continue",\n'
            '    "ctaUrl": "{{actionUrl}}"\n'
            "  }\n"
            "}\n"
            "```\n"
            "Rules: (1) `variables` MUST equal the camelCase keys you "
            "pass in every `data: {...}` across ALL email send call "
            "sites, deduplicated. (2) Every `{{token}}` referenced "
            "anywhere in starterContent MUST be in the variables array, "
            "and every variable MUST be referenced — no orphans on "
            "either side. (3) Emit ONE block even across multiple send "
            "call sites — merge into a single variables array."
        )
        return errors
    if not uses_email and blocks:
        errors.append(
            "```email-metadata``` sidecar block was emitted but the handler "
            "does not call platform.email.send/sendBatch — remove the "
            "sidecar."
        )
        return errors
    if len(blocks) > 1:
        errors.append(
            "emit exactly ONE ```email-metadata``` sidecar block; found "
            f"{len(blocks)}. Merge variable lists and starterContent into "
            "a single block."
        )
        return errors
    if not blocks:
        return errors

    try:
        data = json.loads(blocks[0])
    except json.JSONDecodeError as err:
        errors.append(f"```email-metadata``` sidecar block is not valid JSON: {err}")
        return errors

    variables = data.get("variables") or []
    starter = data.get("starterContent") or {}
    if not isinstance(variables, list):
        errors.append(
            "```email-metadata``` sidecar `variables` must be an array of "
            "camelCase strings."
        )
        return errors
    if not isinstance(starter, dict):
        errors.append(
            "```email-metadata``` sidecar `starterContent` must be an object."
        )
        return errors

    # CTA-pairing check (ctaLabel + ctaUrl together iff URL-flavored variable)
    # dropped as non-catastrophic — broken CTA renders as missing button or
    # dangling label; merchant edits this in the Email tab anyway. See
    # HANDLER_RULES.md row 35.

    # variables ↔ {{placeholder}} consistency.
    referenced: set = set()
    for key in _SIDECAR_STRING_KEYS:
        val = starter.get(key)
        if isinstance(val, str):
            for m in _TEMPLATE_PLACEHOLDER_RE.finditer(val):
                referenced.add(m.group(1))
    declared = {v for v in variables if isinstance(v, str)}

    orphan_refs = sorted(referenced - declared)
    if orphan_refs:
        errors.append(
            "```email-metadata``` sidecar references {{...}} placeholder(s) "
            f"{orphan_refs} that are not in the `variables` array — every "
            "placeholder must be declared."
        )
    unused_decls = sorted(declared - referenced)
    if unused_decls:
        errors.append(
            f"```email-metadata``` sidecar declares variable(s) "
            f"{unused_decls} that are not referenced anywhere in "
            "`starterContent` — every declared variable must be used."
        )

    return errors


def _validate_webhook_handlers(code: str, plan_topics: List[str]) -> List[str]:
    errors: List[str] = []

    # Handlers must never write responses — the template router owns that.
    if re.search(r"\bres\s*\.\s*(json|status|send)\b", code):
        errors.append(
            "[src/routes/webhook-handlers.ts] handlers must not call "
            "res.json/res.status/res.send — the template router owns all "
            "response writes; throw to signal failure"
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

    for entry in admin_catalog:
        method = (entry.get("method") or "POST").lower()
        path = entry.get("path", "")
        if not path:
            continue
        # adminRouter.<method>("<path>", ...). The handler prompt teaches the
        # dot form only; bracket-form (adminRouter[method](...)) is not
        # generated and intentionally not matched here — adding it would risk
        # false positives on unrelated bracket access elsewhere.
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

    # Require at least one job in the map. Missing-export is caught by tsc
    # (template's cron-runner imports `jobs` by name).
    has_any_job = bool(
        re.search(r"""\bjobs\b[^=]*=\s*\{[^}]*\w+\s*:""", code, re.DOTALL)
    )
    if not has_any_job:
        errors.append("[src/routes/cron.ts] jobs map must include at least one entry")

    return errors
