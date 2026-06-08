# Evaluation — i-m-selling-on-shopify-and (Product Bundles)

- Run: platform-ai/cli/test_results/2026-06-08T21-38-21_i-m-selling-on-shopify-and
- Date: 2026-06-08
- Pipeline reached: coding (complete — `coding_done_called=true`, 113 turns, `final_tsc.clean=true`, **`forced=true` with 1 unresolved critical**)

> Note: `GENERATION_QUALITY_PLAN.md` is absent from the repo. Graded against the rubric as summarized in the skill: §1 4-vs-3 line (no crash / no silent feature death / no protocol violation), §3 bug classes, §6 invariants. This run was generated with the new product→HLD handoff (intent carries `excluded: []` and a full, enumerated `qualityBrief`).

## Stage ranks

| stage       | rank/5 | one-line rationale |
|-------------|--------|--------------------|
| product     | 4      | qualityBrief is rich and complete (both bundle types, all 3 discount kinds, tiered rules, storefront+admin, edge cases); `excluded=[]` correct. Capped: the "default to automatic" + "apply the code via Cart API" lines are internally contradictory (automatic discounts have no code to apply) and seeded the HLD's discount-model error. |
| hld         | 3      | Strong spine and real Phase-2 bindings, but one structural gap the plan never closes: `compute-bundle-price` is `integration:null` with no live-price source, so the explicitly-required "live discounted total" is unbuildable from the plan → silent-feature-death traces here. |
| hld_v       | 4      | Caught 3 real, precisely-located issues (2 critical: discount-model incompatibility, purchase-count attribution; 1 important: search op) with actionable fixes and no hallucinations; missed the `compute-bundle-price` live-total gap. |
| hld_revise  | 5      | Applied all 3 findings exactly (code-based discounts + `discount_code_string` column; `orders/create`→`discount_codes[].code` + dedup table; search op `product`→`products`); unflagged sections untouched. |
| coding      | 3      | Most capabilities genuinely realized (real product search, real discount mutations, real cart ops, real webhook dedup), but forced out with the flexible "all-variants" add-to-cart unreachable, and papered over the missing live total instead of fetching Storefront prices. |

## Overall: 3/5

No crash, no protocol violation, and the discount path is real end-to-end. Capped at 3 by **two silent-feature-deaths** on prominent, explicitly-requested behaviors: (1) flexible bundles in "all variants" mode can never be added to cart, and (2) the "live discounted total" is never shown. Weakest link is a tie — **hld** (no price data source for the live total) and **coding** (forced out with the flexible "all-variants" path broken).

## App findings

| # | severity | class (§3) | file:line | finding |
|---|----------|-----------|-----------|---------|
| 1 | high | silent-feature-death | _tsc_ui/widget/widget.ts:536-538, 610-611 | Flexible bundles in "all variants" mode: `selectedGids` filters out the `__resolve:product:` sentinels, so `validGidCount=0` → "Add Bundle to Cart" stays disabled, "Items selected" shows 0, and the tier is computed on 0. The customer can never add such a bundle; the on-click `resolveSentinelGids` path (:623) is unreachable. This is the `forced_completion` critical. |
| 2 | moderate | silent-feature-death | _tsc_ui/widget/widget.ts:544-588 | The "live discounted total" the merchant explicitly required (bundle total + discount + final discounted total, updating live) is never shown — only a discount label ("20% off"). Code comment admits "we don't have per-item prices… show discount info only." Root: HLD `compute-bundle-price` has no live-price source (no Storefront price fetch). |
| 3 | low | cosmetic | _tsc_ui/widget/widget.ts:489 | Step-2 "count met" uses `state.selectedVariants.size` (counts sentinels), but Step-3 enable uses the sentinel-filtered count — a customer is allowed past Step 2 only to hit a permanently-disabled button at Step 3 (no explanation shown). Subset of #1. |

## Capability realization

