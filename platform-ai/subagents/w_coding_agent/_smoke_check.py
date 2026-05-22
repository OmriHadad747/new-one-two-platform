"""
Smoke check for the assembled system prompt.

Builds the full prompt from on-disk content and reports:
  - Total bytes
  - Approximate token count (~bytes/4 for English text)
  - Per-section sizes (so you can spot a bloated section quickly)
  - Whether any placeholder tokens survived substitution (would mean the
    template fell out of sync with the loaders)

Run:
  python platform-ai/subagents/w_coding_agent/_smoke_check.py
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve()
PLATFORM_AI = HERE.parents[2]

sys.path.insert(0, str(PLATFORM_AI))

from subagents.w_coding_agent.prompt import (  # noqa: E402
    SHOPIFY_API_VERSION,
    _load_component_rules,
    _load_platform_helpers,
    _load_shopify_summary,
    build_full_system_prompt,
)


_PLACEHOLDERS = [
    "__COMPONENT_RULES__",
    "__PLATFORM_HELPERS__",
    "__SHOPIFY_WEBHOOKS__",
    "__SHOPIFY_AJAX__",
    "__SHOPIFY_STOREFRONT__",
    "__SHOPIFY_ADMIN__",
]


def _fmt_size(n: int) -> str:
    return f"{n:>9,} bytes  ~{n // 4:>7,} tokens"


def main() -> int:
    component_rules = _load_component_rules()
    platform_helpers = _load_platform_helpers()
    s_webhooks = _load_shopify_summary("webhooks")
    s_ajax = _load_shopify_summary("ajax")
    s_storefront = _load_shopify_summary("storefront")
    s_admin = _load_shopify_summary("admin")

    print(f"Shopify API version: {SHOPIFY_API_VERSION}\n")
    print("Heavy content blocks:")
    print(f"  component_rules     {_fmt_size(len(component_rules))}")
    print(f"  platform_helpers    {_fmt_size(len(platform_helpers))}")
    print(f"  shopify_webhooks    {_fmt_size(len(s_webhooks))}")
    print(f"  shopify_ajax        {_fmt_size(len(s_ajax))}")
    print(f"  shopify_storefront  {_fmt_size(len(s_storefront))}")
    print(f"  shopify_admin       {_fmt_size(len(s_admin))}")

    prompt = build_full_system_prompt()
    total = len(prompt)
    print(f"\nFinal assembled prompt: {_fmt_size(total)}")

    survived = [p for p in _PLACEHOLDERS if p in prompt]
    if survived:
        print("\n❌ unsubstituted placeholders survived:")
        for p in survived:
            print(f"   {p}")
        return 1

    print("\n✅ all placeholders substituted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
