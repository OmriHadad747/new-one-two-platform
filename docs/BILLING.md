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
┌──────────────────────────────────────────────────────────────────┐
│                        BILLING FLOW                               │
│                                                                  │
│  Merchant clicks "Upgrade" in dashboard                          │
│       │                                                          │
│       ▼                                                          │
│  POST /billing/subscribe { tenantId, plan: "growth" }            │
│       │                                                          │
│       ▼                                                          │
│  shopify-billing.ts → appSubscriptionCreate GraphQL mutation     │
│       │                                                          │
│       ▼                                                          │
│  Shopify returns confirmationUrl                                 │
│  → Merchant redirected to Shopify approval page                  │
│       │                                                          │
│       ▼  (merchant clicks "Approve")                             │
│                                                                  │
│  Shopify redirects to GET /billing/callback?tenant_id=X&plan=Y   │
│       │                                                          │
│       ▼                                                          │
│  updateTenantBilling(billingPlan: "growth", status: "active")    │
│  logBillingEvent(subscription_activated)                         │
│  → Redirect to dashboard with ?billing=success                   │
└──────────────────────────────────────────────────────────────────┘
```

## Key Components

### Files

| File | Purpose |
|------|---------|
| `platform/packages/db/migrations/0023_billing.sql` | DB schema: usage_records, revision_classifications, billing_events, tenant billing columns |
| `platform/packages/types/src/billing.ts` | TypeScript types + plan definitions (PLANS, getPlanLimits) — shared by all services |
| `platform/apps/api/src/lib/plans.ts` | Re-exports plan config from types; adds isPlanAllowedCategory helper |
| `platform/apps/api/src/lib/shopify-billing.ts` | Shopify Billing API client (GraphQL mutations) |
| `platform/apps/api/src/lib/plan-enforcement.ts` | Quota checks: canCreateApp, canStartGeneration, etc. |
| `platform/apps/api/src/lib/usage-tracking.ts` | Atomic usage counter increments |
| `platform/apps/api/src/routes/billing.ts` | Billing API endpoints |
| `platform/apps/webhook-gateway/src/routes/webhook.ts` | Execution quota enforcement (before enqueue) |
| `platform/packages/harness/src/context-factory.ts` | Email/SMS quota enforcement (before send) |
| `platform/packages/db/src/index.ts` | Billing DB queries: usage records, checkUsageQuota, billing events |
| `generator/subagents/revision_classifier.py` | LLM classifier for revision type (analytics) |

### Database Tables

```sql
-- Extended tenants table columns:
billing_plan              -- enum: free, starter, growth, pro
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
| GET | `/billing/plans?tenantId=X` | List all plans + current plan |
| GET | `/billing/usage/:tenantId` | Current usage vs plan limits |
| POST | `/billing/subscribe` | Create Shopify subscription → returns confirmation URL |
| GET | `/billing/callback` | Shopify redirects here after approval |
| POST | `/billing/cancel/:tenantId` | Cancel subscription → downgrade to free |
| POST | `/billing/webhook` | Shopify APP_SUBSCRIPTIONS_UPDATE handler (HMAC-verified) |
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

## Subscription Lifecycle

```
Install (OAuth)
  └─ Tenant created with billing_plan="free", subscription_status="none"
     │
     ▼
Merchant clicks "Upgrade to Growth"
  └─ POST /billing/subscribe → Shopify confirmationUrl
     └─ subscription_status = "pending"
        │
        ▼
Merchant approves on Shopify
  └─ GET /billing/callback → plan activated
     └─ billing_plan = "growth", subscription_status = "active"
        │
        ▼
Monthly billing handled by Shopify → state changes via webhook:
  └─ POST /billing/webhook (APP_SUBSCRIPTIONS_UPDATE)
     ├─ Payment OK     → subscription_status stays "active"
     ├─ Payment failed → subscription_status = "frozen", billing_plan = "free"
     ├─ Trial expired  → Shopify sends EXPIRED status → billing_plan = "free"
     └─ Uninstalled    → subscription_status = "cancelled", billing_plan = "free"
        │
        ▼
Merchant cancels manually
  └─ POST /billing/cancel/:tenantId
     └─ Cancels Shopify subscription + billing_plan = "free"
```

## Cost Analysis

| Component | Cost per Unit | Notes |
|-----------|--------------|-------|
| LLM generation | ~$0.25 | 9-11 Claude calls (Haiku + Sonnet mix) |
| LLM revision | ~$0.25 | Same pipeline as generation |
| Cloud Run per app | ~$0.02/mo | 256Mi, ~200 executions/month |
| Shared infra | ~$25-35/mo | PostgreSQL + Redis + Pub/Sub |
| Revision classification | ~$0.001 | Single Haiku call (128 tokens) |

### Margin by plan

| Plan | Revenue | Est. Cost | Gross Margin |
|------|---------|-----------|--------------|
| Free | $0 | ~$2.50/mo | -100% (loss leader) |
| Starter ($19) | $19 | ~$8/mo | ~57% |
| Growth ($49) | $49 | ~$15/mo | ~70% |
| Pro ($99) | $99 | ~$18/mo | ~82% |

## Testing

### Local Development

1. **Run migration:**
   ```bash
   psql $DATABASE_URL < platform/packages/db/migrations/0023_billing.sql
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

5. **Test Shopify Billing (requires Shopify dev store):**
   ```bash
   # Subscribe to a plan
   curl -X POST http://localhost:3002/billing/subscribe \
     -H 'Content-Type: application/json' \
     -d '{"tenantId": "...", "plan": "growth"}'
   # → {"confirmationUrl": "https://mystore.myshopify.com/admin/charges/..."}
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

| Enforcement | Status | Location |
|-------------|--------|----------|
| App creation limit | **Wired** | `POST /tenants/:id/apps` |
| Generation quota | **Wired** | `POST /generation` |
| Category gating | **Wired** | `POST /generation` (when `preComputedIntent.appCategory` present) |
| Subscription webhook | **Wired** | `POST /billing/webhook` (APP_SUBSCRIPTIONS_UPDATE) |
| App execution quota | **Wired** | `webhook-gateway/routes/webhook.ts` — checks before enqueue, returns 200 + quota_exceeded |
| Email send quota | **Wired** | `harness/context-factory.ts` — checks before send, throws on limit |
| SMS send quota | **Wired** | `harness/context-factory.ts` — checks before send, throws on limit |

## Future Enhancements

- [ ] **Usage charge overages** — Shopify UsageCharge API for Growth/Pro email/SMS overages
- [ ] **Annual billing** — discounted yearly plans
- [ ] **Grace period** — 3-day grace on execution limits before hard-blocking
- [ ] **Billing dashboard** — in-app usage charts and invoice history
- [ ] **Dunning emails** — notify merchants when limits are approaching (80%, 100%)
