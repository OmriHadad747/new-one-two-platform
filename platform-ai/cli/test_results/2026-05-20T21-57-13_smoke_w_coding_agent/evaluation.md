# Evaluation — merchants-create-fixed-and-flexible-product-bundles

- Run: platform-ai/cli/test_results/2026-05-20T21-57-13_smoke_w_coding_agent
- Coding model: claude-sonnet-4-6 (loop.py DEFAULT_MODEL)
- Date: 2026-05-27

## Score: 2/5

The merchant's headline feature — "discount auto-applied" — is faked, not
applied; two further declared behaviors (product-deletion auto-disable,
inventory detection) are silently dead. tsc-clean and deploys, but core
value does not work.

## Severity counts

- crash: 0
- silent-feature-death: 3
- protocol-violation: 1
- cosmetic: 1

## Findings

| # | severity | class (§3) | file:line | finding |
|---|----------|-----------|-----------|---------|
| 1 | protocol-violation | 2 (effect not realized) | widget.ts:380-397 | `/widget/cart/add` returns `applied_discount_rate` + a cosmetic `properties._discount_rate`; no discount op is ever called, so the customer pays full price. The merchant's core feature. |
| 2 | silent-feature-death | 2 / 5 | webhook-handlers.ts:127-156 | `inventory_levels/update` handler computes availability then returns without writing anything ("deferred to products/update"). A subscribed topic that does nothing — the inventory→availability path via the dedicated topic is dead. |
| 3 | silent-feature-death | 3 (write-path) | admin/ui.ts:518-521 | `product_external_id` is written as `p.product_id ?? "0"` (comment: "we'll use placeholder"); every `bundle_items` row stores `0`. |
| 4 | silent-feature-death | 3 (downstream of #3) | webhook-handlers.ts:261-264 | `products/delete` matches `WHERE product_external_id = ${productId}`, which never matches the stored `0` → product-deletion auto-disable never fires. |
| 5 | cosmetic | 2 | webhook-handlers.ts:91-99 | `orders/paid` records `discount_rate_applied` from a note attribute, persisting a discount that was never applied (analytics will overstate discounts). |

## Capability realization

| capability (HLD) | status | evidence |
|------------------|--------|----------|
| apply-bundle-discount-to-cart | **faked** | widget.ts:380-397 — property, not a discount op |
| update-variant-observed-availability | **partial** | products/update works (webhook-handlers.ts:175-210); inventory_levels/update dead (127-156) |
| evaluate/apply-bundle-health (deletion) | **broken** | products/delete no-match via product_external_id=0 (261-264) |
| validate-bundle-selection | realized | widget.ts:112-253 |
| record-bundle-purchase | realized (idempotent) | webhook-handlers.ts:102-118 (ON CONFLICT) |
| create/update/clone/list bundles, items, tiers | realized | admin.ts:120-487 |

## Surface checklist

| surface | verdict | note |
|---------|---------|------|
| backend | pass | routes wired, validation present, idempotent inserts |
| webhooks | fail | 4 correct topics chosen+subscribed, but 1 no-op (inventory) + 1 broken-by-data (delete) |
| admin | fail | item-pool save writes placeholder product ids (untyped surface — not tsc-checked) |
| widget | fail | discount never actually applied |
| db | pass | tables/keys/dedup constraints consistent with handlers |

## Notes

Webhook topic *selection* was correct this run (all four topics, fetched
via list_webhook_family→get_webhook_topic before writing) — the failures
are downstream of plan-to-code gaps, not topic choice. The two highest-
impact bugs (#1 discount faked, #3/#4 placeholder product id) are exactly
the §6 invariants: Shopify-effect realization and write-path integrity.
Both live on surfaces tsc never checks (widget, admin) — supporting the
Phase-1 UI type gate + the §6 validators. This is the baseline; later runs
should move #1–#4 to resolved and lift the score toward 4/5.
