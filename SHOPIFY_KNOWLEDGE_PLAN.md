# Shopify Knowledge Injection Plan

Goal: improve gen quality on Shopify GraphQL by replacing broad prose context with **JIT-injected, scenario-level code examples** mined from Shopify's own docs and a small, hand-picked set of GitHub repos.

Admin first. Storefront later, as a replay of the same playbook on a smaller surface.

---

## Guiding principles

1. **Examples beat prose.** The schema already says what's *possible*. Worked examples say what's *typical*. Few-shot a closest example at gen time.
2. **JIT, not always-on.** Retrieve by mutation/query name or family. Keep always-loaded content under ~300 tokens.
3. **Narrow before broad.** Cover the **top 50 admin operations actually used by Shopify apps today** before expanding to the long tail.
4. **Every phase ships behind a flag and is measured against the baseline.** No improvement → fix or drop, don't pile on.

---

## The focused operation list (Phase 1 input)

We do **not** index all ~600 admin mutations up front. We start from a hand-picked list of **the operations most commonly used by Shopify apps today** — products, variants, inventory, media, webhooks, metafields, customers, store context, orders, fulfillment, collections, discounts, bulk ops, selling plans, i18n, themes, content, segments, 3PL.

The validated list lives at:

**[platform-ai/catalogs/shopify_admin/phase1_operations.yaml](platform-ai/catalogs/shopify_admin/phase1_operations.yaml)** — 96 operations, every name verified against `schema.graphql`. Naming corrections (e.g. `productVariantCreate` → `productVariantsBulkCreate`, `fulfillmentCreateV2` → `fulfillmentCreate`, `metafieldDelete` → `metafieldsDelete`) are documented in the `CHANGES` section at the bottom of that file.

The list started from a target of ~50; after grouping by family (queries + their CRUD mutations) it grew to 96. That's still a fraction of the ~600-mutation surface and remains hand-verifiable.

Anything outside this list is explicitly **out of scope** for Phase 1. Once it proves the pipeline lifts gen quality, expanding to the next batch is mechanical.

---

## Eval strategy — bug-finder now, synthetic harness later

The chain currently fails to produce working apps end-to-end: the bug-finder agent surfaces many runtime and deploy-time errors. **In that state, a synthetic 96-op eval is premature.** Pass/fail on a synthetic prompt would be dominated by chain-wide failure modes that have nothing to do with the example bank, drowning out the signal we actually want to measure.

**While the chain is unstable: the bug-finder is the eval.**
- Wire knowledge artifacts (example bank, gotchas slices) into the chain.
- Re-run real prompts. Watch the bug-finder's failure list shrink — and watch *which* failure types disappear (wrong input shape, wrong field names, wrong pagination, etc. should drop first).
- The signal is qualitative + per-bug-class, not a single pass-rate number. That's appropriate for the current state.

**When the chain stabilizes (apps generate end-to-end on the 11 real prompts):** revisit the synthetic 96-op harness as a regression and coverage tool. Not before.

This means: no `phase0_baseline.json` aggregate number, no per-op synthetic harness in Phase 1. The 11 real prompts + the bug-finder's output are the feedback loop.

---

## Phases

### Phase 1 — Admin example bank + JIT injection (current phase)

**Goal: cut the GraphQL-shape bugs the bug-finder catches today.** Done when those specific bug classes drop on real prompts.

**What we actually do:**

1. **Scrape** the `shopify.dev` page for each of the 96 operations — `/docs/api/admin-graphql/latest/mutations/<name>` for mutations, `/docs/api/admin-graphql/latest/queries/<name>` for queries. Each page exposes 3–8 named scenarios with full query + variables JSON + response JSON. — **DONE** ([build_shopify_examples_bank.py](platform-ai/scripts/build_shopify_examples_bank.py))
2. **Extract** per scenario: `{operation, kind, family, scenario_title, query, variables, response, source_url}` → one JSONL entry. — **DONE** (312 scenarios from 80/96 ops in [examples.jsonl](platform-ai/catalogs/shopify_admin/examples.jsonl); 16 ops have no worked examples on shopify.dev — accepted gap, fall back to schema-only for those)
3. **Loader module** (~30 lines): load `examples.jsonl` into `{operation → [scenario, …]}` at startup. Expose `get_example(op_name, intent_hint=None) → str | None` returning a formatted `<example>...</example>` block, top-1 by scenario-title token overlap with `intent_hint`, capped at ~500 tokens.
4. **Wire injection** into the chain: locate the GraphQL-writing prompt builder (the step *after* the planner picks an op, *before* the LLM call). Append the loader's output when non-null. Behind a flag.
5. **Smoke test against bug-finder failures:** pick 3–5 prompts where the bug-finder currently flags GraphQL-shape bugs (wrong input type, missing `userErrors`, wrong pagination, hallucinated fields, etc.). Re-run with the bank wired in. Bugs of those classes should disappear.
6. **Gate:** if those bug classes don't drop, fix the loader/retrieval (wrong scenario picked? injection format wrong? not reaching the prompt?) before Phase 2. If new bug classes appear (e.g. retrieved scenario contradicts user intent), tighten retrieval.

Out of scope for Phase 1: object/enum/connection pages (the schema covers them), help.shopify.com, RFC/MDN/Wikipedia links — all dropped as noise.

### Phase 2 — Engine-level gotchas (2 days)

Distill the ~10 `/api/usage/*` pages — pagination, bulk operations, idempotency keys, throttle/retry, search syntax, versioning — into a short, **always-loaded** engine slice. Hard cap ~300 tokens. Format: rule + one canonical snippet each.

