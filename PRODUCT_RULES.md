# Product Agent Prompt Rules — Validation Map

Source: `platform-ai/subagents/prompts/core/product.py` (`PRODUCT_BASE` for the one-shot agent + `PRODUCT_ANALYZE_BASE` for the multi-turn analyze flow), and `platform-ai/subagents/product_agent.py` (entry points + the JSON-parse fallback in `run_product_agent_analyze`).

**Scope note — the product agent is unique in the pipeline.**

- **It runs first.** Its output (`triggerTypes`, `resources`, `appCategory`, `cronHint`, `desiredOutcome`, `qualityBrief`) drives the architect, which drives every downstream generator. A bad classification cascades: wrong `appCategory` → architect emits the wrong archetype's contracts → handler/widget/admin all get wrong scaffolding → static layer flags the symptoms ten steps later, not the root cause.
- **It has no static validator today.** No `llm_validations/product_*.py` exists. The downstream `arch_plan.py` partially catches a few cascading effects (e.g. `widgetApiCatalog` non-null only for storefront archetypes) but those errors point at the architect, not the product layer where the drift actually lives.
- **Output is small JSON, not code.** Pure structural checks (closed-set enums, cross-field consistency) have near-zero FP — a much cleaner static fit than the regex-on-source checks we audit elsewhere. The "JS source has tenant_id in a comment" FP class doesn't apply here at all.

**Legend** — `validate?` = should this rule be enforced after the product agent emits its intent JSON?
- **static** — structural / set-membership / cross-field consistency check on the parsed intent dict. HIGH precision (no false positives), would live in `llm_validations/product_intent.py` (does not exist today).
- **llm** — semantic, prose, or judgment that won't survive a cheap structural check but is worth catching agentically (per `LLM_VALIDATORS_PLAN.md`).
- **no** — judgment/style/informational; high false-positive risk relative to value.
- **no (paranoid)** — structural rule the prompt + JSON schema example already carry; model gets it right ~always. If it ever drifts, downstream architect / `extract_json` / fallback handlers catch the breakage.

**`done?`** column — `✅` means the static-tier check is currently implemented somewhere in the pipeline. `⏳ TODO` means a static check that earns its keep under the four-bar policy but doesn't exist yet. Blank for `llm` / `no` / `no (paranoid)` rows.

**One owner per rule** — every row has exactly one owner.

**Static-validation principle:** only enforce a structural static rule when (a) the failure mode has been seen with non-trivial frequency, (b) the check is cheap & structural with **near-zero false-positive rate**, (c) the blast radius is catastrophic (cascading misclassification → wrong archetype → wrong downstream codegen), AND (d) the downstream architect / handler / widget / admin static layers don't already cover it. Everything else flows through the LLM validators (`agent_rules` + `bug_finder`).

**Catastrophic-by-cascade** is the dominant failure class for the product agent. A static validator here doesn't have to catch a single-step bug — it has to fail-fast before the wrong classification poisons every downstream agent's prompt.

---

