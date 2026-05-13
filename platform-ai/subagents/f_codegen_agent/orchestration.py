"""
Codegen toolkit shared by every codegen consumer.

Public API
----------
  run_codegen_parallel(...)      Fan out the generator registry in parallel.
  validate_artifacts(...)        Static + cross + GraphQL + tsc validators.
  _revision_locked_artifacts(.)  Decide which artifacts revision may rewrite.
  _DB_BROKEN_ARTIFACTS           Finding-artifact set that unlocks db + handler.
  _BACKEND_OPEN_ARTIFACTS        Finding-artifact set that keeps handler unlocked.
  _MAX_RETRIES                   Total codegen attempts (1 initial + 2 retries).

Consumers
---------
- `cli/pipeline_local.py` runs the interactive CLI flow.
- `crews/feature_generator/crew.py` runs the production API pipeline.

Both share these primitives so codegen behaviour is identical regardless
of caller. CLI-specific concerns (spinners, on-disk persistence, resume
state) and API-specific concerns (progress events, contract publishing)
stay in their respective shells.

The leading-underscore names are preserved verbatim from the previous
home in `crews/feature_generator/crew.py` so the existing call sites + the
revision-locking tests keep working unchanged.
"""

from __future__ import annotations

import contextvars
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Tuple

from models.adapter import current_input_log_run_dir, input_log
from subagents.base import CodegenContext, Generator
from subagents.f_codegen_agent.cross_admin_backend import (
    validate_admin_backend_contract,
)
from subagents.f_codegen_agent.cross_widget_backend import (
    validate_widget_backend_contract,
)
from subagents.registry import GENERATORS

log = logging.getLogger(__name__)


# ── Retry / locking constants ──────────────────────────────────────────

_MAX_RETRIES = 3  # total codegen attempts (1 initial + 2 retries)

# Finding-artifact sets that drive revision-locking policy.
#
# `artifact == "db"` means the migration itself is broken (missing tables/
# columns) — unlock both so the revision agent fixes both together.
_DB_BROKEN_ARTIFACTS: FrozenSet[str] = frozenset({"db"})

# `artifact == "backend"` means a handler-side problem on top of a correct
# migration — lock migration, fix the handler. `migration` is NOT in this
# set because a migration finding is already handled by
# `_DB_BROKEN_ARTIFACTS` above. Widget / admin-only findings fall through
# to the default (lock both backends, fix the frontend). Plan-level
# findings are informational — revision can't re-run the architect, so
# they fall through too.
_BACKEND_OPEN_ARTIFACTS: FrozenSet[str] = frozenset({"backend"})


# ── Revision-locking policy ────────────────────────────────────────────


def _revision_locked_artifacts(issues: List[Dict]) -> FrozenSet[str]:
    """
    Determine which artifacts the revision agent must treat as read-only based on
    which LLM-validator findings fired. The findings come from the unified
    Finding shape produced by subagents.g_codegen_v_agent (every finding carries an
    `artifact` field).

    Locking policy (single field, no Q-key categories):
    - artifact == "db": migration itself is broken (missing table /
      missing column) — unlock both so the revision can add the missing
      schema AND adjust the handler in one pass.
    - artifact == "backend": backend problem — lock migration (it's the
      schema ground truth), fix the handler.
    - artifact in {"storefront", "admin_ui"}: frontend misalignment — handler
      and migration are the contract; fix the frontend, keep them locked.

    Plan-level findings never reach this function — `_phase_validator`
    filters them before invoking revision (revision can't re-run the
    architect, so plan issues short-circuit the loop with a warning log
    rather than wasting a revision pass on the wrong artifact).

    Invariant: this function is only called after handler and migration have already
    passed static validation in the codegen loop. If that invariant ever breaks, the
    lock could paper over a real backend bug — revisit if backend static validation
    is weakened or bypassed.
    """
    artifacts = {i.get("artifact") for i in issues if i.get("artifact")}

    if artifacts & _DB_BROKEN_ARTIFACTS:
        # Migration itself is incomplete — unlock both so the revision fixes both.
        return frozenset()

    if artifacts & _BACKEND_OPEN_ARTIFACTS:
        # Handler misaligns with a correct migration — lock migration, fix handler.
        return frozenset({"db"})

    # Frontend-only misalignment — handler is ground truth, fix storefront/admin_ui.
    return frozenset({"backend", "db"})


# ── Parallel codegen ───────────────────────────────────────────────────


