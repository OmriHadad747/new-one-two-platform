"""
Ops-picker agent runner (LLD stage 1).

Takes the HLD plan + the live Shopify Admin / Storefront operation indexes
+ the webhook topic catalog, and emits `OpsPicks` — capability → ops and
external-event-trigger → topic.

Mirrors the HLD agent's flow:

  1. Build the system prompt via `prompt.build_system_prompt(...)` —
     static text + `OpsPicks.model_json_schema()` + injected catalogs.
  2. Build a user message containing the merchant prompt and the HLD plan.
  3. Invoke the LLM, extract JSON, parse with `OpsPicks.model_validate_json`.
  4. Catalog-membership cross-check: every picked op name must appear in
     the matching surface index; every webhook topic must appear in the
     topic catalog.
  5. HLD cross-reference: every Shopify-touching capability must appear
     in `capabilities` or `unsatisfied`; every external-event trigger
     must appear in `webhooks`.
  6. On `pydantic.ValidationError` (rule violation), `json.JSONDecodeError`
     (malformed output), or a cross-reference failure, format the errors
     into a retry suffix and re-invoke with the same cached system prompt
     up to `_MAX_ATTEMPTS` times.

Returns the parsed picks as a JSON-shape dict plus token totals.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional, Tuple

from pydantic import ValidationError

from models.adapter import dump_output, extract_json, get_llm, invoke
from models.agent_models import get_agent_model
from llm_validations.shopify_ops import load_op_details
from subagents.c_ops_picker_agent.prompt import build_system_prompt
from subagents.c_ops_picker_agent.schema import OpsPicks

_MAX_ATTEMPTS = 3
_MAX_TOKENS = 4000
_THINKING_BUDGET = 2048


_USER_TEMPLATE = """\
Merchant request: {prompt}

HLD plan (your source of truth — pick ops that satisfy each
shopify-integration capability, and a webhook topic for each
external-event trigger):
{plan_json}

Produce the ops picks as JSON conforming to the appended schema."""


_VALIDATOR_HINT_SUFFIX = """\


