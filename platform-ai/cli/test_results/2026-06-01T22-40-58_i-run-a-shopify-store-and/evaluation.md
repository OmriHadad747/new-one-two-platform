# Evaluation — i-run-a-shopify-store-and (back-in-stock notifier)

- Run: `platform-ai/cli/test_results/2026-06-01T22-40-58_i-run-a-shopify-store-and`
- Date: 2026-06-01
- Pipeline reached: coding (complete — tsc clean, `done()` called at turn 44)

## Stage ranks

| stage       | rank/5 | one-line rationale |
|-------------|--------|--------------------|
| product     | 5      | qualityBrief captures variant detection, dedup, fair queue, 7-day attribution, quiet hours, atomic unsubscribe — no overreach, nothing dropped |
| hld         | 2      | the email subsystem is mis-modelled at the architecture level: the plan invents an app-owned `notification_settings` table and a `global-unsubscribe` capability that duplicate platform-owned services (`AppEmailConfig` for templates, `email_suppressions` for unsubscribe, MJML footer-injection for the link). No execution path declared for quiet-hours deferral. Spine + bindings for the three webhooks are clean, which is why this isn't a 1. |
| hld_v       | 3      | catches surface symptoms — missing GET unsubscribe route, missing scheduler, missing failure_reason column — but doesn't see the larger architectural mismatch (the entire local-template + local-unsubscribe sub-design is redundant with platform services). Precise on what it does see; misses the upstream issue. |
| hld_revise  | 2      | rewrote the notification_emails table out of the design (making finding 3 moot in form) but **left finding 1 unaddressed** in spirit, and didn't reconcile templates/unsubscribe with the platform's existing services. Quiet-hours edge case retained, execution path removed. |
| coding      | 3      | tsc clean, every route registered, every webhook handler wired, ON CONFLICT used on dedup keys. But built an entire local template-rendering + unsubscribe-token system that the platform already provides, passes `data: { subject, body }` to `platform.email.send` (wrong shape — platform substitutes its template against `data`, doesn't use those keys), and never writes the platform's `AppEmailConfig` so sends will return `missing_config`. |

## Overall: 2/5

Weakest link: **the HLD didn't model the platform's email subsystem**, so the coding agent built a parallel template-and-unsubscribe stack the platform already provides — and got the `platform.email.send` call shape wrong (passes `data: { subject, body }` where the platform expects `data` to be `{{var}}` substitutions for the platform-stored template). Without an `AppEmailConfig` row written for this app, every send returns `delivered:false, reason:"missing_config"`. Combined with the quiet-hours stall and the unreachable app-side unsubscribe, the entire notification feature — the merchant's core ask ("hear from me the moment it's available again") — is non-functional out of the box. Per §1, "any feature unreachable through the UI" caps at 3; here the *only* outbound communication channel is silently dead from the moment of deploy, which is a stronger 2.

## App findings

| # | severity | class (§3) | file:line | finding |
|---|----------|-----------|-----------|---------|
| 1 | critical | silent-feature-death | `scaffold/src/routes/webhook-handlers.ts:344-352` + plan: `notification_settings` table | The app duplicates a service the platform already owns. `platform.email.send({to, data})` reads the merchant template from the **platform's** `AppEmailConfig` (per-app row in `platform-back`, edited via the platform's own admin at `PUT /email/apps/:appId/config`) and does its own `substituteVariables` over `data`. The generated app, however, stores `template_subject`/`template_body` in its OWN `notification_settings` table, renders them locally, and passes the rendered strings as `data: { subject, body }` — keys the platform template never references. So: (a) the merchant's edits via the app's `PUT /admin/settings` go to a dead table and never reach a real send; (b) the platform's `AppEmailConfig` is never written by this app, so every send returns `delivered:false, reason:"missing_config"` (sender.ts loads it before render). Result: no email ever leaves. The whole notification feature dies silently. |
| 2 | critical | silent-feature-death | `scaffold/src/routes/webhook-handlers.ts:156-164` | Quiet-hours branch logs "deferring notifications" and returns. The restock_event row stays `status='open'`. There is no cron, no scheduled trigger, and the next `inventory_levels/update` re-delivery hits `ON CONFLICT (inventory_item_external_id, status) DO NOTHING` (line 134) and is treated as a no-op. Any restock that lands in the merchant's quiet window is dropped forever. The platform's email service has no scheduled-send primitive either — this needed a `schedule` trigger in the plan; `hld_v` flagged the missing scheduler and `hld_revise` removed the deferred-send design without replacing it. |
| 3 | important | silent-feature-death | plan: `capabilities[global-unsubscribe]` + `widget/widget.ts:241-279` | The app's parallel unsubscribe system is unreachable from real emails. The platform auto-injects its **own** HMAC-signed unsubscribe link (`renderer.ts:140-141`) routed to `/email/u/:token` (`email-public.ts`), which on confirm writes to platform-wide `email_suppressions`. The app's `unsubscribe_token` column (random 32-byte hex), its `POST /widget/unsubscribe` route, and the widget's `?bis_unsubscribe=…` handler are never reached by a customer. Two follow-on data-model gaps: (a) when a customer unsubscribes via the platform link, the app's `waitlist_entries.status` stays `active` — the admin dashboard misreports active subscribers and the prompt's "clears the shopper from all their waitlists" data-side effect is unfulfilled; (b) future `platform.email.send` to that recipient silently returns `reason:"suppressed"` while the app still credits "notified" status to the entry (`webhook-handlers.ts:369-376`). |
| 4 | important | protocol-violation | `scaffold/src/routes/widget.ts:206-223` | `queue_position` is computed as `SELECT MAX(queue_position)+1` then inserted without a unique constraint on `(item_external_id, queue_position)` — two concurrent signups for the same item produce duplicate positions, breaking the "front of queue" ordering the prompt guarantees ("if only a few units come back and many are waiting, notify the front of the queue"). Not a crash, but the fairness invariant slips. |
| 5 | minor | silent-feature-death | `scaffold/src/routes/widget.ts:215-224` | `ON CONFLICT … DO UPDATE SET email = EXCLUDED.email` returns the existing row for a same-email same-item resignup, but if the prior row is `status='unsubscribed'` the UPDATE leaves the status alone — the shopper sees `already_existed: true` and "you're on the waitlist," but they are still unsubscribed and won't receive emails. The plan (`edgeCases[5]`) explicitly says this should be a no-op returning `already_existed`, so the plan calls for this behavior — flagged anyway as a likely UX surprise. |

