"""
Email metadata extraction.

Runs after handler codegen to detect whether the generated handler calls
`ctx.email.send()` and, if so, extracts:
  - the list of variable names the handler passes in `data: { ... }`
  - a heuristic transactional/marketing classification
  - starter template content (subject, heading, body, CTA) used to pre-fill
    `app_email_configs` so the merchant doesn't see a blank form

This is intentionally a regex-based pass rather than an LLM call — it runs in
the critical path of every generation, and the handler_agent is already
responsible for producing correct call sites. Our job here is observation,
not judgement.

The extracted metadata flows into Bundle.{usesEmail, emailVariables,
emailTypeSuggestion, emailStarterContent} and then through Pub/Sub to the
platform API, which seeds `app_email_configs` on bundle storage.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional

from contract.validators import EmailStarterContent


# ─── Detection ────────────────────────────────────────────────────────────────

_EMAIL_SEND_RE = re.compile(r"ctx\.(?:services\.)?email\.send\s*\(")

# Best-effort regex for the `data: { key1, key2, key3: ... }` object literal
# that appears inside a ctx.email.send(...) call. Matches everything from the
# opening brace after `data:` up to the matching closing brace (using a simple
# no-nested-braces heuristic — good enough for typical handler code).
_DATA_OBJECT_RE = re.compile(
    r"data\s*:\s*\{([^{}]*)\}",
    re.DOTALL,
)

# Matches identifiers at the start of lines / after commas within the data
# object. Handles both shorthand (`customerName`) and key-value
# (`customerName: customer.email`). Keeps order, drops duplicates.
_KEY_RE = re.compile(r"(?:^|[,\s])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[,:}]")

# Marketing-vs-transactional heuristic.
# Transactional: triggered by a customer action (subscribed, ordered, etc.)
# Marketing:     unsolicited outreach (newsletter, win-back, promo blast)
_MARKETING_HINTS = (
    "newsletter",
    "marketing",
    "win-back",
    "winback",
    "promotion",
    "promotional",
    "announcement",
    "campaign",
    "blast",
)


def detect_email_usage(handler_code: str) -> bool:
    """Returns True if the handler makes any ctx.email.send() call."""
    return bool(_EMAIL_SEND_RE.search(handler_code))


def extract_variables(handler_code: str) -> List[str]:
    """
    Extract the list of variable names the handler passes in `data: { ... }`.

    Handles:
      data: { customerName, cartTotal }                  → ['customerName', 'cartTotal']
      data: { customerName: cart.customer.email, total } → ['customerName', 'total']

    Returns variables in first-seen order, deduplicated.
    """
    seen: List[str] = []
    seen_set = set()
    for match in _DATA_OBJECT_RE.finditer(handler_code):
        body = match.group(1)
        for key_match in _KEY_RE.finditer("," + body + ","):
            key = key_match.group(1)
            if key and key not in seen_set:
                seen.append(key)
                seen_set.add(key)
    return seen


def classify_email_type(
    intent: Dict[str, object],
    plan: Dict[str, object],
) -> str:
    """
    Heuristic: returns 'marketing' if the feature description or app type hints
    at marketing-style outreach. Otherwise defaults to 'transactional' — the
    safer default, since the vast majority of Ton's catalog is transactional.
    """
    haystack_parts: List[str] = []
    desired = intent.get("desiredOutcome")
    if isinstance(desired, str):
        haystack_parts.append(desired.lower())
    app_type = intent.get("appType") or intent.get("category")
    if isinstance(app_type, str):
        haystack_parts.append(app_type.lower())

    arch_summary = plan.get("summary") if isinstance(plan, dict) else None
    if isinstance(arch_summary, str):
        haystack_parts.append(arch_summary.lower())

    haystack = " ".join(haystack_parts)
    if any(hint in haystack for hint in _MARKETING_HINTS):
        return "marketing"
    return "transactional"


# ─── Starter content generation ──────────────────────────────────────────────

def _title_case(s: str) -> str:
    # Convert "abandoned_cart_recovery" / "abandonedCartRecovery" / "abandoned-cart"
    # to a human-readable title.
    s = re.sub(r"[_-]+", " ", s)
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)
    return s.strip().title()


def build_starter_content(
    intent: Dict[str, object],
    variables: List[str],
) -> EmailStarterContent:
    """
    Produces pre-fill content for `app_email_configs`. Uses a template based
    on the app's intent and the discovered variable names so the merchant sees
    something sensible — not a blank form.

    Merchants will edit this in the Email tab before deploy (which is blocked
    until configured_by_merchant = TRUE).
    """
    desired = intent.get("desiredOutcome") or "A message from your store"
    if not isinstance(desired, str):
        desired = str(desired)

    # Subject — derive a short title from the desired outcome. The product agent
    # never emits an `appName` field, so there's no point probing for one.
    subject = _title_case(desired[:60])

    # Heading — conversational.
    if "customerName" in variables:
        heading = "Hi {{customerName}}"
    elif "firstName" in variables:
        heading = "Hi {{firstName}}"
    else:
        heading = None

    # Body — short template referencing the desired outcome.
    body_lines: List[str] = []
    if heading is None:
        body_lines.append("Hi,")
    body_lines.append("")
    body_lines.append(_first_sentence(desired).strip())
    body_lines.append("")
    body_lines.append("Thanks for being a customer!")
    body = "\n".join(body_lines).strip()

    # CTA — use a URL variable if one was passed, otherwise leave empty.
    cta_label: Optional[str] = None
    cta_url: Optional[str] = None
    for url_var in ("recoveryUrl", "productUrl", "orderUrl", "url", "actionUrl"):
        if url_var in variables:
            cta_label = "Take me there"
            cta_url = "{{" + url_var + "}}"
            break

    return EmailStarterContent(
        subject=subject,
        heading=heading,
        body=body,
        ctaLabel=cta_label,
        ctaUrl=cta_url,
    )


def _first_sentence(text: str) -> str:
    # Grabs the first sentence-ish chunk for use as email body copy.
    for terminator in (". ", "! ", "? ", "\n"):
        idx = text.find(terminator)
        if idx != -1:
            return text[: idx + 1]
    return text[:200]


# ─── Top-level extraction function ───────────────────────────────────────────

def extract_email_metadata(
    handler_code: str,
    intent: Dict[str, object],
    plan: Dict[str, object],
) -> Dict[str, object]:
    """
    Single entry point used by the crew. Returns a dict with the fields that
    get written into Bundle. If the handler doesn't send emails, returns
    `{"usesEmail": False}` and nothing else.
    """
    if not detect_email_usage(handler_code):
        return {"usesEmail": False}

    variables = extract_variables(handler_code)
    email_type = classify_email_type(intent, plan)
    starter = build_starter_content(intent, variables)

    return {
        "usesEmail": True,
        "emailVariables": variables,
        "emailTypeSuggestion": email_type,
        "emailStarterContent": starter,
    }
