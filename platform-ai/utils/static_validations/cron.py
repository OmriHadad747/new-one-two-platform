"""Cron expression validation."""

from __future__ import annotations


def is_valid_cron(expr: str) -> bool:
    """Minimal cron validator — checks for 5 whitespace-separated fields."""
    return len(expr.strip().split()) == 5