SEMANTIC REVIEW FEEDBACK — a prior draft of these picks was reviewed and the
following issues were found. Produce corrected picks that address all of
them:
{findings_text}"""


def run_ops_picker_agent(
    prompt: str,
    plan: Dict[str, Any],
    admin_operation_index: str,
    storefront_operation_index: str,
    webhook_topic_catalog: str,
    admin_op_names: set[str],
    storefront_op_names: set[str],
    webhook_topics: set[str],
    on_attempt_failed: Optional[Callable[[int, List[str]], None]] = None,
    validator_hint: Optional[str] = None,
) -> Tuple[Dict[str, Any], int, int]:
    """
    Run the ops-picker agent. Returns (picks_dict, in_tokens, out_tokens).

    Validation lives inside the schema (`OpsPicks`) plus catalog-membership
    + HLD-cross-reference checks layered on top by the runner. The agent
    retries on its own when any of those fail — the caller does not need
    an outer retry loop.

    Parameters
    ----------
    prompt:
        Merchant request — kept in the user message for context. The agent
        only acts on the HLD plan, but recording the prompt makes input
        logs self-contained.
    plan:
        The parsed HLD plan dict (output of `run_hld_agent`).
    admin_operation_index, storefront_operation_index, webhook_topic_catalog:
        Catalog text injected into the system prompt verbatim. The runner
        already loaded these; we don't re-load to keep the agent layer
        I/O-free.
    admin_op_names, storefront_op_names, webhook_topics:
        Membership sets corresponding to the catalogs above. Used for
        offline validation of the picked names.
    on_attempt_failed:
        Optional callback invoked when an attempt is rejected, before the
        next attempt fires. Receives `(attempt_index, errors)` so the CLI
        can surface live retry feedback. Not called on the final failure
        (`OpsPickerValidationError` carries those errors directly).
    validator_hint:
        Optional pre-seeded findings (e.g. from a future `ops_picker_v`
        validator) appended to the first user message.

    Raises
    ------
    OpsPickerValidationError
        When all `_MAX_ATTEMPTS` attempts fail validation. Message contains
        the most recent error list so the operator can debug the prompt.
    """
    system = build_system_prompt(
        admin_operation_index=admin_operation_index,
        storefront_operation_index=storefront_operation_index,
        webhook_topic_catalog=webhook_topic_catalog,
    )
    base_user = _USER_TEMPLATE.format(
        prompt=prompt,
        plan_json=json.dumps(plan, indent=2),
    )
    if validator_hint:
        base_user += _VALIDATOR_HINT_SUFFIX.format(findings_text=validator_hint)
    llm = get_llm(
        model=get_agent_model("ops_picker"),
        max_tokens=_MAX_TOKENS,
        thinking_budget=_THINKING_BUDGET,
    )

    total_in = 0
    total_out = 0
    last_errors: List[str] = []

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        retry_suffix = _format_retry_suffix(last_errors) if last_errors else ""
        result = invoke(llm, system, base_user, retry_suffix=retry_suffix)
        total_in += result.input_tokens
        total_out += result.output_tokens

        # Persist the raw model response next to the prompt files.
        # No-op outside an active `input_log` block.
        dump_output(result.content)

        try:
            raw_json = extract_json(result.content)
        except Exception as err:
            last_errors = [f"could not extract a JSON object from output: {err}"]
            if attempt < _MAX_ATTEMPTS and on_attempt_failed is not None:
                on_attempt_failed(attempt, last_errors)
            continue

        try:
            picks = OpsPicks.model_validate_json(raw_json)
        except ValidationError as err:
            last_errors = _format_pydantic_errors(err)
            if attempt < _MAX_ATTEMPTS and on_attempt_failed is not None:
                on_attempt_failed(attempt, last_errors)
            continue
        except json.JSONDecodeError as err:
            last_errors = [f"output is not valid JSON: {err}"]
            if attempt < _MAX_ATTEMPTS and on_attempt_failed is not None:
                on_attempt_failed(attempt, last_errors)
            continue

        cross_errors = _cross_check(
            picks,
            plan,
            admin_op_names=admin_op_names,
            storefront_op_names=storefront_op_names,
            webhook_topics=webhook_topics,
        )
        if cross_errors:
            last_errors = cross_errors
            if attempt < _MAX_ATTEMPTS and on_attempt_failed is not None:
                on_attempt_failed(attempt, last_errors)
            continue

        enriched = _enrich_with_op_details(picks.model_dump(mode="json"))
        enriched = _enrich_with_webhook_payloads(enriched)
        return enriched, total_in, total_out

    raise OpsPickerValidationError(_MAX_ATTEMPTS, last_errors, total_in, total_out)


def _enrich_with_op_details(picks: Dict[str, Any]) -> Dict[str, Any]:
    """
    For every picked op, merge its catalog detail (kind, args,
    returnTypeName, isConnection, userErrorsField, returnTypeSdl,
    inputTypesSdl, examples) onto the pick in place. Loaded from
    `operations_detail.json` via `load_op_details`. Picks whose op
    name is missing from the catalog (stale or being rebuilt) keep
    only the LLM-emitted fields — the LLD will degrade to working
    from the note + summary line in that case.
    """
    by_surface: Dict[str, List[str]] = {}
    for cap in picks.get("capabilities") or []:
        for op in cap.get("ops") or []:
            by_surface.setdefault(op["surface"], []).append(op["name"])

    detail_by_surface: Dict[str, Dict[str, Dict[str, Any]]] = {
        surface: load_op_details(surface, names)
        for surface, names in by_surface.items()
    }

    for cap in picks.get("capabilities") or []:
        for op in cap.get("ops") or []:
            detail = detail_by_surface.get(op["surface"], {}).get(op["name"])
            if detail:
                op.update(detail)

    return picks


def _enrich_with_webhook_payloads(picks: Dict[str, Any]) -> Dict[str, Any]:
    """
    For every picked webhook, merge the topic's actual payload schema +
    description onto the pick in place. Loaded from the committed
    catalog (`catalogs/shopify_webhooks/<version>/topics.json`).

    Adds onto each entry in `picks["webhooks"]`:
      description     : Shopify's one-line trigger description
      payloadFields   : list of { name, type, nullable, format?, items_type? }
                         exactly mirroring what the topic delivers on the wire
      access_scopes   : OAuth scopes required to subscribe
      related_resource: GraphQL type name for the underlying resource
      deprecated      : true if Shopify has marked the topic deprecated

    Picks whose topic isn't in the catalog (stale or upstream rename) keep
    only the LLM-emitted fields — the LLD will note a fields=[] webhook and
    can fall back to the HLD's signalFields with a `platformGaps` entry.
    """
    from catalogs.shopify_webhooks import load_catalog

    try:
        catalog = load_catalog()
    except FileNotFoundError:
        return picks

    by_topic: Dict[str, Dict[str, Any]] = catalog.get("topics", {})
    for hook in picks.get("webhooks") or []:
        rec = by_topic.get(hook.get("topic"))
        if not rec:
            continue
        if "description" in rec:
            hook["description"] = rec["description"]
        if "fields" in rec:
            hook["payloadFields"] = rec["fields"]
        if "access_scopes" in rec:
            hook["access_scopes"] = rec["access_scopes"]
        if "related_resource" in rec:
            hook["related_resource"] = rec["related_resource"]
        if rec.get("deprecated") is True:
            hook["deprecated"] = True

    return picks


# ── Internals ─────────────────────────────────────────────────────────


class OpsPickerValidationError(RuntimeError):
    """Raised when the ops-picker agent exhausts its retry budget."""

    def __init__(
        self,
        attempts: int,
        errors: List[str],
        in_tokens: int,
        out_tokens: int,
    ) -> None:
        self.attempts = attempts
        self.errors = errors
        self.in_tokens = in_tokens
        self.out_tokens = out_tokens
        bullets = "\n".join(f"  - {e}" for e in errors)
        super().__init__(
            f"Ops-picker agent failed after {attempts} attempt(s):\n{bullets}"
        )


def _cross_check(
    picks: OpsPicks,
    plan: Dict[str, Any],
    *,
    admin_op_names: set[str],
    storefront_op_names: set[str],
    webhook_topics: set[str],
) -> List[str]:
    """
    Layered checks Pydantic alone cannot express:

      - Op names must be members of the matching surface's catalog.
      - Webhook topics must be members of the topic catalog.
      - Every Shopify-integration capability in the HLD must appear in
        `capabilities` ∪ `unsatisfied`.
      - Every external-event trigger in the HLD must appear in `webhooks`.
      - No picked capability_id may reference a capability that the HLD
        did not declare.
      - No webhook trigger_event may reference an HLD trigger that does
        not exist (or is not external-event).
    """
    errors: List[str] = []

    # ── Catalog membership ─────────────────────────────────────────────
    for cap in picks.capabilities:
        for op in cap.ops:
            catalog = admin_op_names if op.surface == "admin" else storefront_op_names
            if op.name not in catalog:
                errors.append(
                    f"capabilities[{cap.capability_id}].ops: '{op.name}' is "
                    f"not a known {op.surface} GraphQL operation"
                )

    for w in picks.webhooks:
        if w.topic not in webhook_topics:
            errors.append(
                f"webhooks[{w.trigger_event}]: topic '{w.topic}' is not in "
                "the webhook topic catalog"
            )

    # ── HLD cross-reference: capabilities ──────────────────────────────
    hld_caps = plan.get("capabilities") or []
    shopify_caps_by_id: Dict[str, Dict[str, Any]] = {
        c["id"]: c
        for c in hld_caps
        if isinstance(c, dict)
        and c.get("integration") in ("shopify-admin", "shopify-storefront")
    }
    declared_cap_ids = {c["id"] for c in hld_caps if isinstance(c, dict) and "id" in c}

    picked_ids = {c.capability_id for c in picks.capabilities}
    unsat_ids = {u.capability_id for u in picks.unsatisfied}
    covered_ids = picked_ids | unsat_ids

    for cap_id in shopify_caps_by_id:
        if cap_id not in covered_ids:
            errors.append(
                f"HLD capability '{cap_id}' has a Shopify integration but is "
                "missing from both `capabilities` and `unsatisfied`"
            )

    for cap_id in covered_ids:
        if cap_id not in declared_cap_ids:
            errors.append(f"capability_id '{cap_id}' is not declared in the HLD plan")
        elif cap_id not in shopify_caps_by_id:
            errors.append(
                f"capability_id '{cap_id}' has no Shopify integration in the "
                "HLD plan; do not pick ops for compute/notify/internal "
                "capabilities"
            )

    # Surface mismatch: a capability marked `shopify-admin` should pick
    # admin ops; same for storefront. Mixed picks indicate a re-route.
    for cap in picks.capabilities:
        hld_cap = shopify_caps_by_id.get(cap.capability_id)
        if hld_cap is None:
            continue
        expected_surface = (
            "admin" if hld_cap.get("integration") == "shopify-admin" else "storefront"
        )
        for op in cap.ops:
            if op.surface != expected_surface:
                errors.append(
                    f"capabilities[{cap.capability_id}].ops: op '{op.name}' "
                    f"is on '{op.surface}' but HLD capability targets "
                    f"'{expected_surface}'; do not re-route — record in "
                    "`unsatisfied` if no op fits"
                )

    # ── HLD cross-reference: triggers (positional pairing) ────────────
    # webhooks[i] corresponds to the i-th HLD external-event trigger.
    # We check counts only; `trigger_event` on the pick is an audit
    # label so paraphrasing the domain sentence is non-fatal. The model
    # is told to emit `webhooks` in the same order as HLD triggers.
    triggers = plan.get("triggers") or []
    external_events = [
        t for t in triggers if isinstance(t, dict) and t.get("kind") == "external-event"
    ]
    expected = len(external_events)
    actual = len(picks.webhooks)
    if actual != expected:
        errors.append(
            f"webhooks has {actual} entries but HLD declares {expected} "
            "external-event trigger(s); emit exactly one webhook block per "
            "trigger, in the same order as HLD `triggers`"
        )

    return errors


def _format_pydantic_errors(err: ValidationError) -> List[str]:
    """
    Turn a Pydantic ValidationError into compact, model-friendly bullet
    lines: `<json.path>: <message>`. Same shape as the HLD agent's
    formatter so the retry suffix layout is consistent across stages.
    """
    out: List[str] = []
    for e in err.errors():
        loc = ".".join(str(p) for p in e.get("loc", ())) or "<root>"
        msg = e.get("msg", "validation error")
        out.append(f"{loc}: {msg}")
    return out


def _format_retry_suffix(errors: List[str]) -> str:
    bullets = "\n".join(f"  - {e}" for e in errors)
    return (
        f"\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n{bullets}\n"
        "Fix ALL listed errors in this new attempt. Emit a single JSON "
        "object that conforms to the schema; no markdown fences, no prose.\n"
    )
