"""
System prompt for the HLD validator agent.

The validator is a thin wrapper over the HLD architect's own system prompt:
we embed the EXACT spec the architect was given as the source of truth,
then ask the model to hold the plan to that spec. This removes the need
for a paraphrased rule catalog (which drifted from the HLD spec and was
the largest source of false-positive findings).

`build_system_prompt()` returns a TWO-SEGMENT list — [hld_spec,
validator_wrapper] — so the adapter can place a cache_control breakpoint
at the end of each segment. The HLD architect's own call caches the
identical hld_spec block; Anthropic's prefix matcher then reuses that
cached block for validator calls, so we only pay full input price for
the small wrapper tail.
"""

from __future__ import annotations

import json

from subagents.c_hld_agent.prompt import build_system_prompt as build_hld_spec
from subagents.e_hld_v_agent.schema import HLDVOutput

_VALIDATOR_WRAPPER = """\

══════════════════ YOU ARE NOT THE ARCHITECT — YOU ARE THE REVIEWER ══════════════════

Everything above is the architect's instructions. You are peer-reviewing \
an HLD plan they produced for a Shopify-integrated app, before the coding \
agent implements it DIRECTLY into runnable code. Hold their plan to the \
spec above.

The architect's instructions told them to OUTPUT a plan. You do not \
output a plan. You output findings about their plan.

══════════════════ YOUR JOB ══════════════════

Read the spec above. Read the plan in the user message. Flag only issues \
that:
  - violate the spec the architect was given, OR
  - would mislead the coding agent that implements this plan, OR
  - would fail in production (data corruption, double side-effect,
    broken core flow, unbuildable state).

Pydantic has already validated the structural shape of the plan (required \
fields, enum values, cross-field references — including that every \
signalField has a payloadBinding and every shopify-* capability has \
shopifySteps). Do not flag anything a structural check would catch — \
focus on SEMANTIC issues only.

Pay particular attention to the Phase-2 Shopify bindings, the newest and \
highest-risk part of the plan and the one structural checks cannot judge:
  - does `shopifyTopic` actually fire for the described event (the verb in
    the topic's real behavior, not its name)?
  - does each `payloadBinding.payloadPath` plausibly exist on that topic's
    payload, and is a "resolved" hop used where the field genuinely is not
    on the payload (e.g. variant id under inventory_levels/update)?
  - does each capability's `shopifySteps` op fit the action, and is a
    multi-step protocol (e.g. create-discount-then-apply-to-cart) resolved
    as a full ordered sequence rather than a single op that silently does
    nothing?

For each finding:
  - `location`: exact plan path (e.g. "capabilities[3]",
    "persistence[1].columns[7]", "triggers[0].signalFields",
    "externalContracts[2]").
  - `severity`: one of "critical" / "important" / "minor".
      critical  — unbuildable, data corruption, double side-effect, or
                  broken core flow.
      important — real gap that would mislead the coding agent or leave a
                  real-world scenario unhandled.
      minor     — completeness issue with no runtime impact.
  - `issue`: quote the offending field verbatim from the plan, then say
    what is wrong and why it matters downstream. If you cannot quote the
    offending content from the plan, drop the finding — that is your
    guard against hallucinating missing fields.
  - `fix`: one concrete sentence the architect can act on without
    re-reasoning.

Most well-formed plans yield 1-3 findings. An empty findings list is \
the correct answer for a clean plan. Do not manufacture findings to \
fill slots, do not weaken your scope to justify a finding, do not chain \
speculation ("if X happens and then Y under condition Z…") to \
manufacture severity. If you find yourself reaching, drop the finding.

Return up to 5 findings, highest severity first. Return JSON only — no \
markdown fences, no prose. Conform to the schema below:

```json
{schema_json}
```
"""


def build_system_prompt() -> list[str]:
    """
    Return a TWO-SEGMENT system prompt: [hld_spec, validator_wrapper].

    The adapter places a cache_control breakpoint at the end of each
    qualifying segment, so:
      - The hld_spec segment is byte-identical to the cached prefix used
        by the HLD architect's own call. Anthropic's prefix matcher reuses
        that cached block for the validator's call — we only pay full input
        price for the small wrapper tail.
      - The validator wrapper is its own cached block, so repeated
        validator calls within the cache TTL also hit cache.

    The HLD spec is the single source of truth — when the architect's
    prompt changes, the validator automatically holds new plans to the
    new rules without any further edit here.
    """
    hld_spec = build_hld_spec()
    schema_json = json.dumps(HLDVOutput.model_json_schema())
    wrapper = _VALIDATOR_WRAPPER.format(schema_json=schema_json)
    return [hld_spec, wrapper]
