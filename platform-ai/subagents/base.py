"""
Base abstractions for all code-generation sub-agents.

Every generator in the pipeline implements the Generator ABC:

  name               — stable identifier used as the artifacts dict key and agent_models.py key
  max_tokens         — output token budget (default 2048, override when needed)
  system_prompt()    — static system prompt (defines constraints + output format)
  user_prompt(ctx)   — dynamic user prompt built from CodegenContext
  parse(raw)         — post-process raw LLM output (strip fences, normalize)
  validate(art, ctx) — static analysis; returns error strings, [] = pass
  generate(ctx)      — template method: system_prompt + user_prompt → invoke → parse.
                       Overridden by BackendGenerator ONLY to capture a
                       structured email-metadata sidecar alongside the code.
                       Do not override elsewhere unless a future generator
                       has a similar structured side-output requirement.

Adding a new generator means creating one file that subclasses Generator and
registering it in registry.py. No changes to orchestration code (crew.py).

CodegenContext carries all inputs shared across generators for a single generation
run. Sub-agents read only the fields they need. It also carries one side-band
output slot (backend_email_metadata) written by BackendGenerator.generate() so
the orchestrator can read structured metadata without changing the artifacts dict
shape.

plan shape: the legacy plan (shopifyPlan + appContracts) has been retired.
The new pipeline produces an HLD (a_hld_agent) + LLD (d_lld_agent) pair
that downstream e_*_agents read directly. Legacy ctx.plan is retained
as a no-op {} until handler / revision / explanation are migrated.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple


@dataclass
class CodegenContext:
    """
    All inputs available to every generator for one generation run.

    Fields
    ------
    intent              Parsed intent from the product agent.
    plan                Architect output — contains shopifyPlan and appContracts
                        with all typed contracts (dbContracts, webhookContract,
                        widgetApiCatalog, adminApiCatalog, etc.).
    platform_api_catalog widgetApiCatalog entries for widget host.call() paths.
                        Empty for backend apps but always present so generators
                        don't need to guard against None.
    previous_errors     Validation errors from the prior attempt on THIS generator.
                        None on the first attempt. Used to build a retry prompt.
    prior_backend_code  The currently deployed handler source, present only on revision runs.
                        Accepts either a plain string (legacy CommonJS handler.js) or a
                        List[{path, contents}] (new multi-file bundle from the
                        platform-back era). _format_prior_handler in handler_agent.py
                        handles both; typed as Any to avoid a circular dep on
                        utils.file_bundle.
    prior_storefront_code   The currently deployed widget ES module, present only on
                        revision runs for storefront apps.
    prior_db_sql DDL already applied to the DB, present only on revision runs.
                        The migration agent emits only incremental DDL — never recreates
                        existing tables.
    prior_admin_ui_code The currently deployed admin UI module, present only on
                        revision runs for apps with an admin panel.
    backend_email_metadata
                        Side-band OUTPUT slot (not an input). Populated by
                        BackendGenerator.generate() when the handler emits
                        the email-metadata sidecar (variables + starterContent
                        the handler wrote alongside its code). None when the
                        handler does not call ctx.services.email.send. The
                        orchestrator reads this off the per-call ctx after
                        the future resolves.
    """

    intent: Dict[str, Any]
    plan: Dict[str, Any]
    # LLD plan (output of run_lld_agent). Empty until the LLD-consuming
    # codegens are migrated off the legacy arch plan. The e_db_agent
    # is the first to read it; backend/storefront/admin_ui still read `plan`.
    lld: Dict[str, Any] = field(default_factory=dict)
    # Cross-agent alignment notes from the pre_codegen agent. Each note is
    # a dict with `target_agents`, `concern`, `surfaces`, `instruction`,
    # `rationale`. Codegen agents call
    # `format_alignment_for(ctx.alignment_notes, self.name)` to render the
    # subset that targets them into a prompt block. Empty list when the
    # pre-codegen step is skipped or fails open.
    alignment_notes: List[Dict[str, Any]] = field(default_factory=list)
    platform_api_catalog: List[Dict[str, str]] = field(default_factory=list)
    previous_errors: Optional[List[str]] = None
    prior_backend_code: Optional[Any] = None  # str | List[Dict[str, str]]
    prior_storefront_code: Optional[str] = (
        None  # prior widget JS on revision runs (was prior_storefront_code)
    )
    prior_db_sql: Optional[str] = (
        None  # prior DDL on revision runs (was prior_migration_sql)
    )
    prior_admin_ui_code: Optional[str] = None

    # Carry-forward guardrails from a validator that does NOT re-run every
    # attempt (today: the codegen_v LLM bug-finder). Unlike `previous_errors`
    # — which lists this round's NEW errors and is fixed away as the next
    # validation pass clears it — entries here MUST stay fixed across every
    # subsequent attempt. The retry suffix renders them under
    # `DO NOT REVERT — prior findings`, so when fixing a new static error
    # would tempt the model to undo a prior codegen_v fix, the rule is
    # explicit. Populated by callers when they invoke `_phase_codegen`
    # after `q_codegen_v_agent` produces findings.
    prior_findings: Optional[List[str]] = None

    # OUTPUT slot — see docstring. Written by BackendGenerator.generate().
    backend_email_metadata: Optional[Dict[str, Any]] = None
    # OUTPUT slot — raw LLM response (pre-parse) so the artifact validator can
    # see the email-metadata fence that parse() strips out of the bundle.
    backend_raw_response: Optional[str] = None


# Thinking token budget for high-complexity features.
# Thinking tokens count against max_tokens in Anthropic's API, so get_llm()
# increases the ceiling by this amount to preserve the intended output budget.
# Only applied to generators whose model supports extended thinking (Sonnet-class).
# Haiku agents (product, explanation) are never passed a thinking budget because
# they use a different model — only the code generators go through base.py.
_THINKING_BUDGET_HIGH = 4000


def needs_extended_thinking(plan: Dict[str, Any]) -> bool:
    """
    Thinking gate — reads the legacy plan's ``complexity`` label.

    The legacy architect labelled complexity (low / medium / high) on
    the plan; consumers used that single label so complexity lived in
    one place. The architect agent has been retired; on the new HLD/LLD
    pipeline this helper falls back to "low" when ctx.plan is empty.
    Re-introduce a per-LLD complexity label in `d_lld_agent/schema.py`
    if extended thinking ever needs to fire on the new path.
    """
    complexity = (plan.get("appContracts") or {}).get("complexity", "low")
    return complexity == "high"


class Generator(ABC):
    """
    Abstract base for all code-generation sub-agents.

    Subclasses must set the class-level attributes and implement the four
    abstract methods. The concrete generate() method is inherited and
    typically should not be overridden — see its docstring for the one
    supported exception (structured side-band output, as in BackendGenerator).
    """

    # ── Class-level declarations (override in every subclass) ─────────────────

    #: Stable key used in the artifacts dict and error routing.
    name: str

    #: Max tokens for LLM output. Override in subclasses that generate longer code.
    max_tokens: int = 2048

    #: Does this generator benefit from extended thinking? Defaults to True
    #: (handler/storefront/admin_ui all benefit on complex apps). Migration is
    #: a near-mechanical translation of dbContracts into DDL — reasoning does
    #: not scale with complexity, so it opts out to save tokens and latency.
    supports_thinking: bool = True

    # ── Abstract interface ─────────────────────────────────────────────────────

    @abstractmethod
    def system_prompt(self) -> str:
        """Return the static system prompt for this generator."""

    @abstractmethod
    def user_prompt(self, ctx: CodegenContext) -> str:
        """
        Build and return the stable user prompt from context.

        IMPORTANT: do NOT include retry error blocks here. The generate() method
        handles retry errors separately so the stable prefix can be cached by
        Anthropic's prompt cache — retry attempts only pay for the new error block,
        not the full stable content (db schema, JIT sections, etc.).
        """

    @abstractmethod
    def parse(self, raw: str) -> str:
        """
        Post-process the raw LLM response.
        Strip markdown fences, normalize whitespace, handle prose fallback, etc.
        """

    @abstractmethod
    def validate(self, artifact: str, ctx: CodegenContext) -> List[str]:
        """
        Run static analysis on the generated artifact.

        Returns a list of human-readable error strings. An empty list means the
        artifact passed validation. Errors should NOT be prefixed with the
        generator name — the orchestrator adds that.
        """

    # ── Concrete template method ───────────────────────────────────────────────

    def _format_retry_suffix(
        self,
        errors: Optional[List[str]],
        prior_findings: Optional[List[str]] = None,
    ) -> str:
        """
        Render the retry suffix passed to invoke(). Two sections + a policy.

        Kept separate from user_prompt() so the stable prompt content can be
        cached — see generate() and adapter._build_user_message().

        Sections (each omitted when empty):

          NEW ERRORS         — this round's validation errors. They go away
                               once the next validation pass clears them.
          DO NOT REVERT      — carry-forward findings (today: codegen_v
                               LLM bug-finder). They persist across every
                               attempt until the validator that raised them
                               re-runs and reports a different set.

        Policy: the trap this prompt prevents is the model silencing a new
        TS error by undoing a prior runtime fix (e.g. re-introducing
        `req.platform!` inside a webhook handler to satisfy
        `shopifyClientFor`'s typed signature). The policy gives three
        concrete alternatives so revert isn't the path of least resistance.
        """
        if not errors and not prior_findings:
            return ""

        sections: List[str] = []
        if errors:
            lines = "\n".join(f"- {e}" for e in errors)
            sections.append(f"NEW ERRORS (fix these):\n{lines}")
        if prior_findings:
            lines = "\n".join(f"- {f}" for f in prior_findings)
            sections.append(
                "DO NOT REVERT — prior findings already addressed in an earlier "
                "attempt (must stay fixed):\n" + lines
            )

        policy = (
            "RETRY POLICY:\n"
            "1. Fix every NEW ERROR.\n"
            "2. NEVER revert anything under DO NOT REVERT. If satisfying a new\n"
            "   error appears to require reverting a prior fix, the prior fix is\n"
            "   not the bug — your approach is. Pick a different fix:\n"
            "     - widen or refactor a type (e.g. accept `Request | ShopifyClientContext`)\n"
            "     - construct the expected shape from available data\n"
            "       (e.g. build a `ShopifyClientContext` from `payload.shop_domain`)\n"
            "     - cast at the call site only (`fn(x as Y)`) when no data is available\n"
            "3. Patch, don't rewrite. Touch the smallest region needed."
        )

        body = "\n\n".join(sections)
        return f"\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n{body}\n\n{policy}\n\n"

    def generate(self, ctx: CodegenContext) -> Tuple[str, int, int, int, int]:
        """
        Full generation cycle: build prompts → invoke LLM → parse output.

        Returns (parsed_artifact, input_tokens, output_tokens, cache_read_tokens,
        cache_creation_tokens). `cache_read_tokens` are the prefix tokens
        Anthropic served from cache at ~10% of normal input price; on
        retries within the 5-min cache TTL the codegen system prompt
        (typically 20-30k chars) reuses the cached block. Reported
        separately from `input_tokens` so the CLI can show the actual cost
        rather than the raw input total.

        This is the only entry point the orchestrator needs to call.
        Override ONLY when a generator has structured side-band output that
        can't be expressed as a single artifact string (see BackendGenerator,
        which writes ctx.backend_email_metadata alongside the returned code).
        For every other case, customise system_prompt, user_prompt, and parse.

        Extended thinking is enabled when the plan is structurally complex —
        see needs_extended_thinking() for the gate. Generators that don't
        benefit from deeper reasoning (migration — mechanical DDL emission)
        opt out via supports_thinking=False. The gate is deterministic, not
        a self-reported architect label.
        """
        from models.adapter import dump_output, get_llm, invoke
        from models.agent_models import get_agent_model

        thinking_budget = (
            _THINKING_BUDGET_HIGH
            if self.supports_thinking and needs_extended_thinking(ctx.plan)
            else None
        )

        llm = get_llm(
            model=get_agent_model(self.name),
            max_tokens=self.max_tokens,
            thinking_budget=thinking_budget,
        )
        retry_suffix = self._format_retry_suffix(
            ctx.previous_errors, ctx.prior_findings
        )
        # 1-hour TTL: the codegen → static-validation → codegen_v →
        # codegen-retry loop can span 10+ minutes; the default 5-min
        # cache TTL evicts the system prompt + stable user prefix mid-
        # run. 1h TTL costs 1.25× on cache_create but serves reads at
        # the same 10% rate, so any retry within the hour pays back.
        result = invoke(
            llm,
            self.system_prompt(),
            self.user_prompt(ctx),
            retry_suffix=retry_suffix,
            cache_ttl="1h",
        )
        # Persist the raw response next to the prompt files so each codegen
        # attempt's output is post-mortem-able (same convention as the
        # upstream agents). No-op outside an active `input_log` block.
        dump_output(result.content)
        return (
            self.parse(result.content),
            result.input_tokens,
            result.output_tokens,
            result.cache_read_tokens,
            result.cache_creation_tokens,
        )