| capability (HLD) | status | evidence |
|------------------|--------|----------|
| list-bundles-admin | realized | admin.ts:289-307 select with purchase_count, paginated |
| search-products-admin | realized | admin.ts:399-405 real `products(first:20, query:$query, after:$cursor)` full-text search |
| create-bundle | realized | admin.ts:86 `discountCodeBasicCreate`, :139 `discountCodeBxgyCreate`; stores `discount_code_string` |
| update-bundle | realized | admin.ts:212 `discountCodeBasicUpdate`, :249 `discountCodeBxgyUpdate` |
| delete-bundle | realized | admin.ts:589/764 `discountCodeDelete` with userError handling |
| load-widget-bundles | realized | widget.ts loads bundles + items for the product page |
| compute-bundle-price | partial | widget.ts:544-588 computes tier + discount label only; no bundle total / final price (finding #2) |
| add-bundle-to-cart | partial | widget.ts:242 `cartLinesAdd` + :268 `cartDiscountCodesUpdate` real; broken for flexible "all-variants" (finding #1) |
| increment-purchase-count | realized | webhook-handlers.ts:20-83 `orders/create`, dedup via `bundle_order_increments`, matches `discount_codes[].code` |
| refresh-item-availability | realized | webhook-handlers.ts:92-135 `products/update` (active + inventory) and `products/delete` set `available` |

## Revise effectiveness

| hld_v finding (location) | severity | addressed? | evidence in final plan |
|--------------------------|----------|-----------|------------------------|
| discount-model incompatible (create-bundle automatic vs add-to-cart code) | critical | yes | create-bundle ops → `discountCodeBasicCreate`/`discountCodeBxgyCreate`; `bundles.discount_code_string` added; add-to-cart keeps `cartDiscountCodesUpdate` |
| increment-purchase-count has no buildable path | critical | yes | `bundles.discount_code_string` column added; `orders/create` bound to `discount_codes[].code`; `bundle_order_increments` dedup table |
| search-products-admin op is singular `product` | important | yes | op switched to plural `products` (accepts `query`); code uses `products(first:20, query:$query)` |

## Token cost

| stage | in | out | cache_read | cache_create |
|-------|----|----|-----------|-------------|
| product | 17,235 | 2,297 | 9,666 | 5,487 |
| hld | 53,622 | 6,850 | 185,167 | 50,483 |
| hld_v | 24,425 | 2,862 | 0 | 24,415 |
| hld_revise | 35,354 | 4,073 | 100,865 | 43,657 |
| coding | 115 | 77,803 | 12,074,857 | 148,926 |
| validators | 266,295 | 11,345 | 0 | 0 |

## Notes

- **Fix verification (product→HLD handoff):** the intent carries the new `excluded` field (`[]` here — nothing was dropped) and the `qualityBrief` is the full enumerated spec rather than 3–5 sentences. Both confirm the run used the updated pipeline. No dropped-feature regression applies to this prompt.
- **Forced completion:** coding used 113 turns and was force-completed with exactly the finding #1 critical outstanding. This is a coding-capacity outcome on a genuinely large app (fixed + flexible bundles × 3 discount kinds × tiered rules × storefront + admin), not a product/HLD regression. (See the separate turn-budget investigation.)
- **hld_v cache anomaly persists:** `hld_v` shows 0 cache_read / 24,415 cache_create — the architect/validator/revise tool sets differ, so the shared system-prompt prefix never matches across stages; each writes its own ~24K entry that nothing reads. Same structural cause documented in the prior run's eval.
- **Live-total root cause is HLD, not coding:** the widget legitimately has no price data — `load-widget-bundles` returns item ids/availability but no prices, and no capability fetches Storefront variant prices. The coding agent's "show discount info only" is a reasonable response to an under-specified plan; the fix belongs in the HLD (`compute-bundle-price` needs a Storefront price-fetch step), then the widget.
