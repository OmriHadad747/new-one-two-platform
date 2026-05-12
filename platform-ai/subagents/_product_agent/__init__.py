"""Product agent — parses a merchant prompt into a typed feature intent."""

from subagents._product_agent.agent import (
    ProductIntentValidationError,
    run_product_agent,
    run_product_agent_analyze,
)
from subagents._product_agent.schema import ProductIntent

__all__ = [
    "ProductIntent",
    "ProductIntentValidationError",
    "run_product_agent",
    "run_product_agent_analyze",
]
