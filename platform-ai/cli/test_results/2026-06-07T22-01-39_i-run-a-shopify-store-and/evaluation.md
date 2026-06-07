# Evaluation — i-run-a-shopify-store-and (Back In Stock Notify)

- Run: platform-ai/cli/test_results/2026-06-07T22-01-39_i-run-a-shopify-store-and
- Date: 2026-06-07
- Pipeline reached: coding (complete — `coding_done_called=true`, 92 turns, `final_tsc.clean=true`, `forced=false`)

> Note: `GENERATION_QUALITY_PLAN.md` was removed from the repo (commit 8756f36). Graded against the rubric as summarized in the skill: §1 4-vs-3 line (no crash / no silent feature death / no protocol violation), §3 bug classes, §6 invariants.

## Stage ranks

| stage       | rank/5 | one-line rationale |
|-------------|--------|--------------------|
| product     | 4      | qualityBrief is rich and accurate; the two omissions (quiet hours, "lost demand recovered") were dropped by explicit operator instruction — not a defect — and the HLD recovers both from the raw prompt. |
| hld         | 4      | Strong spine, real Phase-2 bindings, all five tables justified; one subtle gap — `orders/paid` binds only variant ids, so product-level conversion attribution is structurally impossible. |
| hld_v       | 4      | Caught 4 real, precisely-located issues with actionable fixes and no hallucinations; missed the product-level conversion-binding gap. |
| hld_revise  | 5      | Applied all 4 findings exactly (schedule trigger added, usesWorkflow swapped, attribution field added, product-level snapshot fallback documented); unflagged sections untouched. |
| coding      | 4      | Every capability genuinely realized (real GraphQL ops, real CSV upload, real email batch); faithfully implemented the plan, including its one conversion-binding limitation. |

## Overall: 4/5

No crash, no protocol violation, no faked capability — all 17 capabilities are really implemented and the whole app is internally consistent end-to-end. The single thing capping it: **product-level conversion attribution is silently impossible** (variant-level works). Weakest link is now **hld** — the `orders/paid` trigger binds only variant ids, so product-level conversions can't be matched — and **hld_v** slipped past it. (The product brief's omissions were operator-instructed and are not counted against it.)

## App findings

| # | severity | class (§3) | file:line | finding |
|---|----------|-----------|-----------|---------|
| 1 | moderate | silent-feature-death | src/routes/webhook-handlers.ts:572-577, types/contracts.ts:107-109 | Product-level conversions are never attributed: `OrderPaidLineItem` has only `variant_id`, and the matcher keys on `ws.item_external_id = variantId`. Product-level signups (item id = product id) can never match → merchant's "lost demand recovered" undercounts for product-level waitlists. Traces to the HLD `orders/paid` binding (variant ids only). |
| 2 | low | silent-feature-death | src/routes/webhook-handlers.ts:206-212 | On a 429 mid-batch the immediate-dispatch loop `break`s, leaving remaining sends `pending`, but `workflow.attempt` then transitions the batch out of `pending`; the cron only repicks `status='pending'` batches, so the unsent tail is never retried. |
| 3 | low | cosmetic | src/routes/widget.ts:207-212 | `/unsubscribe` does not decrement `demand_stats_snapshots.waitlist_count`; dashboard ranking is stale-high after unsubscribes until the next restock/conversion refresh recomputes it (bounded staleness). |
| 4 | low | cosmetic | src/routes/admin.ts:117-128 | CSV export only quotes a field when it contains a comma; embedded quotes/newlines aren't escaped and there is no CSV-injection guard (leading `= + - @`). Low impact for email/id columns. |

## Capability realization