# Error-message markers that mean the handler's failure is a cross-artifact
# field-contract break (not a handler-only bug like missing npmPackages or a
# forbidden setInterval). Used by `_plan_codegen_batch` to decide whether
# to coupled-retry storefront/admin_ui alongside a backend retry.
_CONTRACT_ERROR_MARKERS = (
    "widget route",
    "admin route",
    "widget sends",
    "admin UI sends",
    "ctx.widgetBody",
    "ctx.adminBody",
    "destructures",
    "requestShape",
    "responseShape",
    "field name",
)


def _plan_codegen_batch(
    *,
    is_storefront: bool,
    is_admin_ui: bool,
    error_map: Dict[str, List[str]],
    artifacts: Dict[str, str],
) -> List[Generator]:
    """
    Decide which generators to (re)run this attempt and apply the coupled-retry
    heuristic. Mutates error_map in place to add coupled-retry hints.

    Returns the Generator list to invoke. Shared by parallel (first attempt)
    and sequential (retry) paths so both use the same coupled-retry logic.

    Coupled retries: if the backend is regenerating AND its errors indicate
    a field-contract break, storefront / admin_ui must be regenerated
    alongside so both sides realign. A backend retry caused by an unrelated
    issue (missing npmPackages, forbidden setInterval, etc.) does not touch
    the body shape — re-running storefront / admin_ui in that case would
    burn Sonnet tokens with no benefit.

    Pairs enforced:
      backend ↔ storefront   (storefront_backend, storefront_backend_admin)
      backend ↔ admin_ui    (backend_admin, storefront_backend_admin)
    """
    to_run: List[Generator] = []
    for name, gen in GENERATORS.items():
        if name == "storefront" and not is_storefront:
            continue
        if name == "admin_ui" and not is_admin_ui:
            continue
        if name in error_map or name not in artifacts:
            to_run.append(gen)

    if not artifacts:
        return to_run  # first run — no coupling possible

    backend_errs = error_map.get("backend", [])
    handler_contract_broken = any(
        any(marker in err for marker in _CONTRACT_ERROR_MARKERS) for err in backend_errs
    )
    to_run_names = {gen.name for gen in to_run}
    coupled_pairs: List[tuple] = []
    if is_storefront:
        coupled_pairs.append(
            (
                "backend",
                "storefront",
                "Re-generating to stay in sync with the handler. "
                "Ensure every host.call() field name exactly matches the widgetApiCatalog requestShape.",
            )
        )
    if is_admin_ui:
        coupled_pairs.append(
            (
                "backend",
                "admin_ui",
                "Re-generating to stay in sync with the handler. "
                "Ensure every bridge.call() field name exactly matches the adminApiCatalog requestShape.",
            )
        )
    for a, b, hint in coupled_pairs:
        pair = {a, b}
        if not (pair & to_run_names):
            continue  # neither side is running — nothing to couple
        if not handler_contract_broken:
            log.info(
                "codegen: skipping coupled retry of %s — handler errors are not contract-related",
                ", ".join(sorted(pair - to_run_names)),
            )
            continue
        for name in pair - to_run_names:
            if name in GENERATORS and name in artifacts:
                error_map.setdefault(name, [hint])
                to_run.append(GENERATORS[name])
                to_run_names.add(name)

    return to_run


def _build_prev_errors(
    name: str,
    cumulative_errors: Dict[str, List[str]],
    error_map: Dict[str, List[str]],
) -> Optional[List[str]]:
    """
    Build the previous_errors list passed to a generator on retry.

    Union of cumulative_errors (every unique error seen across all attempts)
    and the current attempt's error_map (which also carries any coupled-retry
    hints injected by _plan_codegen_batch). Deduped, ordered:
    cumulative first, then any new items from error_map.
    """
    merged: List[str] = []
    seen: set[str] = set()
    for err in (cumulative_errors.get(name) or []) + (error_map.get(name) or []):
        if err not in seen:
            merged.append(err)
            seen.add(err)
    return merged or None


def _build_codegen_context(
    base_ctx: CodegenContext,
    *,
    previous_errors: Optional[List[str]],
) -> CodegenContext:
    """Build the per-generator CodegenContext for one invocation."""
    return CodegenContext(
        intent=base_ctx.intent,
        plan=base_ctx.plan,
        lld=base_ctx.lld,
        platform_api_catalog=base_ctx.platform_api_catalog,
        previous_errors=previous_errors,
        prior_backend_code=base_ctx.prior_backend_code,
        prior_storefront_code=base_ctx.prior_storefront_code,
        prior_db_sql=base_ctx.prior_db_sql,
        prior_admin_ui_code=base_ctx.prior_admin_ui_code,
    )


