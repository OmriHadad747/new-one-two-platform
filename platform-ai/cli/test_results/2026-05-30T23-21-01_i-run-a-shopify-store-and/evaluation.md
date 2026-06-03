# Evaluation — i-run-a-shopify-store-and (back-in-stock notifier)

- Run: `platform-ai/cli/test_results/2026-05-30T23-21-01_i-run-a-shopify-store-and`
- Date: 2026-06-01
- Pipeline reached: coding (halted late — 9 `done()` calls all returned `ok: false`; agent kept editing past the last attempted close, scaffold + last successful `run_tsc` (idx 145) present, no final `done: ok=true`)

## Stage ranks

| stage       | rank/5 | one-line rationale |
|-------------|--------|--------------------|
| product     | 5      | qualityBrief captures every named edge (dup webhook, guest checkout, deleted products, inventory races, dup signup, unsubscribe, quiet-hours, conversion window); archetype/resources/triggers all fit. |
| hld         | 4      | spine intact, all Phase-2 bindings present and resolved; but `notification_batches.keyedBy` says "calendar date of detected_at" while the unique key is on the raw timestamp — plan-internal contradiction; no global suppression list survives F1. |
| hld_v       | 4      | three precise findings (no hallucinations, exact paths); missed the calendar-date / unique-key contradiction and the NULL-variant `dashboard_snapshots` uniqueness gap. |
| hld_revise  | 3      | F2 and F3 fully applied (page-supplied display/url, `variant_gid` column); F1 left half-fixed — keeps `status='unsubscribed'` rows but adds no `suppressed_emails` table, so the failure mode F1 named (re-signup after unsubscribe) still ships. |
| coding      | 3      | every surface built and tsc-clean at idx 145; but unsubscribe email link is unreachable, calendar-date dedup not implemented, product-level conversion attribution is a fragile heuristic, NULL-variant snapshot upsert duplicates rows; run never closed (`done()` ok=false ×9). |

## Overall: 3/5

Weakest link: **coding** — a silent feature death on the email unsubscribe link (cron emits a GET URL with no matching route) caps the app at ≤3 under §1, and the upstream hld_revise stage left the suppression table unmade so the re-signup-after-unsubscribe path is also dead.

## App findings

| # | severity | class (§3) | file:line | finding |
|---|----------|-----------|-----------|---------|
| 1 | critical | silent-feature-death (8) | scaffold/src/routes/cron.ts:226 | Email `{{unsubscribe_url}}` is built as `https://${shopDomain}/apps/back-in-stock/unsubscribe?token=…` (GET); only `POST /widget/unsubscribe` exists (widget.ts:307). Clicking the link in any sent email cannot unsubscribe the shopper — violates the prompt's "Every email needs a working unsubscribe." |
| 2 | critical | idempotency / races (7) | scaffold/src/routes/webhook-handlers.ts:227 + scaffold/app.json:159 | `notification_batches` unique key is `(product_external_id, variant_external_id, detected_at)` with `detected_at` a raw timestamp; the plan's `keyedBy` mandated calendar-date dedup. Two `inventory_levels/update` deliveries on the same day each insert a batch → duplicate notification storms (each capped only by `available_quantity_at_detection`). |
| 3 | important | silent-feature-death (8) | scaffold/src/routes/webhook-handlers.ts:325-330 | Product-level conversion match falls through to a query that looks up `waitlist_entries` whose variants match `line_items[].variant_id`. If no other shopper happens to be waiting on any of the order's variants for the same product, `productMatchRows` is empty and `isMatch = false` — the order payload's own `line_items[].product_id` is never consulted, so product-level conversions silently fail in the common case. |
| 4 | important | persistence-safety / null-disables (7,8) | scaffold/src/routes/cron.ts:360-378 | `ON CONFLICT (product_external_id, variant_external_id) DO UPDATE` for product-level (NULL variant) snapshot upserts. Postgres unique constraints treat NULLs as distinct, so each completed product-level batch INSERTs a fresh `dashboard_snapshots` row instead of updating — breaks the dashboard's per-item ranking invariant. (Widget signup handles this correctly with an explicit SELECT-then-UPDATE/INSERT branch at widget.ts:264-294 — cron diverges.) |
| 5 | important | null-disables-feature (8) | scaffold/src/routes/widget.ts:212-238 | Signup INSERT uses `ON CONFLICT (shopper_email, product, variant) DO NOTHING`. If the existing row has `status='unsubscribed'`, the user is told `already_signed_up: true` and stays unsubscribed; the cron only sends to `status='active'`. Re-subscribe after unsubscribe is silently dead. (Exactly the hld_v F1 failure mode — left unfixed in revise.) |
| 6 | cosmetic | UI navigability | scaffold/admin/ui.ts:42-56 | Nav exposes only Dashboard / Settings — the Subscribers section is reachable only via the per-row "View Subscribers" link, never directly. Non-blocking; mentioned for completeness. |

## Capability realization

