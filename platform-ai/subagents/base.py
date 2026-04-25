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
                       Overridden by HandlerGenerator ONLY to capture a
                       structured email-metadata sidecar alongside the code.
                       Do not override elsewhere unless a future generator
                       has a similar structured side-output requirement.

Adding a new generator means creating one file that subclasses Generator and
registering it in registry.py. No changes to orchestration code (crew.py).

CodegenContext carries all inputs shared across generators for a single generation
run. Sub-agents read only the fields they need. It also carries one side-band
output slot (handler_email_metadata) written by HandlerGenerator.generate() so
the orchestrator can read structured metadata without changing the artifacts dict
shape.

plan shape: see validate_architect_plan in validation/static_validation.py
and the architect prompt sections in subagents/prompts/architect/ for the
authoritative schema. (Previously duplicated here — removed to avoid drift.)
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
    prior_handler_code  The currently deployed handler source, present only on revision runs.
                        Accepts either a plain string (legacy CommonJS handler.js) or a
                        List[{path, contents}] (new multi-file bundle from the
                        platform-back era). _format_prior_handler in handler_agent.py
                        handles both; typed as Any to avoid a circular dep on
                        utils.file_bundle.
    prior_widget_code   The currently deployed widget ES module, present only on
                        revision runs for storefront apps.
    prior_migration_sql DDL already applied to the DB, present only on revision runs.
                        The migration agent emits only incremental DDL — never recreates
                        existing tables.
    prior_admin_ui_code The currently deployed admin UI module, present only on
                        revision runs for apps with an admin panel.
    handler_email_metadata
                        Side-band OUTPUT slot (not an input). Populated by
                        HandlerGenerator.generate() when the handler emits
                        the email-metadata sidecar (variables + starterContent
                        the handler wrote alongside its code). None when the
                        handler does not call ctx.services.email.send. The
                        orchestrator reads this off the per-call ctx after
                        the future resolves.
    """

    intent: Dict[str, Any]
    plan: Dict[str, Any]
    platform_api_catalog: List[Dict[str, str]] = field(default_factory=list)
    previous_errors: Optional[List[str]] = None
    prior_handler_code: Optional[Any] = None  # str | List[Dict[str, str]]
    prior_widget_code: Optional[str] = None
    prior_migration_sql: Optional[str] = None
    prior_admin_ui_code: Optional[str] = None

    # OUTPUT slot — see docstring. Written by HandlerGenerator.generate().
    handler_email_metadata: Optional[Dict[str, Any]] = None


# Thinking token budget for high-complexity features.
# Thinking tokens count against max_tokens in Anthropic's API, so get_llm()
# increases the ceiling by this amount to preserve the intended output budget.
# Only applied to generators whose model supports extended thinking (Sonnet-class).
# Haiku agents (product, explanation) are never passed a thinking budget because
# they use a different model — only the code generators go through base.py.
_THINKING_BUDGET_HIGH = 4000


def needs_extended_thinking(plan: Dict[str, Any]) -> bool:
    """
    Thinking gate — reads the architect's ``complexity`` label.

    The architect labels complexity using the concrete rubric in
    subagents/prompts/architect/_core.py (stateMachine, cronBatching,
    2+ webhooks, cross-surface contract, plus a narrow semantic escape
    hatch). Consumers use that single label so complexity lives in one
    place — the plan. If labelling drift shows up in practice, tighten
    the architect rubric rather than scattering overrides here.
    """
    complexity = (plan.get("appContracts") or {}).get("complexity", "low")
    return complexity == "high"


class Generator(ABC):
    """
    Abstract base for all code-generation sub-agents.

    Subclasses must set the class-level attributes and implement the four
    abstract methods. The concrete generate() method is inherited and
    typically should not be overridden — see its docstring for the one
    supported exception (structured side-band output, as in HandlerGenerator).
    """

    # ── Class-level declarations (override in every subclass) ─────────────────

    #: Stable key used in the artifacts dict and error routing.
    name: str

    #: Max tokens for LLM output. Override in subclasses that generate longer code.
    max_tokens: int = 2048

    #: Does this generator benefit from extended thinking? Defaults to True
    #: (handler/widget_js/admin_ui all benefit on complex apps). Migration is
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

    def _format_retry_suffix(self, errors: Optional[List[str]]) -> str:
        """
        Render previous validation errors as the retry suffix passed to invoke().

        This is intentionally separate from user_prompt() so the stable prompt
        content can be cached — see generate() and adapter._build_user_message().
        """
        if not errors:
            return ""
        lines = "\n".join(f"- {e}" for e in errors)
        return (
            f"\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n{lines}\n\n"
            f"Fix ALL listed errors in this new attempt.\n\n"
        )

    def generate(self, ctx: CodegenContext) -> Tuple[str, int, int]:
        """
        Full generation cycle: build prompts → invoke LLM → parse output.

        Returns (parsed_artifact, input_tokens, output_tokens).
        The token counts let the orchestrator build an accurate AgentTraceEntry.

        This is the only entry point the orchestrator needs to call.
        Override ONLY when a generator has structured side-band output that
        can't be expressed as a single artifact string (see HandlerGenerator,
        which writes ctx.handler_email_metadata alongside the returned code).
        For every other case, customise system_prompt, user_prompt, and parse.

        Extended thinking is enabled when the plan is structurally complex —
        see needs_extended_thinking() for the gate. Generators that don't
        benefit from deeper reasoning (migration — mechanical DDL emission)
        opt out via supports_thinking=False. The gate is deterministic, not
        a self-reported architect label.
        """
        from models.adapter import get_llm, invoke
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
        retry_suffix = self._format_retry_suffix(ctx.previous_errors)
        result = invoke(
            llm, self.system_prompt(), self.user_prompt(ctx), retry_suffix=retry_suffix
        )
        return self.parse(result.content), result.input_tokens, result.output_tokens