| # | rule | validate? | how | done? |
|---|---|---|---|---|
| **Output shape** | | | | |
| 1 | One-shot output is valid JSON with no markdown fences | no (paranoid) | — (`extract_json` strips fences; `json.loads` failure surfaces immediately to `run_product_agent`) | |
| 2 | One-shot output has all required keys: `triggerTypes`, `resources`, `desiredOutcome`, `cronHint`, `appCategory`, `qualityBrief` | no (paranoid) | — (the JSON schema example IS in the system prompt; with schema-as-prompt the model essentially never omits keys — same logic that put `complexity` / `feasibility` enum-presence checks in paranoid for ARCH_RULES.md) | |
| 3 | Analyze response is one of `{status: "needs_clarification", question, suggestions}` or `{status: "ready", summary, intent}` | no (paranoid) | — (`run_product_agent_analyze` falls back to a `needs_clarification` ask on parse failure or missing `status`) | |
| 4 | `needs_clarification.suggestions` is 2–4 short options, simplest first, ≤8 words each | no | — (UI cosmetic — long suggestions render fine in the merchant flow; ordering judgment is hard to validate without intent context) | |
| 5 | `ready.summary` is 2–3 sentences | no | — (style; sentence-counting has FP risk on edge cases like URLs / abbreviations / multi-clause sentences) | |
| **Closed enums** | | | | |
| 6 | `triggerTypes` is a non-empty subset of `{"webhook", "cron", "admin", "widget"}` — no other values | yes | static | ⏳ TODO |
| 7 | `resources` is a subset of `{"orders", "inventory", "customers", "products", "discounts"}` — no other values. `"email"` / `"sms"` are delivery mechanisms, not Shopify data resources, and must be absent | no (paranoid) | — (`resources` is informational input to the architect's prompt — not load-bearing for archetype, capabilities, webhookTopics, or handlerCapabilities decisions. Bad values cause minor prompt drift, not wrong codegen — fails bar (c)) | |
| 8 | `appCategory` ∈ `{"backend", "backend_admin", "storefront_backend", "storefront_backend_admin"}` | yes | static | ⏳ TODO |
| **Cross-field consistency** | | | | |
| 9 | `cronHint` is non-null iff `"cron"` ∈ `triggerTypes` (and is a non-empty string when present) | yes | static | ⏳ TODO |
| 10 | `appCategory` starts with `"storefront_"` iff `"widget"` ∈ `triggerTypes`. Storefront-only archetype valid iff a customer-facing widget is part of the feature | yes | static | ⏳ TODO |
| 11 | `"admin"` ∈ `triggerTypes` ⇒ `appCategory.endswith("_admin")` (**one-way only**). The reverse is NOT a hard rule — admin in the archetype is broader than the admin trigger (records to review, configurable settings, scheduled cron jobs all justify admin without `"admin"` being a trigger type), so `appCategory: "backend_admin"` with `triggerTypes: ["webhook"]` is valid | yes | static | ⏳ TODO |
| **Admin-decision logic** | | | | |
| 12 | Admin is in the archetype when the feature accumulates records the merchant would want to review (submissions, signups, logs, run history) — even if the merchant didn't explicitly ask for an admin UI | yes | llm | |
| 13 | Admin is in the archetype when the feature has configurable settings (rates, thresholds, templates, rules) — even when the merchant didn't mention them | yes | llm | |
| 14 | Admin is in the archetype when the feature is a scheduled cron job (`"cron"` ∈ triggerTypes) — cron without admin is almost always wrong; default `"backend_admin"` for cron-only features | yes | llm | |
| 15 | Merchant phrasing like "keep it simple" / "nothing complicated" does NOT downgrade the archetype when admin is technically required | yes | llm | |
| **Storefront-classification logic** | | | | |
| 16 | Sending emails or SMS to customers does NOT count as storefront interaction. The storefront archetype is valid only when a widget the customer interacts with is part of the feature; outbound notifications are delivery mechanisms, not customer-facing UI | yes | llm | |
| **Scope discipline** | | | | |
| 17 | Intent scopes to one cohesive feature — no unrequested capabilities added (e.g. "auto-tag orders" must not silently expand into "auto-tag orders + send a thank-you email + update Discord") | yes | llm | |
| 18 | Out-of-scope requests (real-time connections, third-party OAuth, multi-page UIs, non-Shopify external APIs) → redirect via `needs_clarification` rather than coercing into a degraded `ready` spec | yes | llm | |
| **Quality brief content** | | | | |
| 19 | `qualityBrief` is 3–5 sentences | no | — (style; sentence-counting same FP class as row 5) | |
| 20 | `qualityBrief` is specific to THIS app type — covers concrete edge cases, UX details, and common mistakes that differentiate a 5-star app of this type from a 3-star one. Generic advice ("handle errors gracefully", "have a clean UI") is not useful and should be avoided | yes | llm | |
| **Analyze flow** | | | | |
| 21 | "What can you build?" / "what's possible?" / "give me examples" → respond with `needs_clarification`, describe the platform in `question`, offer 4 concrete example app types as `suggestions` | yes | llm | |
| 22 | Cannot determine trigger / main resource / desired outcome from merchant prompt → ask via `needs_clarification`, do not guess into a `ready` spec | yes | llm | |
| 23 | Request is clear and within scope → go directly to `ready`, do not ask redundant clarifying questions | yes | llm | |
| 24 | Suggestions order simplest first; never suggest a richer variant unless the merchant explicitly asked for one | yes | llm | |

---

## What's currently implemented

**Nothing.** The product agent has no static validator. The crew passes the parsed intent JSON straight to `run_architect_agent` without inspection. Downstream effects:

- `arch_plan.py` partially catches the cascade — e.g. `widgetApiCatalog` must be non-null for `storefront_*` archetypes, `adminApiCatalog` must be non-empty for `*_admin` archetypes. Those checks fire on the architect output, not the intent, so the error message points at the architect when the actual drift lives upstream.
- The `appCategory` value is read directly by the architect agent's prompt builder and by every codegen agent's archetype gates. If product emits `appCategory: "ecommerce"` (a value that didn't make the closed enum), the architect runs anyway with whatever the prompt tolerates, the codegen agents skip widget/admin generation incorrectly, and the deploy ships a malformed app.
- `triggerTypes` outside the closed set silently flow through. `triggerTypes: ["email"]` would mean "no real triggers" to the architect — feature ships with no entry points.

---

## Static gaps to close (after re-audit)

Five static checks survive the strict four-bar pass. Two were reclassified to paranoid during re-audit (row 2 and row 7) and one was narrowed (row 11 became one-way only).

| row | rule | shape | FP risk |
|---|---|---|---|
| 6 | `triggerTypes` closed-set + non-empty | `triggerTypes` is a non-empty list and `set(triggerTypes) ⊆ {webhook, cron, admin, widget}` | zero |
| 8 | `appCategory` enum | `appCategory ∈ {backend, backend_admin, storefront_backend, storefront_backend_admin}` | zero |
| 9 | `cronHint` cron-coupled | `(cronHint is not None) == ("cron" in triggerTypes)`; when present, non-empty string | zero |
| 10 | storefront-archetype ↔ widget-trigger consistency (biconditional) | `appCategory.startswith("storefront_") == ("widget" in triggerTypes)` | zero |
| 11 | admin-trigger ⇒ admin-archetype (one-way) | `if "admin" in triggerTypes: appCategory.endswith("_admin")` | zero |

All five live in a single new `llm_validations/product_intent.py:validate_product_intent` function (~30 lines) called from `crew.py` after `run_product_agent` succeeds. Same shape as `validate_architect_plan` runs today.

**Why each clears the four bars:**
- (a) **Frequency** — low individually but real. Frontier model occasionally emits `triggerTypes: ["schedule"]` / `appCategory: "ecommerce"` on edge prompts. The team encoded explicit "Use ONLY these four values. No other values are valid. Never invent new trigger type names" in the prompt — that prophylactic exists because the failure was real enough to write the guard.
- (b) **Near-zero FP** — every check is dict-key membership / set subset / equality / boolean cross-field. No regex on source, no semantic interpretation. Closed-set + cross-field consistency is the canonical near-zero-FP shape.
- (c) **Catastrophic-by-cascade** — wrong classification poisons every downstream agent's prompt. The fail-fast saves all downstream tokens AND replaces the silent-cascade error pattern (architect blames itself for what's actually a product bug) with a clean upstream error.
- (d) **Not duplicated upstream** — product runs first. Downstream `arch_plan.py` catches some cascading symptoms but slowly and with worse error messages (it points at the architect when the actual drift lives in the product output).

**Why row 2 and row 7 dropped to paranoid during re-audit:**
- **Row 2 (required keys present)** — the JSON schema example IS the system prompt's output spec; with schema-as-prompt the model essentially never omits keys. Same frontier-model-tax logic that put `complexity ∈ {low,medium,high}` and `feasibility ∈ {feasible,blocked}` into paranoid for `ARCH_RULES.md`. Bar (a) doesn't clear.
- **Row 7 (`resources` closed-set)** — `resources` is informational input to the architect's prompt, not load-bearing for any codegen decision. The architect's archetype/capability/webhookTopics decisions are driven by `triggerTypes` + `desiredOutcome` + its own reasoning, not `resources`. A wrong value causes minor prompt drift, not wrong codegen. Bar (c) doesn't clear.

**Why row 11 narrowed to one-way:**
The prompt's admin-decision logic is broader than the admin trigger. ADMIN IS REQUIRED when accumulating records, configurable settings, manual trigger, OR scheduled cron — only the third bullet is the admin trigger. A webhook + admin-records-viewer feature legitimately has `triggerTypes: ["webhook"]` and `appCategory: "backend_admin"`. So only the forward direction (`"admin"` ∈ triggerTypes ⇒ admin in archetype) is a hard rule; the reverse is correctly llm territory (rows 12–15).

---

## Counts

- **24 rules** total across the product agent's two prompts
- **15 validate** → **5 static** rule-rows (⏳ all TODO — no static layer exists today) + **10 llm** rule-rows that the new product section in `agent_rules` will own
- **9 skip** → **3 no** (style: sentence-counting / suggestion ordering) + **6 paranoid** (output-shape rules covered by `extract_json` + the analyze-flow JSON-parse fallback, plus rows 2 and 7 reclassified during re-audit)

---

## Action plan for this round

1. **Build `llm_validations/product_intent.py`** — one public entry point `validate_product_intent(intent: Dict) -> List[str]`, returns error strings (empty = valid). Same shape as `validate_architect_plan`. Covers rows 6, 8, 9, 10, 11 above.
2. **Wire it into `crew.py`** — call after `run_product_agent` returns, before passing intent to the architect. On error, fail the job with an actionable error message (mirror how `validate_architect_plan` failures are surfaced).
3. **Add a "PRODUCT INTENT — what to look for:" section to `agent_rules.py`** SYSTEM_PROMPT covering the 10 LLM rule-rows (admin-decision logic, storefront-classification logic, scope discipline, qualityBrief specificity, analyze-flow rules).
4. **bug_finder** — no extension needed. Product intent is single-artifact (no cross-artifact reasoning required); agent_rules carries the semantic load.
5. **Tests** — add fixtures for the five static checks (each clean ✓ + each broken ✗). One `tests/test_product_intent.py` file, ~10 tests total.
