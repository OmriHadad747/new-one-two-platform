# Evaluation — i-m-selling-on-shopify-and (product bundles)

- Run: platform-ai/cli/test_results/2026-05-29T23-01-16_i-m-selling-on-shopify-and
- Date: 2026-05-29
- Pipeline reached: coding (halted early — manually shut down after coding tool #63; `done()` rejected 3× at #50/#55/#62 and never succeeded)

## Stage ranks

| stage       | rank/5 | one-line rationale |
|-------------|--------|--------------------|
| product     | 4      | Thorough, on-target intent + qualityBrief (tiering, live-total parity, count validation, OOS, race-free counts); minor: omits `orders` from resources though `orders/paid` is consumed. |
| hld         | 3      | Solid data model and mostly-correct Phase-2 bindings, but the central discount-application model is incoherent end-to-end (automatic discount scoped to the bundle product, yet the storefront cart is built from component variants) and two `hld_v` findings remain. |
| hld_v       | 4      | 5 precise, real, well-located findings with actionable fixes and no hallucinations; missed the deepest issue — the bundle-product-vs-component-cart discount gap. |
| hld_revise  | 3      | Applied findings #1/#3/#4 cleanly; left #5 (toggle two-step sequence) untouched and "fixed" #2 by rewording the edge case to rely on `products/update` (which never fires on a hard delete) instead of adding the `products/delete` trigger it asked for. |
| coding      | 3      | Impressively complete, tsc-clean, 5 surfaces; discounts genuinely provisioned (autopsy Bug A gone) and Bug B fixed — but the storefront add-to-cart passes a product id as a variant merchandise GID and the discount never reaches the component cart. |

## Overall: 3/5  (as-of-interruption — run manually halted at coding tool #63, `done()` never passed)

Weakest link: the **storefront purchase path**, rooted in the HLD's incoherent discount-application model. The widget sends `product_external_id` where `cartCreate` requires a variant GID ([widget/widget.ts:309](scaffold/widget/widget.ts#L309)), and the automatic discount is scoped to the bundle product while the cart is built from component variants — so for the only bundle configuration the admin UI can actually create (product-level members), add-to-cart fails and/or the discount silently never applies. Everything upstream of that (admin CRUD, real discount provisioning, idempotent webhooks, rollback) is 4-grade work; this one cross-cutting gap caps the app. Note the agent itself was not satisfied (`done()` rejected 3×) and may have intended further fixes before the manual shutdown.

## App findings

| # | severity | class (§3) | file:line | finding |
|---|----------|-----------|-----------|---------|
| 1 | crash / silent-feature-death | 2 (Shopify-effect) / 5 (ref hop) | [widget/widget.ts:309](scaffold/widget/widget.ts#L309), [src/routes/widget.ts:460-463](scaffold/src/routes/widget.ts#L460-L463) | Frontend selects `member.variant_external_id ?? member.product_external_id`, ignoring the real `member.live.variant_external_id` the route resolved ([src/routes/widget.ts:170](scaffold/src/routes/widget.ts#L170)); a product id is then wrapped as `gid://shopify/ProductVariant/${id}` → `cartCreate` gets an invalid/wrong merchandise id. Storefront purchase broken for product-level members (the only kind the admin can create). |
| 2 | silent-feature-death | 2 (Shopify-effect not realized) | [src/routes/admin.ts:67-70](scaffold/src/routes/admin.ts#L67-L70), [src/routes/widget.ts:460-463](scaffold/src/routes/widget.ts#L460-L463) | Automatic discount is scoped to the **bundle product** (`productsToAdd:[shopifyProductGid]`), but add-to-cart adds **component variants**, not the bundle product → the discount engine never matches the cart → discount never applies at checkout (autopsy Bug A in a subtler, plan-level form). |
| 3 | silent-feature-death | 8 (null-disables-feature) | [widget/widget.ts:282-288](scaffold/widget/widget.ts#L282-L288) | Fixed-bundle pre-selection only adds members with `variant_external_id`; product-level members (all of them, per the admin UI) have it null → selection stays empty → add-to-cart button never enables for a fixed bundle. |
| 4 | important (missing feature) | — | [admin/ui.ts:418-441](scaffold/admin/ui.ts#L418-L441) | Admin offers only a product picker; `variant_external_id` is always null on create. The prompt explicitly asked to "pick products **or specific variants**" — variant pinning is unreachable from the UI. |
| 5 | important (data quality) | logic | [src/routes/webhook-handlers.ts:33-67](scaffold/src/routes/webhook-handlers.ts#L33-L67) | `record-bundle-purchase` counts any paid order containing **any** member product/variant and ignores `discount_codes` entirely → over-counts non-bundle purchases of member products; bundle-product line items wouldn't match component-keyed members. |
| 6 | cosmetic / coverage | 1 (topic) | [app.json:92](scaffold/app.json#L92) | No `products/delete` subscription; hard-deleted products never fire `products/update`, so member auto-disable on deletion (an explicit edge case) relies on widget-load re-validation only. |

## Capability realization

| capability (HLD) | status | evidence |
|------------------|--------|----------|
| fetch-variant-details (`productVariant`) | realized | [src/routes/widget.ts:65-101](scaffold/src/routes/widget.ts#L65-L101) |
| create-bundle (`productBundleCreate` → `discountAutomaticBasicCreate`) | realized | [src/routes/admin.ts:333-356](scaffold/src/routes/admin.ts#L333-L356), [admin.ts:50-83](scaffold/src/routes/admin.ts#L50-L83) — GIDs threaded into refs |
| create-bxgy-tier-discount (`discountAutomaticBxgyCreate`) | realized | [src/routes/admin.ts:95-139](scaffold/src/routes/admin.ts#L95-L139) |
| update-bundle (`productBundleUpdate` + `discountAutomaticBasicUpdate`) | realized-with-deviation | [admin.ts:536-598](scaffold/src/routes/admin.ts#L536-L598) — re-creates via `…Create`+deactivate; bound `…BasicUpdate` op never called |
| update-bxgy-tier-discount (`discountAutomaticBxgyUpdate`) | faked / op absent | update path re-provisions via `…BxgyCreate`; `discountAutomaticBxgyUpdate` is never invoked |
| list-bundles | realized | [src/routes/admin.ts:206-238](scaffold/src/routes/admin.ts#L206-L238) (offset, not the plan's cursor) |
| toggle-bundle-enabled (`Activate`/`Deactivate`) | realized (conditional) | [src/routes/admin.ts:742-780](scaffold/src/routes/admin.ts#L742-L780) — code branches correctly despite plan listing both as a sequence |
| compute-live-bundle-total | realized | [src/routes/widget.ts:203-317](scaffold/src/routes/widget.ts#L203-L317) |
| validate-bundle-selection | realized (server-side) | [src/routes/widget.ts:397-425](scaffold/src/routes/widget.ts#L397-L425) |
| add-bundle-to-cart (`cartCreate`) | broken | [src/routes/widget.ts:460-501](scaffold/src/routes/widget.ts#L460-L501) — op called but wrong merchandise GID + discount not applied (findings #1, #2) |
| mark-bundle-members-unavailable | realized | [src/routes/webhook-handlers.ts:84-148](scaffold/src/routes/webhook-handlers.ts#L84-L148) |
| record-bundle-purchase | realized-but-imprecise | [src/routes/webhook-handlers.ts:69-81](scaffold/src/routes/webhook-handlers.ts#L69-L81) — idempotent `ON CONFLICT`, but over-counts (finding #5) |

## Revise effectiveness

| hld_v finding (location) | severity | addressed? | evidence in final plan |
|--------------------------|----------|-----------|------------------------|
| `line_item_groups` non-existent payload field | critical | yes | orders/paid now binds `line_items[].product_id`, `line_items[].variant_id`, `discount_codes[].code` (state.json `plan.triggers[0].payloadBindings`) |
| no `products/delete` trigger for the delete edge case | critical | no (reworded) | Still only `orders/paid` + `products/update`; `edgeCases[1]` reworded to rely on `products/update`, which doesn't fire on hard delete |
| `product` single-lookup op can't do search+pagination | important | yes | Backend product search dropped (admin uses client-side `pickResource`); `fetch-variant-details` correctly binds `productVariant` |
| `discountAutomaticBasicUpdate` applied to BXGY unconditionally | important | yes | Split into `update-bundle` (basic) + `update-bxgy-tier-discount` (`discountAutomaticBxgyUpdate`) |
| toggle lists both `Activate`+`Deactivate` as a sequence | important | no | `capabilities[6].shopifySteps` still lists both ops sequentially (code branches correctly anyway) |

## Token cost

Per state.json `tokens_*` (coding/validators not recorded — no `tokens_coding`, no `token_usage.json`):
- product: 9,037 in / 811 out (+4,130 cache read, 4,457 cache create)
- hld: 55,080 in / 7,659 out (+148,202 cache read, 56,161 cache create)
- hld_v: 19,494 in / 2,711 out (+19,484 cache create, 0 cache read)
- hld_revise: 38,728 in / 12,662 out (+158,812 cache read, 28,449 cache create)
- coding / validators: not recorded

## Notes

- Big improvements vs the autopsy run (§11): discounts are genuinely provisioned via real ops with GIDs threaded into `bundle_discount_external_refs` (Bug A's faked discount is gone), and `product_external_id` comes from validated picker GIDs, never `"0"` (Bug B fixed). Idempotent `ON CONFLICT` counts and full create/update rollback (deactivate + product delete) are strong, beyond what the rubric requires.
- The remaining failure has migrated upward: it is no longer a "wrong topic / placeholder id" bug but a **plan-coherence** bug about *how an automatic discount on a bundle product reaches a component-variant cart* — exactly the cross-file Shopify-effect class §6 targets. `e_hld_v` did not flag it, and no downstream Shopify-effect validator exists yet to catch it post-code; this run is direct evidence for Phase 3.
- The coding agent twice recovered from plan defects (toggle conditional, BXGY-kind branch), which suggests the unaddressed `hld_v` findings #2/#5 are lower-risk than the discount-application gap the plan got wrong *and* the validator missed.
- Caveat: artifacts are as-of tool #63 (manual shutdown); `done()` had rejected 3×, so the agent may have had pending fixes. Re-run to confirm whether findings #1–#3 persist to a clean `done()`.
</content>
</invoke>