Re-run real prompts. Expect "wrong pagination shape" / "missed idempotency key" / "didn't use bulk for >250" bug-finder hits to drop.

### Phase 3 — Family-quirk slices (3–5 days)

Today's [`platform-ai/catalogs/gotchas.py`](platform-ai/catalogs/gotchas.py) is too broad and too thin at the same time. Split into JIT-loaded family slices:
- metafields (ownerType rules, type-to-value coupling)
- inventory (location semantics, tracked vs untracked)
- fulfillment (FulfillmentOrder vs Fulfillment)
- discounts (automatic vs code, function-backed)
- products (variants/options coupling, media)
- … one slice per mutation family touched by the 96.

JIT-load only the slice(s) matching the operations in play. Re-run real prompts; watch family-specific bugs drop.

### Phase 4 — Synthetic 96-op eval harness (only when chain is stable)

**Trigger:** the 11 real prompts in `cli/test_prompts/` produce working apps end-to-end (bug-finder reports few or no GraphQL-shape bugs).

Then build the cheap version:
- One templated prompt per op from the YAML `note` field.
- Pass = generated GraphQL parses + root field name == op.
- Output: pass rate over 96.
- Run twice: bank disabled vs enabled. Lift = delta.

This becomes the regression + coverage tool from that point on. **Do not build it before the trigger.**

### Phase 5 — Storefront (later)

Replay the playbook on storefront, which is a smaller surface (~280 doc links, ~10K-line schema, mostly read-only):
1. Pick top **20 storefront operations** (cart, checkout, product fetch, search, customer account).
2. Build storefront example bank from `/docs/api/storefront/latest/...` pages.
3. Lift engine gotchas where they apply (pagination still does).
4. Augment with snippets from the curated GitHub repos (next section) — storefront flows are the strongest case for repo-mined examples.

Should be ~half the effort of admin because the playbook is proven.

### Phase 6 — Optimize (ongoing)

- Mine the example bank for a "commonly-used fields" prior — bias gen toward typical shapes unless the user asks otherwise.
- Build an intent classifier from scenario titles for tighter retrieval than fuzzy matching.
- Trim always-loaded content as JIT retrieval proves itself.

---

## GitHub repos — selective use only

We do **not** index whole repos. We use them to fill specific gaps the doc pages can't:
- **Multi-step flows** (mutation A → mutation B → mutation C)
- **Storefront end-to-end** patterns

Repos worth mining, and only for the parts noted:

| Repo | Mine for | When |
|---|---|---|
| `Shopify/storefront-api-examples` | Storefront query patterns: cart, checkout, product fetch | Phase 4 |
| `Shopify/hydrogen` (`examples/` dir only) | Storefront flows in production code | Phase 4 |
| `Shopify/example-apps` | Multi-call admin flows (e.g. create product → publish → add to collection) | Phase 1/3 only if eval shows multi-call failures |
| `Shopify/shopify-app-template-remix` | App-skeleton patterns (auth, webhooks, billing, GDPR) | **Defer indefinitely** — not GraphQL gen, surrounding app code |

Repos explicitly skipped: `polaris` (UI), `cli` (tooling), `app-bridge` (frontend), SDK repos (we generate raw GraphQL, not SDK calls — revisit only if that changes).

Rule for repo work: extract **specific snippets** keyed to the 50 (or storefront 20) operations. Do not bulk-import. Each extracted snippet must answer a question the doc page can't.

---

## Token-cost budget

Naïve "load everything" would balloon context. Concrete budget per gen call:

| Source | Tokens | When loaded |
|---|---|---|
| Engine gotchas | ~300 | Always |
| Mutation example (top-1 scenario) | ~500 | JIT, by operation |
| Family-quirk slice | ~200 | JIT, only if family matched |
| **Floor** | **~300** | |
| **Ceiling** | **~1,000** | |

Net is likely **down**, not up, vs today: the schema dump and broad gotchas.py shrink, and fewer wrong-shape outputs mean fewer retry round-trips. This is a measurement claim — verify it on the Phase 0 baseline at every phase boundary.

---

## Deliverables checklist

- [x] Operation list: [phase1_operations.yaml](platform-ai/catalogs/shopify_admin/phase1_operations.yaml) (96 ops, schema-validated)
- [x] Scraper: [build_shopify_examples_bank.py](platform-ai/scripts/build_shopify_examples_bank.py)
- [x] Example bank: [examples.jsonl](platform-ai/catalogs/shopify_admin/examples.jsonl) (312 scenarios, 80/96 ops)
- [ ] Phase 1: loader module + injection wired into chain + bug-finder smoke test on 3–5 prompts showing target bug classes drop
- [ ] Phase 2: engine-gotchas always-loaded slice (≤300 tokens) + re-run real prompts
- [ ] Phase 3: family-quirk slices (one file per family, JIT-loaded) + re-run real prompts
- [ ] Phase 4 (only when chain is stable): synthetic 96-op eval harness + before/after lift number
- [ ] Phase 5: storefront top-20 + storefront example bank
- [ ] Phase 6: continuous, no fixed deliverable

---

## Non-negotiables

1. **The bug-finder is the eval while the chain is unstable.** No synthetic 96-op harness until apps generate end-to-end on the 11 real prompts.
2. **Generic pipeline lift is the goal**, not any specific app. The 96 list defines the surface we are equipping the chain to handle.
3. **Each knowledge phase ships behind a flag** and is judged by: which bug-finder failure classes drop, which (if any) appear. Phases that don't move that needle get fixed or dropped before the next phase starts.
4. **Synthetic harness comes back in Phase 4** as a coverage and regression tool — once it can produce meaningful signal.