| capability (HLD) | status | evidence |
|------------------|--------|----------|
| record-waitlist-signup | realized | widget.ts:83-90 insert with ON CONFLICT (email,item) → duplicate no-op |
| check-signup-status | realized | widget.ts:154-169 |
| resolve-restocked-variant | realized | webhook-handlers.ts:384-418 real `inventoryItem` GraphQL, GID parse |
| select-and-open-notification-batch | realized | webhook-handlers.ts:645-680 atomic batch insert + FIFO LIMIT batchSize + sends |
| fetch-item-details-for-email | realized | webhook-handlers.ts:113-175 real `productVariant`/`product` queries |
| send-restock-notification-email | realized | webhook-handlers.ts:193 `platform.email.sendBatch` |
| record-send-outcome | realized | webhook-handlers.ts:199-223 marks sent/failed, increments emails_sent |
| refresh-demand-stats-snapshot | realized | webhook-handlers.ts:244-345; product-level fallback handled (264-298) |
| unsubscribe-shopper | realized | widget.ts:207-212 marks all pending+notified unsubscribed |
| cascade-delete-product-waitlists | realized | webhook-handlers.ts:496-518 transactional soft-delete |
| record-conversion | partial | webhook-handlers.ts:553-604 variant-level works; product-level never matched (finding #1) |
| list-dashboard-products | realized | admin.ts:31-50 paginate over snapshots, ranked by waitlist_count |
| list-product-subscribers | realized | admin.ts:54-87 |
| export-subscribers-csv | realized | admin.ts:104-145 builds bytes, `platform.files.upload`, returns real url |
| read-settings | realized | admin.ts:150-163 |
| save-settings | realized | admin.ts:167-229 with bounds (batch 1-10000, days 1-90, HH:MM) |
| quiet-hours dispatch (schedule) | realized | cron.ts:51-105 dispatches deferred batches once outside window |

## Revise effectiveness

| hld_v finding (location) | severity | addressed? | evidence in final plan |
|--------------------------|----------|-----------|------------------------|
| save-settings missing `conversion_attribution_window_days` in PUT requestShape | important | yes | PUT /admin/settings requestShape now includes `conversion_attribution_window_days: count`; dataNeed reachable |
| `usesWorkflow` on wrong capability | important | yes | send-restock-notification-email→`false`, record-send-outcome→`true` |
| quiet hours promised but no realizer | important | yes | schedule trigger (every 15 min) added; quiet hours start/end added to select-and-open-notification-batch dataNeeds |
| product-level snapshot has no variant fallback | minor | yes | refresh-demand-stats-snapshot shopifyStep documents product-query fallback; edgeCase added |

## Token cost

| stage | in | out | cache_read | cache_create |
|-------|----|----|-----------|-------------|
| product | 10,257 | 993 | 4,446 | 4,446 |
| hld | 80,862 | 13,603 | 139,397 | 49,226 |
| hld_v | 24,945 | 4,697 | 0 | 24,935 |
| hld_revise | 3 | 2,609 | 0 | 24,999 |
| coding | 94 | 62,406 | 7,996,629 | 123,088 |
| validators | 148,846 | 7,986 | 0 | 0 |

## Notes

- **Product scope (operator note):** the qualityBrief omits quiet hours and the "lost demand recovered" metric *by explicit instruction* — this is intended scope-narrowing, not a product-stage miss. The features remain in scope and the HLD recovers both from the raw prompt (quiet-hours schedule trigger; conversion tracking). Graded accordingly (no penalty to product). If the intent were to remove these features from the app entirely, the HLD would instead be over-scoped — flag separately if so.
- **HLD cache anomaly (the run's headline curiosity):** `hld_v` and `hld_revise` show 0% cache hit. Cause is structural, not a bug: Anthropic's cache prefix is `[tools][system][messages]` and the breakpoint sits at end-of-system, so a hit requires identical tools AND system. All three stages share a byte-identical system prompt and (per the A/B override in models/agent_models.py) the same model — but the tool sets differ (architect: catalog + `emit_hld_plan`; validator: `emit_hld_findings`; revise: catalog + `patch_plan`), which diverges the prefix before the system block is reached. Each writes its own ~25K cache entry that nothing reads. The comment in e_hld_v_agent/agent.py:43-47 (align thinking_budget → reuse architect cache) is misleading: thinking-budget alignment is necessary but not sufficient; the differing tool block makes cross-stage system-prompt sharing impossible. `hld_v`'s `cache_create=24935` with zero downstream reader is a pure ~25% write surcharge for no benefit.
- The HLD `orders/paid` trigger binds only "purchased variant external ids" + "buyer email" (no product id), and the coding agent's `OrderPaidLineItem` mirrors that. Real Shopify line items carry `product_id`; including it would have let product-level conversions match. Fix belongs in the HLD binding, then the code.
- Internal contract harmonization (not a bug): HLD modeled cursor pagination (`{products, next_cursor, total_count}`); the coding agent reconciled to the platform `paginate` helper's page-based shape (`{items, total, page, page_size}`) consistently across handler, contracts.ts, and admin/ui.ts — dashboard works end-to-end.
- Restock detection uses `available > 0` + a per-day batch bucket for dedup rather than a stock-state baseline table; acceptable here because the widget only renders on sold-out items, so pending signups exist only for items that actually went out of stock.