| capability (HLD) | status | evidence |
|------------------|--------|----------|
| check-item-availability | realized | scaffold/src/routes/widget.ts:48-67 (Storefront `product` query, GID) |
| record-waitlist-signup | realized | scaffold/src/routes/widget.ts:212-238 (insert with ON CONFLICT DO NOTHING) |
| get-signup-status | realized | scaffold/src/routes/widget.ts:126-142 |
| resolve-variant-from-inventory-item | realized | scaffold/src/routes/webhook-handlers.ts:124-137 (Admin `inventoryItem` query) |
| confirm-variant-availability | realized | scaffold/src/routes/cron.ts:149-158 (Admin `productVariant`, gated by stored `variant_gid`) |
| create-notification-batch | realized | scaffold/src/routes/webhook-handlers.ts:207-228 (but see finding #2: dedup key wrong) |
| send-restock-notification-email | realized | scaffold/src/routes/cron.ts:239-242 (`platform.email.send`) |
| mark-entry-notified | realized | scaffold/src/routes/cron.ts:260-267 |
| process-unsubscribe | **broken** | scaffold/src/routes/widget.ts:307-348 endpoint exists, but the only caller (email link, cron.ts:226) targets a non-existent path → finding #1 |
| record-conversion | **faked (product-level)** | scaffold/src/routes/webhook-handlers.ts:336-368 — variant-level branch realizes the conversion insert; product-level branch realizes a row only when the fragile heuristic returns a match → finding #3 |
| cascade-delete-waitlist | realized | scaffold/src/routes/webhook-handlers.ts:242-259 (tx: cancel pending batches + DELETE waitlist + DELETE snapshots) |
| list-waitlist-dashboard | realized | scaffold/src/routes/admin.ts:39-160 (snapshot scan, cursor pagination, overall metrics) |
| list-subscribers-for-item | realized | scaffold/src/routes/admin.ts:164-310 |
| export-subscribers-csv | realized | scaffold/src/routes/admin.ts:314-469 (cursor pagination + filter validation at :435) |
| read-settings | realized | scaffold/src/routes/admin.ts:473-509 |
| save-notification-template | realized | scaffold/src/routes/admin.ts:513-575 (atomic singleton upsert) |
| save-quiet-hours | realized | scaffold/src/routes/admin.ts:579-640 (atomic singleton upsert, IANA tz validated) |
| read-conversion-metrics | realized | scaffold/src/routes/admin.ts:109-132 (aggregate inside `/admin/dashboard`) |

## Revise effectiveness

| hld_v finding (location) | severity | addressed? | evidence in final plan / code |
|--------------------------|----------|-----------|------------------------------|
| F1 — unsubscribe-shopper has no backing table for global suppression (`capabilities[id=unsubscribe-shopper], persistence`) | critical | **partial** | Revise kept the "set status='unsubscribed'" approach (widget.ts:335-340) but added no `suppressed_emails` table. The failure mode F1 named — re-signup after unsubscribe — still ships as finding #5. |
| F2 — record-waitlist-signup needs product_title / variant_title / product_url but the widget POST didn't carry them (`externalContracts[/widget/waitlist/signup], capabilities[record-waitlist-signup]`) | important | **yes** | Plan's contract now includes `item_display_name` and `item_page_url` in the signup requestShape (state.json `externalContracts` :830-842); widget.ts:208-217 sends them; route writes them (widget.ts:213-218). |
| F3 — `productVariant.produces` wrong and variant GID untraceable in queue (`triggers[schedule].perTickWork, capabilities[verify-stock-before-send]`) | important | **yes** | `notification_batches.variant_gid` column added (app.json:115-120); webhook handler stores the GID from `inventoryItem.variant.id` (webhook-handlers.ts:144, 220); cron uses `storedVariantGid` and refuses to fabricate (cron.ts:139-148, 157). |

## Token cost

Per `state.json` `tokens_*` (coding not recorded in state.json; no separate `token_usage.json` exists):

- product:    9,281 in /    943 out  (+8,260 cache_read,  +416 cache_create)
- hld:       66,257 in / 19,768 out  (+190,013 cache_read, +42,969 cache_create)
- hld_v:     20,775 in /  4,592 out  (+0 cache_read,       +20,765 cache_create)
- hld_revise: 33,496 in / 15,299 out (+137,762 cache_read, +13,838 cache_create)
- coding / validators: not recorded (manifest shows 148 tool calls — 61 edits, 18 tsc, 9 `done` attempts all ok=false)

## Notes

- The run **halted without a successful `done()`** — all 9 attempts returned `ok: false`, the last validator report (tool_calls/130_done/output.json) flagged 5 issues, and the agent then performed a few more edits without re-running tsc or `done()`. The scaffold is internally type-clean as of idx 145 but the loop never closed; treat this as "incomplete-but-graded" rather than a clean exit.
- Two of the five remaining downstream-validator findings (NULL-variant snapshot upsert in cron, calendar-date dedup) match the human-grading findings #4 and #2 above — the validators are catching real bugs but the agent ran out of iterations before fixing them.
- Two other downstream-validator complaints in the last report are false positives against the current code: (a) the export route does already filter rows by requested product/variant at admin.ts:435-443; (b) the `available > 0` early-return at webhook-handlers.ts:205 is *correct* (zero stock is not a restock event) — the validator's framing was wrong. Useful signal that the §6 validators occasionally over-fire on legitimate guards.
- The agent followed the topic-selection protocol cleanly (3× `list_webhook_family`, 3× `get_webhook_topic`, 3× `list_shopify_ops`, 3× `get_shopify_op`) and picked all three correct topics (`inventory_levels/update`, `products/delete`, `orders/paid`) — the §11 wrong-topic risk did not recur.
