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

### Monthly Pricing

| Feature | Free | Starter ($19/mo) | Growth ($49/mo) | Pro ($99/mo) |
|---------|------|-------------------|------------------|--------------|
| **Active Apps** | 1 | 3 | 10 | 999 |
| **New Generations/mo** | 1 | 3 | 10 | 999 |
| **Revisions/mo** | Unlimited | Unlimited | Unlimited | Unlimited |
| **App Categories** | A only | A + C | All (A-D) | All (A-D) |
| **App Executions/mo** | 1,000 | 10,000 | 50,000 | 200,000 |
| **Emails/mo** | 100 | 1,000 | 5,000 | 20,000 |
| **SMS/mo** | 0 | 0 | 100 | 500 |
| **Trial** | — | 7 days | 7 days | 14 days |

### Annual Pricing (~17% discount — pay for 10 months, get 12)

| Plan | Monthly | Annual | Effective Monthly | Savings |
|------|---------|--------|-------------------|---------|
| Free | $0 | — | — | — |
| Starter | $19/mo | $190/yr | $15.83/mo | $38/yr |
| Growth | $49/mo | $490/yr | $40.83/mo | $98/yr |
| Pro | $99/mo | $990/yr | $82.50/mo | $198/yr |

Annual billing uses the Shopify `ANNUAL` pricing interval. The subscription is charged once
per year via the merchant's Shopify invoice. Same plan limits apply — usage resets monthly
(aligned with `billing_cycle_anchor`).

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
| A — Storefront + Backend | Widget + handler (no admin UI) | Free, Starter, Growth, Pro |
| B — Storefront + Backend + Admin | Widget + handler + admin panel | Growth, Pro |
| C — Backend Only | Handler only (webhook/cron automation) | Starter, Growth, Pro |
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

### Files

| File | Purpose |
|------|---------|
| `platform/packages/db/migrations/0023_billing.sql` | DB schema: usage_records, revision_classifications, billing_events, tenant billing columns |
| `platform/packages/db/migrations/0024_annual_billing_and_dashboard.sql` | Adds `billing_interval` enum + column to tenants |
| `platform/packages/types/src/billing.ts` | TypeScript types + plan definitions (PLANS, getPlanLimits, BillingInterval) — shared by all services |
| `platform/apps/api/src/lib/plans.ts` | Re-exports plan config from types; adds isPlanAllowedCategory helper |
| `platform/apps/api/src/lib/shopify-billing.ts` | Shopify Billing API client (GraphQL mutations, supports monthly + annual) |
| `platform/apps/api/src/lib/plan-enforcement.ts` | Quota checks: canCreateApp, canStartGeneration, etc. |
| `platform/apps/api/src/lib/usage-tracking.ts` | Atomic usage counter increments |
| `platform/apps/api/src/routes/billing.ts` | Billing API endpoints (including dashboard) |
| `platform/apps/webhook-gateway/src/routes/webhook.ts` | Execution quota enforcement (before enqueue) |
| `platform/packages/harness/src/context-factory.ts` | Email/SMS quota enforcement (before send) |
| `platform/packages/db/src/billing.ts` | Billing DB queries: usage records, checkUsageQuota, billing events, dashboard queries |
| `generator/subagents/revision_classifier.py` | LLM classifier for revision type (analytics) |

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

| Component | Cost per Unit | Notes |
|-----------|--------------|-------|
| LLM generation | ~$0.25 | 9-11 Claude calls (Haiku + Sonnet mix) |
| LLM revision | ~$0.25 | Same pipeline as generation |
| Cloud Run per app | ~$0.02/mo | 256Mi, ~200 executions/month |
| Shared infra | ~$25-35/mo | PostgreSQL + Redis + Pub/Sub |
| Revision classification | ~$0.001 | Single Haiku call (128 tokens) |

### Margin by plan (monthly)

| Plan | Revenue | Est. Cost | Gross Margin |
|------|---------|-----------|--------------|
| Free | $0 | ~$2.50/mo | -100% (loss leader) |
| Starter ($19) | $19 | ~$8/mo | ~57% |
| Growth ($49) | $49 | ~$15/mo | ~70% |
| Pro ($99) | $99 | ~$18/mo | ~82% |

### Margin by plan (annual)

Annual plans are ~17% cheaper for merchants but cost the same to operate,
so margins are slightly lower but revenue is pre-committed for 12 months.

| Plan | Revenue (yearly) | Est. Cost (yearly) | Gross Margin |
|------|-----------------|-------------------|--------------|
| Starter ($190/yr) | $190 | ~$96/yr | ~49% |
| Growth ($490/yr) | $490 | ~$180/yr | ~63% |
| Pro ($990/yr) | $990 | ~$216/yr | ~78% |

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
   # The Shopify approval page will show $490/yr instead of $49/mo
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
| `SHOPIFY_BILLING_TEST_MODE` | `"true"` | Set to `"false"` for production Shopify charges |
| `SHOPIFY_CLIENT_SECRET` | — | Used for HMAC verification on billing webhooks |
| `PLATFORM_URL` | `http://localhost:3002` | Billing callback return URL |
| `DASHBOARD_URL` | `http://localhost:3000` | Post-approval redirect |

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
