"""
Cron batching prompt section — always included, governs the cronBatching contract field.
"""

CRON_BATCHING = """\
cronBatching: Required when the cron job iterates over a set of items and each item
  would otherwise trigger a Shopify API call. Declare this so the handler knows to
  pre-fetch all Shopify data in bulk before the loop begins.
  When non-null, MUST include "required": true.
  Scope: cronBatching applies to the READ phase only — bulk-fetching the Shopify data
  needed to decide what to do. Per-item Shopify WRITE calls inside the loop are acceptable
  and unavoidable when no batch write API exists for the mutation being performed.
  When per-item writes are unavoidable: add a platformGaps entry acknowledging this:
    { "gap": "No batch write API for <resource> — each item requires individual Shopify API calls",
      "mitigation": "Pre-fetch all required read data before the loop; per-item write calls inside the loop are unavoidable for this resource type" }\
"""

CRON_BATCHING_SHAPE = """\
cronBatching (non-null):
  { "required": true, "description": "What data is bulk-fetched before the loop and why." }\
"""