## Capability realization

| capability (HLD) | status | evidence |
|------------------|--------|----------|
| check-item-availability | realized | `widget.ts:20-118` — Storefront `product`/`node` query, both `variant` and `product` scopes |
| register-signup | realized (with queue-race) | `widget.ts:172-237` — ON CONFLICT on (email, item_external_id); queue_position via MAX+1 (#4 above) |
| global-unsubscribe | **redundant / unreachable (#3)** | platform auto-injects HMAC-signed footer link to `/email/u/:token`; app's POST `/widget/unsubscribe` and `unsubscribe_token` column are never reached from a real email |
| resolve-variant-from-inventory-item | realized | `webhook-handlers.ts:62-94` — `inventoryItem(id:)` admin GraphQL, GID parsed |
| open-restock-event | realized | `webhook-handlers.ts:128-149` — INSERT with ON CONFLICT on (inventory_item_external_id, status) |
| dispatch-restock-notifications | **wrong send-shape (#1), broken in quiet hours (#2)** | `webhook-handlers.ts:286-402` — passes pre-rendered subject/body in `data`; platform expects `data` to be {{var}} substitutions; AppEmailConfig never written so sends return `missing_config` |
| purge-product-waitlist | realized | `webhook-handlers.ts:180-191` |
| record-conversion | realized | `webhook-handlers.ts:215-281` — 7-day window, ON CONFLICT idempotency, sets status=converted |
| list-waitlist-entries | realized | `routes/admin.ts:84+` |
| export-waitlist-csv | realized | `routes/admin.ts` (export route present in app.json) |
| read-dashboard-ranking | realized | `routes/admin.ts:22-80` — GROUP BY item, ORDER BY active_count DESC |
| read-recovered-demand-stats | realized | `routes/admin.ts` (stats route present) |
| save-notification-settings | **decorative (#1)** | `routes/admin.ts` reads/writes the app's `notification_settings` row; the platform reads the merchant template from `AppEmailConfig` and ignores this row entirely — typing into the editor doesn't change emails |

## Revise effectiveness

| hld_v finding (location) | severity | addressed? | evidence in final plan |
|--------------------------|----------|-----------|------------------------|
| GET /widget/unsubscribe missing — email links 404 | critical | **no** | final plan still declares only `POST /widget/unsubscribe`; code at `webhook-handlers.ts:332` still emits a GET URL into emails |
| No schedule trigger to dispatch deferred quiet-hours emails | critical | **changed the design, not the bug** | revise dropped the entire `notification_emails` table and the deferred-send approach; quiet-hours edge case (`edgeCases[2]` in final plan: "hold the entire batch") still has no execution path — see app finding #2 |
| `notification_emails.failure_reason` column missing | important | **moot** | revise removed the `notification_emails` table entirely; in-flight failures are now `console.warn` only — failure observability quietly downgraded |

## Token cost

Per-stage (from `state.json` tokens_* + `token_usage.json`):

| stage | input | output | cache_read | cache_create |
|-------|------:|------:|----------:|------------:|
| product | 9,309 | 966 | 8,260 | 416 |
| hld | 54,295 | 15,618 | 162,090 | 14,955 |
| hld_v | 22,432 | 2,135 | 14,655 | 7,767 |
| hld_revise | 50,781 | 12,285 | 137,086 | 13,305 |
| coding (44 turns) | 46 | 47,185 | **2,821,293** | 77,684 |
| validators | **156,602** | 6,269 | **0** | 156,592 |
| **totals** | **293,465** | **84,458** | **3,143,384** | **270,719** |

**Cost observations:**

- **Validators are paying full freight every call.** `cache_read=0` and `cache_create=156,592` mean the static validator system prompts (which §7 of `GENERATION_QUALITY_PLAN.md` calls out as "identical hour after hour — paid once, read cheaply") are *not* benefiting from the 1h ephemeral cache. Of the 293k uncached input tokens in this run, **53% (156,602) sat in the validators alone** — and they only emitted 6,269 output tokens. The §7 promised cache discipline is the single biggest leverage point.
- **Coding agent caching is healthy.** 2.82M cache_read against 77.7k cache_create over 44 turns — a ~36:1 ratio, which is what you want from `ephemeral, ttl 1h`. The coding loop is not the cost culprit.
- **HLD + hld_revise cost 0.13M uncached input combined** (54.3k + 50.8k = 105.1k in, plus 28.3k cache_create). The two-phase HLD design with a revise pass is expensive; given that this revise *did not fix the hld_v finding it was given*, the 50.8k input + 12.3k output of `hld_revise` is largely wasted spend on this run.
- **44 coding turns** with `coding_done_called=true` and `forced_completion.count=0` is within budget — but a successful tsc + done() that ships a broken unsubscribe link shows that turns/tsc-clean is not a quality proxy. Spend more turns on validators (which would have caught #1, #2, #3) and you'd cap fewer 3/5 outcomes — exactly the §6 trade.

**Rough $ shape** (Anthropic public input/output/cache rates apply to your provider):
- Uncached input: 293k tok
- Cache-create: 271k tok (1.25× input)
- Cache-read: 3.14M tok (0.1× input)
- Output: 84k tok (5× input)

At Sonnet rates ($3 in / $15 out / $3.75 cache-create / $0.30 cache-read): ~$0.88 in + $0.34 cache-create + $0.94 cache-read + $1.27 out ≈ **$3.43**. Coding (cache-heavy) is ~$0.94 of that. Validators (zero cache-read) are ~$0.47 + $0.59 ≈ **$1.06 — a third of the bill** for findings that didn't catch either silent-feature-death bug above. Fix the validator caching and that drops by 90%.

## Notes

- **Root cause of the email-subsystem failure is upstream of coding.** The HLD doesn't model the platform's email service as a *service the app calls into* — it models it as a Shopify-like external dependency the app must implement around. So the plan re-invents `notification_settings` (template), `unsubscribe_token` (link), and quiet hours (scheduling) — all three of which are platform concerns. The HLD prompt likely needs an explicit "platform-services" catalog alongside the Shopify catalog: which platform features exist (`email.send` + `AppEmailConfig`, file storage, scheduled jobs?), what the app passes in vs. what the platform owns, and a binding step that says "this capability is satisfied by platform service X" rather than "build it locally."
- `final_tsc.json` reports `errors: 0` and `forced_completion.json` reports `forced: false` — the agent finished honestly. The gate doesn't see "you re-invented a platform service" (out of `tsc` scope, in `hld_v`'s scope but it missed it).
- `hld_v` caught the right surface symptoms (no GET unsubscribe, no scheduler, no failure_reason); `hld_revise` is still allowed to drop a critical finding silently. A "every critical finding must be acknowledged in the revised output" gate on revise would have closed at least the GET-unsubscribe gap, even if it wouldn't have caught the deeper redundancy.
- The webhook handler's `dispatchRestockNotifications` marks failed emails as `status='notified'` anyway (lines 369-378) — by design per the plan's edge case, but combined with #1 above it means EVERY email is "successfully notified" in the admin dashboard while none actually leave. Plan-compliant, but the combination compounds the silent failure.
