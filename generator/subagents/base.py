"""
Base abstractions for all code-generation sub-agents.

Every generator in the pipeline implements the Generator ABC:

  name               — stable identifier used as the artifacts dict key
  prefers_code_model — True → claude-sonnet (code quality), False → claude-haiku (cost)
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
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class CodegenContext:
    """
    All inputs available to every generator for one generation run.

    Fields
    ------
    intent              Parsed intent from Agent 1 (run_intent_agent).
    api_plan            Shopify API plan from Agent 2 (run_schema_agent).
    strategy            Feature coding brief from Agent 3 (run_strategy_agent).
    platform_api_catalog Allowed backend paths for widget host.call(). Empty for
                        backend_only apps but always present so generators don't
                        need to guard against None.
    previous_errors     Validation errors from the prior attempt on THIS generator.
                        None on the first attempt. Used to build a retry prompt.
    """

    intent: Dict[str, Any]
    api_plan: Dict[str, Any]
    strategy: Dict[str, Any]
    platform_api_catalog: List[Dict[str, str]] = field(default_factory=list)
    previous_errors: Optional[List[str]] = None


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

    #: True → uses llm_model_code (Sonnet); False → uses llm_model (Haiku).
    prefers_code_model: bool

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

    def generate(self, ctx: CodegenContext) -> str:
        """
        Full generation cycle: build prompts → invoke LLM → parse output.

        This is the only entry point the orchestrator needs to call.
        It must not be overridden — customise system_prompt, user_prompt, and parse.
        """
        from models.adapter import get_code_llm, get_llm, invoke

        llm = (
            get_code_llm(max_tokens=self.max_tokens)
            if self.prefers_code_model
            else get_llm(max_tokens=self.max_tokens)
        )
        result = invoke(llm, self.system_prompt(), self.user_prompt(ctx))
        return self.parse(result.content)
