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

## The 50-operation focus list

We do **not** index all ~600 admin mutations up front. We pick the **50 most commonly used admin operations across real Shopify apps today** and build everything around them first.

How to pick the 50 (in order of preference):
1. Mine `cli/test_prompts/` — every prompt there reflects a real app pattern; extract the operations it touches.
2. Cross-reference with Shopify's own "Common use cases" / examples sections on `shopify.dev`.
3. Fill gaps from `Shopify/example-apps` and `shopify-app-template-remix` — what they actually call.
4. Tie-break by surface area: products, variants, inventory, orders, fulfillment, customers, metafields, discounts, webhooks, bulk operations.

The 50 list is a deliverable of Phase 0. It is checked in and reviewed before Phase 1 starts. Anything outside the 50 is explicitly **out of scope** for the first cycle.

Why 50 and not 600: a focused bank we can hand-verify beats a giant bank we can't trust. Once the 50 prove the pipeline lifts gen quality, expanding to the next 100 is mechanical.

---

## Phases

### Phase 0 — Baseline (1 day)

**We already have a CLI test harness:** `platform-ai/cli/test_prompts/` (input prompts) and `platform-ai/cli/test_results/` (recorded outputs). Use it.

Tasks:
- Curate the **50-operation list** (see above) and check it in as `platform-ai/catalogs/shopify_admin/top50.yaml` (or similar).
- Map each existing test prompt to the operations it exercises. Identify gaps; add prompts so the 50 are reasonably covered.
- Run the current chain over the full prompt set. Record per-prompt: success/fail, retry count, total tokens, wall time, validation errors.
- Save as `phase0_baseline.json`. **This is the only number that matters for the rest of the plan.**

### Phase 1 — Admin mutation example bank (3–4 days) — **start here**

**What we actually do:**
1. **Scrape** the `shopify.dev` mutation page for each of the 50 operations (`/docs/api/admin-graphql/latest/mutations/<name>`). Each page already exposes 5–8 named scenarios with full query + variables JSON + response JSON.
2. **Extract** per scenario: `{operation, scenario_title, query, variables, response, notes}` → one JSONL entry. Expected ~300–400 entries from 50 mutations.
3. **Store** as `platform-ai/catalogs/shopify_admin/examples.jsonl`, indexed by `operation` (and optionally by `scenario_title`).
4. **Wire JIT retrieval** into the gen chain: when the planner picks a mutation, look up its entries and inject the closest scenario as a few-shot block (top-1 by scenario-title similarity to the user intent; fall back to first scenario).
5. **Cap injection budget** at ~500 tokens per call.
6. **Re-run** the Phase 0 prompt set. Compare success rate, retry count, tokens.
7. **Gate:** if success rate or retries don't move, fix retrieval (wrong scenario picked? schema mismatch?) before Phase 2. Don't stack phases on a broken foundation.

Out of scope for Phase 1: object/enum/connection pages (the schema covers them), help.shopify.com, RFC/MDN/Wikipedia links — all dropped as noise.

### Phase 2 — Engine-level gotchas (2 days)

Distill the ~10 `/api/usage/*` pages — pagination, bulk operations, idempotency keys, throttle/retry, search syntax, versioning — into a short, **always-loaded** engine slice. Hard cap ~300 tokens. Format: rule + one canonical snippet each.

Re-run prompt set. Expect fewer "wrong pagination shape" / "missed idempotency key" / "didn't use bulk for >250" failures.

### Phase 3 — Family-quirk slices (3–5 days)

Today's [`platform-ai/catalogs/gotchas.py`](platform-ai/catalogs/gotchas.py) is too broad and too thin at the same time. Split into JIT-loaded family slices:
- metafields (ownerType rules, type-to-value coupling)
- inventory (location semantics, tracked vs untracked)
- fulfillment (FulfillmentOrder vs Fulfillment)
- discounts (automatic vs code, function-backed)
- products (variants/options coupling, media)
- … one slice per mutation family touched by the 50.

JIT-load only the slice(s) matching the operations in play. Re-run prompt set.

### Phase 4 — Storefront (later)

Replay the playbook on storefront, which is a smaller surface (~280 doc links, ~10K-line schema, mostly read-only):
1. Pick top **20 storefront operations** (cart, checkout, product fetch, search, customer account).
2. Build storefront example bank from `/docs/api/storefront/latest/...` pages.
3. Lift engine gotchas where they apply (pagination still does).
4. Augment with snippets from the curated GitHub repos (next section) — storefront flows are the strongest case for repo-mined examples.

Should be ~half the effort of admin because the playbook is proven.

### Phase 5 — Optimize (ongoing)

- Mine the example bank for a "commonly-used fields" prior — bias gen toward typical shapes unless the user asks otherwise.
- Build an intent classifier from scenario titles (Phase 1 output) for tighter retrieval than fuzzy matching.
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

- [ ] Phase 0: `top50.yaml` + `phase0_baseline.json`
- [ ] Phase 1: `examples.jsonl` + JIT retrieval wired into chain + Phase 1 eval report
- [ ] Phase 2: engine-gotchas always-loaded slice (≤300 tokens) + Phase 2 eval report
- [ ] Phase 3: family-quirk slices (one file per family, JIT-loaded) + Phase 3 eval report
- [ ] Phase 4: storefront top-20 + storefront example bank + Phase 4 eval report
- [ ] Phase 5: continuous, no fixed deliverable

---

## Non-negotiables

1. The 50-operation list is checked in **before** Phase 1 starts.
2. Phase 0 baseline numbers exist **before** Phase 1 code is written.
3. Each phase compares against the baseline before the next phase starts. Phases that don't move the number get fixed or dropped.
