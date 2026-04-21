# Billing & Monetization Architecture

## Overview

Ton uses **Shopify Billing API** for all payment collection. As a custom distribution app,
Ton pays **0% revenue share** to Shopify. Charges appear on the merchant's existing Shopify
invoice — no credit card collection or external payment provider needed.

## Distribution Model

**Custom Distribution** (not listed on Shopify App Store):
- Merchants install via direct link: `https://{PLATFORM_URL}/oauth/install?shop=mystore.myshopify.com`
- Shopify Billing API handles subscriptions (RecurringApplicationCharge)
- 0% revenue share (custom apps are exempt from Shopify's 15% cut)
- Subscription lifecycle tied to app install/uninstall

## Plans

### Plan Limits

| | Free | Starter | Growth | Pro |
|---|---|---|---|---|
| **Trial** | — | 7 days | 7 days | 14 days |
| **Active Apps** | 1 | 3 | 10 | 999 |
| **Generations/mo** | 1 | 3 | 10 | 999 |
| **Revisions/mo** | ∞ | ∞ | ∞ | ∞ |
| **App Categories** | C only | A + C | All (A–D) | All (A–D) |
| **App Executions/mo** | 1,000 | 10,000 | 50,000 | 200,000 |
| **Emails/mo** | 100 | 1,000 | 5,000 | 20,000 |
| **SMS/mo** | 0 | 0 | 100 | 500 |
| **File storage** | 100 MiB | 1 GiB | 10 GiB | 50 GiB |

File storage is a cumulative hard cap across all generated apps for a
tenant. `/services/files/upload` returns 429 when
`current_usage + new_file_size > storage_limit_bytes`. Numbers are
placeholders — revisit before public release. Per-file cap is 25 MiB
regardless of plan; see `docs/FILES_INTEGRATION.md`.

Pricing lives in the [Pricing](#pricing) section below — it's set downstream
of the cost analysis so the numbers are grounded in current LLM + infra costs.

### Why revisions are unlimited

Revisions (changes to existing apps) are **free and unlimited** on all plans because:
1. If the platform generates buggy code, the merchant shouldn't be penalized
2. Distinguishing "bug fix" from "feature change" is unreliable as a billing gate
3. In practice, merchants stop revising after 1-3 iterations

Revisions are **classified** (bug_report / feature_modification / new_capability) for
analytics and product improvement — but never for billing enforcement.

### App Categories

| Category | Description | Available On |
|----------|-------------|--------------|
| A — Storefront + Backend | Widget + handler (no admin UI) | Starter, Growth, Pro |
| B — Storefront + Backend + Admin | Widget + handler + admin panel | Growth, Pro |
| C — Backend Only | Handler only (webhook/cron automation) | Free, Starter, Growth, Pro |
| D — Backend + Admin | Handler + admin panel (no widget) | Growth, Pro |

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        BILLING FLOW                                    │
│                                                                      │
│  Merchant clicks "Upgrade" in dashboard (selects plan + interval)     │
│       │                                                              │
│       ▼                                                              │
│  POST /billing/subscribe { tenantId, plan: "growth", interval: "annual" }│
│       │                                                              │
│       ▼                                                              │
│  shopify-billing.ts → appSubscriptionCreate GraphQL mutation         │
│  (interval: ANNUAL or EVERY_30_DAYS, price adjusted accordingly)      │
│       │                                                              │
│       ▼                                                              │
│  Shopify returns confirmationUrl                                     │
│  → Merchant redirected to Shopify approval page                      │
│       │                                                              │
│       ▼  (merchant clicks "Approve")                                 │
│                                                                      │
│  Shopify redirects to GET /billing/callback?tenant_id=X&plan=Y&interval=annual│
│       │                                                              │
│       ▼                                                              │
│  updateTenantBilling(plan: "growth", interval: "annual", status: "active")│
│  logBillingEvent(subscription_activated, metadata: { interval })      │
│  → Redirect to dashboard with ?billing=success                       │
└──────────────────────────────────────────────────────────────────────┘
```

## Key Components

### Database Tables

```sql
-- Extended tenants table columns:
billing_plan              -- enum: free, starter, growth, pro
billing_interval          -- enum: monthly, annual
subscription_status       -- enum: none, pending, active, frozen, cancelled
shopify_subscription_id   -- Shopify GID
trial_ends_at             -- trial expiry
billing_cycle_anchor      -- period start for usage resets
plan_updated_at           -- last billing change

-- New tables:
usage_records             -- monthly counters (generations, revisions, executions, emails, sms)
revision_classifications  -- analytics: bug_report, feature_modification, new_capability
billing_events            -- audit trail of all billing state transitions
```

### API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/billing/plans?tenantId=X` | List all plans + current plan + billing interval |
| GET | `/billing/usage/:tenantId` | Current usage vs plan limits |
| POST | `/billing/subscribe` | Create Shopify subscription (monthly or annual) → returns confirmation URL |
| GET | `/billing/callback` | Shopify redirects here after approval |
| POST | `/billing/cancel/:tenantId` | Cancel subscription → downgrade to free |
| POST | `/billing/webhook` | Shopify APP_SUBSCRIPTIONS_UPDATE handler (HMAC-verified) |
| GET | `/billing/dashboard/:tenantId` | Comprehensive billing dashboard (usage, events, analytics, subscription) |
| GET | `/billing/analytics/:tenantId` | Revision classification breakdown |

## Plan Enforcement

Enforcement happens at **API route level** — not middleware. Each route checks
the specific limit it needs:

| Action | Enforcement Point | What's Checked |
|--------|------------------|----------------|
| Create app | `POST /tenants/:id/apps` | `canCreateApp()` — active app count vs maxApps |
| Start generation | `POST /generation` | `canStartGeneration()` — monthly generations vs maxGenerationsPerMonth |
| App category | `POST /generation` | `isCategoryAllowed()` — checks `preComputedIntent.appCategory` vs plan |
| Start revision | `POST /generation/:id/revise` | **None** — revisions are unlimited (tracked for analytics) |
| App execution | Webhook gateway | `canExecuteApp()` — monthly executions vs maxAppExecutionsPerMonth |
| Send email | Harness service | `canSendEmail()` — monthly emails vs maxEmailsPerMonth |
| Send SMS | Harness service | `canSendSms()` — monthly SMS vs maxSmsPerMonth |

### Enforcement response format

When a limit is reached, the API returns:
```json
{
  "error": "Your starter plan allows up to 3 apps. You currently have 3.",
  "upgradeHint": "Upgrade to the growth plan for higher limits.",
  "code": "app_limit_reached"
}
```

## Usage Tracking

Counters are stored in `usage_records` (one row per tenant per billing period).
All increments are **atomic** — `SET col = col + 1` to prevent race conditions.

The billing period aligns with the tenant's `billing_cycle_anchor` (set when
the subscription is activated). Usage resets on the anchor day each month,
matching Shopify's billing cycle. A new row is created (via UPSERT) on the
first billable action of each period.

## Revision Classification

Every revision request is classified by the generator's LLM classifier:

| Classification | Description | Example |
|----------------|-------------|---------|
| `bug_report` | Something is broken | "The widget shows a blank page" |
| `feature_modification` | Change existing behavior | "Make the countdown timer red" |
| `new_capability` | Add new functionality | "Also add SMS notifications" |

Classification is **fire-and-forget** — it runs asynchronously after the revision
starts and never blocks the merchant. Results are stored in `revision_classifications`
for product improvement analytics.

### Using analytics

Query the analytics endpoint to understand your product quality:

```bash
GET /billing/analytics/:tenantId
```

Response:
```json
{
  "total": 42,
  "bugReports": 12,
  "featureModifications": 25,
  "newCapabilities": 5
}
```

High `bugReports` ratio → your generators need better prompts for that app type.
High `newCapabilities` ratio → merchants want more from the platform.

## Billing Dashboard

The dashboard endpoint (`GET /billing/dashboard/:tenantId`) returns a comprehensive
view of the tenant's billing state — everything a merchant needs in one API call.

### What it returns

| Section | Description |
|---------|-------------|
| `subscription` | Current plan, billing interval, status, trial end date, cycle anchor, last change |
| `currentUsage` | This period's usage counters + plan limits (for progress bars) |
| `usageHistory` | Last 6 billing periods (for usage charts/trends) |
| `billingEvents` | Most recent 50 billing events (subscription changes, upgrades, downgrades) |
| `revisionAnalytics` | Breakdown of revision types (bug reports, modifications, new capabilities) |
| `appCount` | Active apps vs plan limit |

### Example response

```bash
GET /billing/dashboard/:tenantId
```

```json
{
  "subscription": {
    "plan": "growth",
    "interval": "annual",
    "status": "active",
    "trialEndsAt": null,
    "billingCycleAnchor": "2026-03-15T00:00:00.000Z",
    "planUpdatedAt": "2026-03-15T10:30:00.000Z"
  },
  "currentUsage": {
    "usage": {
      "generations": 4,
      "revisions": 12,
      "appExecutions": 23456,
      "emailsSent": 1200,
      "smsSent": 35
    },
    "limits": {
      "maxApps": 10,
      "maxGenerationsPerMonth": 10,
      "maxAppExecutionsPerMonth": 50000,
      "maxEmailsPerMonth": 5000,
      "maxSmsPerMonth": 100,
      "trialDays": 7
    }
  },
  "usageHistory": [
    { "periodStart": "2026-03-15", "generations": 4, "revisions": 12, "appExecutions": 23456, "emailsSent": 1200, "smsSent": 35 },
    { "periodStart": "2026-02-15", "generations": 8, "revisions": 20, "appExecutions": 41000, "emailsSent": 3500, "smsSent": 80 }
  ],
  "billingEvents": [
    { "eventType": "subscription_activated", "fromPlan": "starter", "toPlan": "growth", "createdAt": "2026-03-15T10:30:00.000Z" }
  ],
  "revisionAnalytics": {
    "total": 42,
    "bugReports": 12,
    "featureModifications": 25,
    "newCapabilities": 5
  },
  "appCount": {
    "active": 6,
    "limit": 10
  }
}
```

All queries run in parallel (`Promise.all`) — the endpoint is efficient even
with 6 concurrent DB queries.

## Subscription Lifecycle

```
Install (OAuth)
  └─ Tenant created with billing_plan="free", billing_interval="monthly", subscription_status="none"
     │
     ▼
Merchant clicks "Upgrade to Growth" (selects monthly or annual)
  └─ POST /billing/subscribe { plan: "growth", interval: "annual" }
     └─ Shopify subscription created with ANNUAL interval
     └─ subscription_status = "pending"
        │
        ▼
Merchant approves on Shopify
  └─ GET /billing/callback → plan activated
     └─ billing_plan = "growth", billing_interval = "annual", subscription_status = "active"
        │
        ▼
Billing handled by Shopify (monthly or annually) → state changes via webhook:
  └─ POST /billing/webhook (APP_SUBSCRIPTIONS_UPDATE)
     ├─ Payment OK     → subscription_status stays "active"
     ├─ Payment failed → subscription_status = "frozen", billing_plan = "free", billing_interval = "monthly"
     ├─ Trial expired  → Shopify sends EXPIRED status → billing_plan = "free"
     └─ Uninstalled    → subscription_status = "cancelled", billing_plan = "free"
        │
        ▼
Merchant cancels manually
  └─ POST /billing/cancel/:tenantId
     └─ Cancels Shopify subscription + billing_plan = "free", billing_interval = "monthly"
```

## Cost Analysis

Numbers below reflect Claude 4.x pricing at time of writing (Sonnet 4.6: ~$3/MT
input, ~$15/MT output; Haiku 4.5: ~$1/MT input, ~$5/MT output) and the current
pipeline where 7 of 9 agents run on Sonnet, with extended thinking gated by
`needs_extended_thinking()` in `generator/subagents/base.py` (stateMachine,
cronBatching, 2+ webhook topics, or widget+admin combo).

| Component | Cost per Unit | Notes |
|-----------|--------------|-------|
| LLM generation (simple) | ~$0.30 | ~30k in / 12k out, no extended thinking |
| LLM generation (typical) | ~$0.40 | ~40k in / 18k out, mixed Sonnet + Haiku |
| LLM generation (high-complexity) | ~$0.55 | ~50k in / 25k out, extended thinking enabled |
| LLM revision | ~$0.40 | Same pipeline as generation |
| Revision classification | ~$0.001 | Single Haiku call (~200 in / 128 out) |
| Cloud Run per generation | ~$0.02 | 2Gi generator container, 2-3 min runtime |
| Cloud Run per app execution | ~$0.000005 | 256Mi handler, typical 50-200ms |
| Email (via Resend) | ~$0.001 | Pay-as-you-go tier; lower on volume plans |
| SMS (US, via Twilio) | ~$0.005 | Per outbound message |
| Shared infra (amortized) | ~$0.50/tenant/mo | PostgreSQL + Redis + Pub/Sub at mid-stage scale (~100 tenants) |

### Margin by plan

Two columns below: **moderate usage** (realistic average merchant) and
**worst case** (merchant exhausts the quota _and_ drives heavy revision
traffic). Revisions are unlimited, so worst-case cost is unbounded in
principle — the figure below assumes ~15 revisions/app (an aggressive but
plausible power user) plus plan-capped email/SMS/execution usage.

Annual plans are ~17% cheaper for merchants but cost the same to operate,
so margins are slightly lower on annual — but revenue is pre-committed
for 12 months, which offsets the reduced monthly rate.

| Plan | Interval | Revenue/mo | Moderate cost | Moderate margin | Worst-case cost | Worst-case margin |
|------|----------|-----------|---------------|-----------------|-----------------|-------------------|
| Free | — | $0 | ~$1.80 | loss leader | ~$5 (1 gen + many revisions) | loss leader |
| Starter | Monthly | $29 | ~$5 | **~83%** | ~$20 | **~31%** |
| Starter | Annual | $24.17 ($290/yr) | ~$5 | **~79%** | ~$20 | **~17%** |
| Growth | Monthly | $59 | ~$16 | **~73%** | ~$49 | **~17%** |
| Growth | Annual | $49.17 ($590/yr) | ~$16 | **~67%** | ~$49 | **~0%** |
| Pro | Monthly | $109 | ~$36 | **~67%** | ~$100 | **~8%** |
| Pro | Annual | $90.83 ($1,090/yr) | ~$36 | **~60%** | ~$100 | **~-10%** |

Notes on worst-case:
- Unlimited revisions remain the dominant cost-of-service risk. A Growth-plan
  merchant running 10 apps × 10 revisions each = 100 revisions at ~$0.40 each
  is ~$40 just on revisions. If you later start seeing margin compression in
  a specific segment, the lever is revision classification + soft-caps on
  revisions flagged as `new_capability` (those are billing-eligible if the
  product decision changes) — not a new plan tier.
- Pro annual worst case is slightly underwater at the ceiling; acceptable as
  long as the power-user tail is small. Monitor `revision_classifications`
  volume vs revenue on that cohort.
- Free plan is intentionally underwater — treat as CAC, not a profit center.

## Pricing

Pricing is set downstream of the [Cost Analysis](#cost-analysis) above — each
plan's price is calibrated against its moderate-usage cost and the worst-case
margin it will tolerate. When the cost inputs change (LLM pricing, execution
cost, infra), recompute the margins first and adjust the table below second.

Annual plans offer ~17% discount — **pay for 10 months, get 12**. Annual billing
uses the Shopify `ANNUAL` pricing interval, charged once per year via the
merchant's Shopify invoice. Same plan limits apply — usage resets monthly
(aligned with `billing_cycle_anchor`).

| | Free | Starter | Growth | Pro |
|---|---|---|---|---|
| **Monthly price** | $0 | $29/mo | $59/mo | $109/mo |
| **Annual price** | — | $290/yr | $590/yr | $1,090/yr |
| ↳ *Effective monthly* | — | *$24.17/mo* | *$49.17/mo* | *$90.83/mo* |
| ↳ *Annual savings* | — | *$58/yr* | *$118/yr* | *$218/yr* |

Source of truth for these numbers is `platform/packages/types/src/billing.ts`
(`priceMonthly` / `priceYearly` in cents). The platform-front plan picker at
`platform-front/src/pages/SettingsPage.tsx` currently duplicates the values
— update both when adjusting prices, or consolidate onto `billing.ts`.

## Testing

### Local Development

1. **Run migrations:**
   ```bash
   psql $DATABASE_URL < platform/packages/db/migrations/0023_billing.sql
   psql $DATABASE_URL < platform/packages/db/migrations/0024_annual_billing_and_dashboard.sql
   ```

2. **Test plan enforcement:**
   ```bash
   # Create a free-plan tenant
   curl -X POST http://localhost:3002/tenants \
     -H 'Content-Type: application/json' \
     -d '{"slug": "test-shop", "name": "Test Shop", "plan": "free"}'

   # Try creating 2 apps (should fail on 2nd — free plan allows 1)
   curl -X POST http://localhost:3002/tenants/{tenantId}/apps \
     -H 'Content-Type: application/json' \
     -d '{"slug": "app-1", "name": "App 1"}'

   curl -X POST http://localhost:3002/tenants/{tenantId}/apps \
     -H 'Content-Type: application/json' \
     -d '{"slug": "app-2", "name": "App 2"}'
   # → 403 { "error": "Your free plan allows up to 1 apps...", "code": "app_limit_reached" }
   ```

3. **Test usage tracking:**
   ```bash
   # Check current usage
   curl http://localhost:3002/billing/usage/{tenantId}

   # Start a generation (increments counter)
   curl -X POST http://localhost:3002/generation \
     -H 'Content-Type: application/json' \
     -d '{"appId": "...", "tenantId": "...", "prompt": "..."}'

   # Check usage again — generations should be +1
   curl http://localhost:3002/billing/usage/{tenantId}
   ```

4. **Test revision classification:**
   ```bash
   # Classify a revision directly via generator
   curl -X POST http://localhost:8001/classify-revision \
     -H 'Content-Type: application/json' \
     -d '{"feedback": "the widget shows a blank page when I open it"}'
   # → {"classification": "bug_report", "confidence": "high"}

   curl -X POST http://localhost:8001/classify-revision \
     -H 'Content-Type: application/json' \
     -d '{"feedback": "change the button color to red"}'
   # → {"classification": "feature_modification", "confidence": "high"}
   ```

5. **Test Shopify Billing — monthly (requires Shopify dev store):**
   ```bash
   # Subscribe to a monthly plan
   curl -X POST http://localhost:3002/billing/subscribe \
     -H 'Content-Type: application/json' \
     -d '{"tenantId": "...", "plan": "growth"}'
   # → {"confirmationUrl": "https://mystore.myshopify.com/admin/charges/..."}
   ```

6. **Test Shopify Billing — annual:**
   ```bash
   # Subscribe to an annual plan (interval defaults to "monthly" if omitted)
   curl -X POST http://localhost:3002/billing/subscribe \
     -H 'Content-Type: application/json' \
     -d '{"tenantId": "...", "plan": "growth", "interval": "annual"}'
   # → {"confirmationUrl": "https://mystore.myshopify.com/admin/charges/..."}
   # The Shopify approval page will show $590/yr instead of $59/mo
   ```

7. **Test billing dashboard:**
   ```bash
   curl http://localhost:3002/billing/dashboard/{tenantId}
   # Returns: subscription info, current usage + limits, usage history (6 periods),
   #          billing events (50 most recent), revision analytics, app count vs limit
   ```

### Verifying the billing event audit trail

```sql
SELECT event_type, from_plan, to_plan, created_at
FROM billing_events
WHERE tenant_id = '<tenant-id>'
ORDER BY created_at DESC;
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SHOPIFY_BILLING_MODE` | `"disabled"` | Controls how billing is handled — see below |
| `SHOPIFY_CLIENT_SECRET` | — | Used for HMAC verification on billing webhooks |
| `PLATFORM_URL` | `http://localhost:3002` | Billing callback return URL |
| `DASHBOARD_URL` | `http://localhost:3000` | Post-approval redirect |

### `SHOPIFY_BILLING_MODE` values

| Value | When to use | What happens |
|-------|-------------|--------------|
| `disabled` | Local dev, custom apps | Shopify is bypassed. Plan is applied directly in the DB. No confirmation URL is returned. Use when your Shopify app is a **custom app** — custom apps are blocked from the Billing API by Shopify. |
| `test` | Staging / unlisted app with a dev store | Calls Shopify Billing API with `test: true`. No real money is charged. Merchant sees the confirmation page. Requires the app to be **public or unlisted** in the Partner dashboard. |
| `live` | Production | Calls Shopify Billing API with `test: false`. Real charges on merchant's Shopify invoice. |

> **Note:** To enable `test` or `live` mode, your Shopify app must be converted from a **custom app** to a **public or unlisted app** in the [Shopify Partner dashboard](https://partners.shopify.com). See the section below.

## Wiring Status

| Feature | Status | Location |
|---------|--------|----------|
| App creation limit | **Wired** | `POST /tenants/:id/apps` |
| Generation quota | **Wired** | `POST /generation` |
| Category gating | **Wired** | `POST /generation` (when `preComputedIntent.appCategory` present) |
| Subscription webhook | **Wired** | `POST /billing/webhook` (APP_SUBSCRIPTIONS_UPDATE) |
| App execution quota | **Wired** | `webhook-gateway/routes/webhook.ts` — checks before enqueue, returns 200 + quota_exceeded |
| Email send quota | **Wired** | `harness/context-factory.ts` — checks before send, throws on limit |
| SMS send quota | **Wired** | `harness/context-factory.ts` — checks before send, throws on limit |
| Annual billing | **Wired** | `POST /billing/subscribe` — supports `interval: "annual"`, Shopify `ANNUAL` pricing interval |
| Billing dashboard | **Wired** | `GET /billing/dashboard/:tenantId` — usage, events, analytics, subscription info |

## Future Enhancements

- [ ] **Usage charge overages** — Shopify UsageCharge API for Growth/Pro email/SMS overages
- [ ] **Grace period** — 3-day grace on execution limits before hard-blocking
- [ ] **Dunning emails** — notify merchants when limits are approaching (80%, 100%)

## Converting to a Public / Unlisted App (enables real Billing API)

Shopify blocks the Billing API for **custom apps** (apps created directly in a store's admin).
To test or charge merchants you need a **public** or **unlisted** app in the Partner dashboard.

### Steps

1. Go to [partners.shopify.com](https://partners.shopify.com) → **Apps** → create a new app (or use an existing one).
2. Under **App setup**, set the **App URL** to your platform URL (e.g. `https://your-platform.com/oauth/install`).
3. Add the required OAuth redirect URL: `https://your-platform.com/oauth/callback`.
4. In **Distribution**, choose **Unlisted** (lets you share a direct install link without App Store review).
5. Copy the new **Client ID** and **Client Secret** into your `.env`:
   ```
   SHOPIFY_CLIENT_ID=<new-client-id>
   SHOPIFY_CLIENT_SECRET=<new-client-secret>
   ```
6. Set billing mode:
   - For staging with a dev store: `SHOPIFY_BILLING_MODE=test`
   - For production: `SHOPIFY_BILLING_MODE=live`
7. Re-install the app on your dev store via the new install link — the existing custom-app token won't work.

### After converting

- Merchants install via the Partner dashboard install link (or a direct URL you share).
- The Billing API becomes available — `POST /billing/subscribe` will return a real `confirmationUrl`.
- In `test` mode, clicking the Shopify confirmation page charges nothing; Shopify marks the charge as `TEST`.
- The `billing/callback` redirect and `APP_SUBSCRIPTIONS_UPDATE` webhook will fire as expected.
