"""
Base abstractions for all code-generation sub-agents.

Every generator in the pipeline implements the Generator ABC:

  name               — stable identifier used as the artifacts dict key and agent_models.py key
  max_tokens         — output token budget (default 2048, override when needed)
  system_prompt()    — static system prompt (defines constraints + output format)
  user_prompt(ctx)   — dynamic user prompt built from CodegenContext
  parse(raw)         — post-process raw LLM output (strip fences, normalize)
  validate(art, ctx) — static analysis; returns error strings, [] = pass
  generate(ctx)      — template method: system_prompt + user_prompt → invoke → parse

Adding a new generator means creating one file that subclasses Generator and
registering it in registry.py. No changes to orchestration code (crew.py).

CodegenContext carries all inputs shared across generators for a single generation
run. Sub-agents read only the fields they need.

plan shape (Architect output — passed directly as the plan):
  {
    "shopifyPlan": {
      "webhookTopics": [...],
      "cronSchedule": null | "..."
    },
    "appContracts": {
      "feasibility": "feasible" | "blocked",
      "complexity": "low" | "medium" | "high",
      "stateMachine": null | { entity, trackedField, unknownSentinel, skipWhenUnknown, transitions: [{from, to, action}] },
      "platformGaps": [...],
      "cronBatching": null | { required, ... },
      "dbContracts": [{ table, columns: [{name, type, constraints}], uniqueConstraint, indexes, rls }],
      "webhookContract": null | { payloadFields, handlerMustProduce },
      "cronContract": null | { handlerMustProduce },
      "widgetApiCatalog": null | [{ path, method, requestShape, responseShape }],
      "adminApiCatalog": null | [{ path, method, requestShape, responseShape }]
    }
  }
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
    api_context         Live Shopify API context from MCP prefetch — webhook payload
                        shapes, resource field schemas. The handler uses this to decide
                        which REST/GraphQL calls to make. None for non-handler agents.
    previous_errors     Validation errors from the prior attempt on THIS generator.
                        None on the first attempt. Used to build a retry prompt.
    prior_handler_code  The currently deployed handler.js, present only on revision runs.
    prior_widget_code   The currently deployed widget ES module, present only on
                        revision runs for storefront apps.
    prior_migration_sql DDL already applied to the DB, present only on revision runs.
                        The migration agent emits only incremental DDL — never recreates
                        existing tables.
    prior_admin_ui_code The currently deployed admin UI module, present only on
                        revision runs for apps with an admin panel.
    peer_handler_code   Handler code produced by a peer generator in THIS run, injected
                        into widget_js / admin_ui prompts during sequential retry so the
                        UI generators see the real backend they're talking to — not just
                        the architect's catalog. None on first attempt (peer code doesn't
                        exist yet) and for the handler itself (can't see its own code).
    peer_migration_sql  Migration DDL produced by a peer generator in THIS run, injected
                        into the handler prompt during sequential retry so SQL queries
                        use the exact column names and types that ended up in the schema.
                        None on first attempt and for the migration generator itself.
    """

    intent: Dict[str, Any]
    plan: Dict[str, Any]
    platform_api_catalog: List[Dict[str, str]] = field(default_factory=list)
    api_context: Optional[str] = None
    previous_errors: Optional[List[str]] = None
    prior_handler_code: Optional[str] = None
    prior_widget_code: Optional[str] = None
    prior_migration_sql: Optional[str] = None
    prior_admin_ui_code: Optional[str] = None
    peer_handler_code: Optional[str] = None
    peer_migration_sql: Optional[str] = None



# Thinking token budget for high-complexity features.
# Thinking tokens count against max_tokens in Anthropic's API, so get_llm()
# increases the ceiling by this amount to preserve the intended output budget.
# Only applied to generators whose model supports extended thinking (Sonnet-class).
# Haiku agents (product, validator, explanation) are never passed a thinking budget
# because they use a different model — only the code generators go through base.py.
_THINKING_BUDGET_HIGH = 4000


class Generator(ABC):
    """
    Abstract base for all code-generation sub-agents.

    Subclasses must set the class-level attributes and implement the four
    abstract methods. The concrete generate() method is inherited and should
    not be overridden.
    """

    # ── Class-level declarations (override in every subclass) ─────────────────

    #: Stable key used in the artifacts dict and error routing.
    name: str

    #: Max tokens for LLM output. Override in subclasses that generate longer code.
    max_tokens: int = 2048

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
        not the full stable content (db schema, api_context, JIT sections, etc.).
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
        It must not be overridden — customise system_prompt, user_prompt, and parse.

        Extended thinking is enabled for high-complexity features. The Architect
        declares complexity in appContracts; high-complexity apps involve state
        machines, multiple webhooks, and complex cross-component contracts where
        the model most often "forgets" a constraint from the middle of a long prompt.
        Extended thinking lets the model reason through all contracts before generating
        code, dramatically reducing missed edge cases and incorrect field names.
        """
        from models.adapter import get_llm, invoke
        from models.agent_models import get_agent_model

        complexity = (ctx.plan.get("appContracts") or {}).get("complexity", "low")
        thinking_budget = _THINKING_BUDGET_HIGH if complexity == "high" else None

        llm = get_llm(
            model=get_agent_model(self.name),
            max_tokens=self.max_tokens,
            thinking_budget=thinking_budget,
        )
        retry_suffix = self._format_retry_suffix(ctx.previous_errors)
        result = invoke(llm, self.system_prompt(), self.user_prompt(ctx), retry_suffix=retry_suffix)
        return self.parse(result.content), result.input_tokens, result.output_tokens
