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
        """Build and return the user prompt from context."""

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

    def format_retry_block(self, errors: Optional[List[str]]) -> str:
        """
        Render previous validation errors as a prompt prefix for retry attempts.
        Shared by all generators — do not override.
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
        """
        from models.adapter import get_llm, invoke
        from models.agent_models import get_agent_model

        llm = get_llm(model=get_agent_model(self.name), max_tokens=self.max_tokens)
        result = invoke(llm, self.system_prompt(), self.user_prompt(ctx))
        return self.parse(result.content), result.input_tokens, result.output_tokens
