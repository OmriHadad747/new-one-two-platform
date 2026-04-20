"""
Revision Classifier — classifies merchant revision requests for analytics.

Determines whether a revision is a bug report, feature modification, or new
capability request. Used for product improvement tracking — NOT billing enforcement.

Model: claude-haiku (fast classification, no code generation).
"""

from __future__ import annotations

import json
from typing import Any, Dict

from models.adapter import get_llm, invoke, extract_json
from models.agent_models import get_agent_model


CLASSIFIER_SYSTEM = """You are a request classifier for a Shopify app generation platform.

A merchant has submitted feedback about an existing generated app. Classify their request.

OUTPUT — valid JSON only, no markdown fences:
{
  "classification": "<type>",
  "confidence": "<level>"
}

CLASSIFICATION — use ONLY one of these three values:
- "bug_report" — the merchant is reporting something that is BROKEN: errors, crashes, blank screens,
  incorrect behavior, data not showing, actions not working. The app was supposed to do X but does Y.
  Keywords: "doesn't work", "error", "broken", "blank", "crash", "wrong", "not showing", "fails"

- "feature_modification" — the merchant wants to CHANGE something that works: different colors, text,
  layout, sorting, timing, thresholds, email content, button labels. The app works but they want
  it different.
  Keywords: "change", "make it", "instead of", "move", "rename", "update the", "different"

- "new_capability" — the merchant wants to ADD something that doesn't exist yet: a new feature,
  new integration, additional functionality beyond the original app scope.
  Keywords: "also", "add", "new", "can you include", "I also want", "additionally"

CONFIDENCE:
- "high" — the intent is clearly one category
- "medium" — ambiguous but leaning toward the chosen classification
- "low" — genuinely unclear, could be multiple categories

When unsure between bug_report and feature_modification, lean toward bug_report —
it's better to give the merchant the benefit of the doubt."""


def classify_revision(feedback: str) -> Dict[str, Any]:
    """
    Classify a merchant's revision feedback.

    Returns: {"classification": "bug_report"|"feature_modification"|"new_capability",
              "confidence": "high"|"medium"|"low"}
    """
    llm = get_llm(model=get_agent_model("product"), max_tokens=128)
    result = invoke(llm, CLASSIFIER_SYSTEM, f"Merchant feedback: {feedback}")
    raw = extract_json(result.content)
    try:
        parsed = json.loads(raw)
        # Validate classification value
        valid_types = {"bug_report", "feature_modification", "new_capability"}
        if parsed.get("classification") not in valid_types:
            parsed["classification"] = "feature_modification"
            parsed["confidence"] = "low"
        return parsed
    except (json.JSONDecodeError, TypeError):
        return {"classification": "feature_modification", "confidence": "low"}