def run_codegen_parallel(
    base_ctx: CodegenContext,
    *,
    is_storefront: bool,
    is_admin_ui: bool,
    error_map: Dict[str, List[str]],
    cumulative_errors: Dict[str, List[str]],
    artifacts: Dict[str, str],
    on_start: Optional[Callable[[str], None]] = None,
    on_done: Optional[Callable[[str, int, int, int, int, int], None]] = None,
) -> Tuple[Dict[str, str], Dict[str, Tuple[int, int, int, int]]]:
    """
    Run generators in parallel via ThreadPoolExecutor. Used for the first codegen
    attempt where no peer code exists yet — running concurrently is strictly
    faster since the generators cannot inform each other on the first pass.

    Only generators that either have errors (retry path) or have not yet produced
    an artifact (first run) are executed. Generators whose artifacts are clean are
    skipped — their existing output is preserved in the returned dict.

    error_map drives which generators re-run and the coupled-retry heuristic.
    cumulative_errors is the union of every unique error a generator has produced
    across all prior attempts — it's what gets passed to the model as
    previous_errors so later retries have the full history, not just the
    most recent failures.

    Returns (artifacts, per_agent_tokens) — tokens dict only contains keys for
    generators that actually ran on this invocation. Each tuple is
    (input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) so
    the CLI can show cache-hit ratio on retries within the 5-min cache TTL.
    """
    to_run = _plan_codegen_batch(
        is_storefront=is_storefront,
        is_admin_ui=is_admin_ui,
        error_map=error_map,
        artifacts=artifacts,
    )
    if not to_run:
        return artifacts, {}

    per_agent_tokens: Dict[str, Tuple[int, int, int, int]] = {}
    # Capture each generator's ctx so we can read side-band outputs
    # (currently just BackendGenerator's backend_email_metadata) after the
    # future resolves. The per-call ctx is distinct from base_ctx — base_ctx
    # lives for the whole pipeline; these are one-shot per generator call.
    ctx_by_gen: Dict[str, CodegenContext] = {
        gen.name: _build_codegen_context(
            base_ctx,
            previous_errors=_build_prev_errors(gen.name, cumulative_errors, error_map),
        )
        for gen in to_run
    }

    # Wrap each generator call to emit start/done callbacks with wall-clock
    # timing. Callbacks run on whichever thread finished — safe for the CLI's
    # multi-line spinner (Python print is atomic at the line level and the
    # spinner coordinates via a module-level dict it reads, not prints from).
    #
    # If an input_log() block is active in the parent (chat_local.py), we
    # re-enter it with a generator-specific agent name so each generator's
    # prompt lands in inputs/codegen_<gen>/attempt_N/ rather than colliding
    # under one shared dir. The pool boundary is crossed via copy_context()
    # at submit time below — without it, ContextVar state set on the main
    # thread is invisible to the workers.
    def _wrapped(gen_name: str, ctx: CodegenContext):
        if on_start is not None:
            on_start(gen_name)
        started = time.monotonic()
        parent_run_dir = current_input_log_run_dir()
        if parent_run_dir is not None:
            with input_log(f"codegen_{gen_name}", parent_run_dir):
                artifact, in_tok, out_tok, cache_r, cache_c = _registry_by_name[
                    gen_name
                ].generate(ctx)
        else:
            artifact, in_tok, out_tok, cache_r, cache_c = _registry_by_name[
                gen_name
            ].generate(ctx)
        if on_done is not None:
            ms = int((time.monotonic() - started) * 1000)
            on_done(gen_name, ms, in_tok, out_tok, cache_r, cache_c)
        return gen_name, artifact, in_tok, out_tok, cache_r, cache_c

    _registry_by_name = {gen.name: gen for gen in to_run}

    # Each submission gets its own context copy — Context.run() is single-use
    # per Context, so a fresh copy_context() per submit is required to avoid
    # 'cannot enter context: already entered' when workers run concurrently.
    with ThreadPoolExecutor(max_workers=len(to_run)) as pool:
        futures = [
            pool.submit(
                contextvars.copy_context().run,
                _wrapped,
                gen.name,
                ctx_by_gen[gen.name],
            )
            for gen in to_run
        ]
        # Use as_completed so on_done fires in actual completion order; the
        # returned dicts still key by name, so callers that only care about
        # the final result are unaffected by ordering.
        for future in as_completed(futures):
            name, artifact, in_tok, out_tok, cache_r, cache_c = future.result()
            artifacts[name] = artifact
            per_agent_tokens[name] = (in_tok, out_tok, cache_r, cache_c)

    # Propagate BackendGenerator's side-band email metadata onto base_ctx so
    # downstream phases (_publish_success → Bundle construction) can read it
    # without threading extra return values through every pipeline layer.
    backend_ctx = ctx_by_gen.get("backend")
    if backend_ctx is not None and backend_ctx.backend_email_metadata is not None:
        base_ctx.backend_email_metadata = backend_ctx.backend_email_metadata
    if backend_ctx is not None and backend_ctx.backend_raw_response is not None:
        base_ctx.backend_raw_response = backend_ctx.backend_raw_response

    return artifacts, per_agent_tokens


