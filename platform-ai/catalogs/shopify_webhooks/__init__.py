"""
Shopify webhook payload catalog loader.

Reads the committed `<version>/topics.json` produced by
`catalogs/scripts/refresh_shopify_webhook_catalog.py` and exposes:

  load_catalog(version) -> {
      "version": "...",
      "upstream_commit": "...",
      "topics": { topic_name: { topic, description, fields[], ... } }
  }
  load_topic_names(version) -> frozenset[str]
  load_summary_md(version) -> str        # for prompt injection

The default version comes from `LATEST_API_VERSION` next to the GraphQL
catalog (single source of truth). Bumping the platform's Shopify API
version means re-running both refresh scripts and bumping that constant
in lockstep.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict

_CATALOG_DIR = Path(__file__).resolve().parent

# Shopify API version this catalog targets. Match the GraphQL catalog
# version on bumps — both must move together.
LATEST_WEBHOOK_API_VERSION = "2026-04"


def _version_dir(version: str) -> Path:
    return _CATALOG_DIR / version


@lru_cache(maxsize=None)
def load_catalog(version: str = LATEST_WEBHOOK_API_VERSION) -> Dict[str, Any]:
    """Return the full structured catalog for `version`. Result is cached."""
    path = _version_dir(version) / "topics.json"
    if not path.exists():
        raise FileNotFoundError(
            f"webhook catalog missing: {path}\n"
            f"Run: python platform-ai/catalogs/scripts/refresh_shopify_webhook_catalog.py {version}"
        )
    return json.loads(path.read_text())


@lru_cache(maxsize=None)
def load_topic_names(version: str = LATEST_WEBHOOK_API_VERSION) -> frozenset[str]:
    """Return the set of valid webhook topic strings for `version`."""
    return frozenset(load_catalog(version)["topics"].keys())


@lru_cache(maxsize=None)
def load_summary_md(version: str = LATEST_WEBHOOK_API_VERSION) -> str:
    """Return the prompt-ready summary.md for `version`."""
    path = _version_dir(version) / "summary.md"
    if not path.exists():
        raise FileNotFoundError(
            f"webhook summary missing: {path}\n"
            f"Run: python platform-ai/catalogs/scripts/refresh_shopify_webhook_catalog.py {version}"
        )
    return path.read_text()


def topic_record(topic: str, version: str = LATEST_WEBHOOK_API_VERSION) -> Dict[str, Any]:
    """Look up a single topic's full record, raising KeyError if unknown."""
    topics = load_catalog(version)["topics"]
    if topic not in topics:
        raise KeyError(
            f"unknown webhook topic {topic!r} for version {version}; "
            f"valid topics: {sorted(topics.keys())[:5]}..."
        )
    return topics[topic]
