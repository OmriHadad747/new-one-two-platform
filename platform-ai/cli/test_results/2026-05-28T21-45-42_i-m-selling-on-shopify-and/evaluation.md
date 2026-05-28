# Evaluation — i-m-selling-on-shopify-and (product bundles)

- Run: platform-ai/cli/test_results/2026-05-28T21-45-42_i-m-selling-on-shopify-and
- Date: 2026-05-28
- Pipeline reached: hld_revise / hld_v (halted early — no scaffold)

## Stage ranks

| stage       | rank/5 | one-line rationale |
|-------------|--------|--------------------|
| product     | 4      | Correct archetype (storefront+backend+admin) and resources (products, discounts); rich, faithful qualityBrief (dup-delivery, flexible-min, graceful disable, tier-misconfig feedback, order-note attribution). No invented scope. |
| hld         | 4      | Final plan binds real Shopify protocols, not fakes: native `productBundleCreate` + `discountAutomaticAppCreate/Update/Activate/Deactivate/Delete`; correct topics; `add-bundle-to-cart` = `cartCreate`→`cartNoteUpdate`. Capped by two binding nits below. |
| hld_v       | 5      | Caught two real criticals + one important, precise locations + actionable fixes, no hallucinated findings. Exactly the semantic value the layer exists for. |
| hld_revise  | 4      | Applied both criticals correctly; left the important (money/ratio) unaddressed. |
| coding      | —      | not run |

## Overall: incomplete — halted at hld_v/hld_revise

The HLD stage delivered **production-aligned bindings** — most notably the
discount is a real Shopify *automatic discount* via the native bundle API,
which is exactly the faked-discount failure (Bug A) the old run shipped.
Strong evidence Phase 2 works. Weakest link in what ran: the revise leaving
the `money` vs `ratio` role ambiguity on discount columns, plus an
out-of-stock topic-fit question no one flagged (below).

## Revise effectiveness

| hld_v finding (location) | severity | addressed? | evidence in final plan |
|--------------------------|----------|-----------|------------------------|
| pause-on-component-change had `integration:null` but its description requires deactivating the Shopify discount (plan-level effect-not-realized) | critical | **yes** | `handle-product-unavailability` is now `shopify-admin` with `discountAutomaticDeactivate` |
| one automatic-discount node per tier → tiers stack (10%+20%+30% concurrently) | critical | **yes** | no per-tier-node capability; tiers handled by `validate-tier-configuration` + a single discount in `create-bundle` |
| `discount_value` columns role `money` but purpose says "or percentage" — neither money nor ratio | important | **no** | `bundles.discount_value` and `bundle_tier_rules.discount_value` are still `role: money` with "amount or percentage" purpose |

## Token cost  (from state.json)

- product: 8,341 in / 866 out
- hld: 38,298 in / 7,747 out (+170,797 cache-read, +24,039 cache-create)
- hld_v: 19,686 in / 2,948 out (+12,411 cache)
- hld_revise: 45,181 in / 7,799 out (+124,933 cache-read, +23,229 cache-create)
- HLD chain total ≈ 103k in / 18.5k out, dominated by cheap cache-reads
  (~308k) — the tool-loop + revise cost, mostly cached.

## Notes

- The single highest-value outcome: the discount protocol is real
  (native automatic discount, created/activated/deactivated/deleted as an
  ordered sequence), directly closing the old run's "discount faked via a
  cart property" class at plan time.
- Watch (unflagged): "a product is updated (… availability changed)" binds
  to `products/update`. Pure inventory-level changes fire
  `inventory_levels/update`, which `products/update` may not cover — the
  graceful out-of-stock disable could miss that path. Debatable, not
  clearly wrong; worth confirming against the webhook catalog on the next run.