# ── Validation ─────────────────────────────────────────────────────────


def validate_artifacts(
    artifacts: Dict[str, str],
    ctx: CodegenContext,
    is_storefront: bool,
    is_admin_ui: bool,
) -> Dict[str, List[str]]:
    """
    Run each generator's validate() on its artifact, then run cross-artifact checks.

    Returns {generator_name: [errors]} for every generator that failed.
    An empty dict means all artifacts passed validation.
    """
    error_map: Dict[str, List[str]] = {}
    for name, gen in GENERATORS.items():
        if name == "storefront" and not is_storefront:
            continue
        if name == "admin_ui" and not is_admin_ui:
            continue
        errs = gen.validate(artifacts.get(name, ""), ctx)
        if errs:
            error_map[name] = errs

    # Cross-artifact field-name check: always run for storefront / admin
    # apps. Source the per-route method from the LLD's httpRoutes — the
    # validator branches on it (GET routes' fields land in req.query;
    # POST routes' fields land in req.body — the host.call / bridge.call
    # SDK encodes accordingly).
    http_routes = (ctx.lld or {}).get("httpRoutes") or {}

    def _to_method_catalog(routes: Any) -> List[Dict[str, str]]:
        return [
            {
                "path": r.get("path", ""),
                "method": (r.get("method") or "POST").upper(),
            }
            for r in (routes or [])
            if isinstance(r, dict)
        ]

    if is_storefront:
        for gen_name, errs in validate_widget_backend_contract(
            artifacts.get("storefront", ""),
            artifacts.get("backend", ""),
            _to_method_catalog(http_routes.get("widget")),
        ).items():
            if errs:
                error_map.setdefault(gen_name, []).extend(errs)

    # Admin UI ↔ handler cross-artifact check.
    if is_admin_ui:
        for gen_name, errs in validate_admin_backend_contract(
            artifacts.get("admin_ui", ""),
            artifacts.get("backend", ""),
            _to_method_catalog(http_routes.get("admin")),
        ).items():
            if errs:
                error_map.setdefault(gen_name, []).extend(errs)

    # GraphQL schema gate — extract every shopify.{graphql,graphqlPaginate,
    # bulkQuery,storefront}(`...`) query string and validate it against the
    # committed Shopify GraphQL catalog. Catches typo'd field names, wrong
    # arg types, missing required args, and deprecated field usage that the
    # regex layer can't see. Runs only when the regex/contract checks pass —
    # broken bundles produce noisy parse errors with no extra signal.
    if "backend" not in error_map:
        from subagents.f_codegen_agent.backend_agent.graphql_check import (
            validate_backend_graphql,
        )

        graphql_errors = validate_backend_graphql(artifacts.get("backend", ""))
        if graphql_errors:
            error_map["backend"] = graphql_errors

    # tsc --noEmit gate. Run only when the cheap regex/contract checks
    # already pass for the handler — if the bundle has obvious bugs, tsc's
    # downstream errors won't add signal and just burn time. When the gate
    # finds problems, set the handler bucket (handler was clean up to this
    # point, so there are no prior entries to merge) so the retry loop
    # regenerates the handler with tsc messages as feedback.
    if "backend" not in error_map:
        from subagents.f_codegen_agent.backend_agent.typecheck import (
            validate_backend_typecheck,
        )

        tsc_errors = validate_backend_typecheck(artifacts.get("backend", ""))
        if tsc_errors:
            error_map["backend"] = tsc_errors

    return error_map
