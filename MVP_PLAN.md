# MVP Plan — Small Shopify App Generator

## What the Platform Generates

Each app consists of up to three artifacts:

- **Widget ES module** — client-side, sandboxed under the host API, runs in the storefront
- **TypeScript handler** — server-side logic, has access to `ctx`
- **Admin React/Polaris UI** — rendered inside the Shopify Admin iframe (only for apps that need a merchant dashboard)

---

## Services Supported in MVP

| Service | Status | Notes |
|---------|--------|-------|
| `ctx.shopify` (Admin API) | Real | Already working |
| `ctx.db` (Postgres, tenant-isolated) | Real | Already working |
| `ctx.http` | Real | Thin fetch wrapper with logging |
| `ctx.storefront` (Storefront GraphQL) | Real | Storefront Access Token created at OAuth, stored per tenant |
| `ctx.shop` (`{ domain }`) | Real | From env var |
| `ctx.services.email` | Stub → real Phase 3 | Logs `EMAIL_SENT` in dev |
| `ctx.services.sms` | Stub → real Phase 3 | Logs `SMS_SENT` in dev |
| `ctx.services.pdf` | Stub → real Phase 3 | Real impl uses PDFKit (in-process, no external API) |
| `ctx.services.csv` | Real | Pure in-process, zero external dependency |
| `ctx.services.files` | Stub → real Phase 3 | Real impl uses GCS |

**Not in MVP:** `ctx.queue`, `ctx.cache`, `ctx.billing`, `ctx.services.ai`

---

## App Categories & Types

We support three primary categories of applications. For a detailed breakdown of all 21 specific app types, including their required services, Shopify API usage, and architectural flows, please see the **[Supported Apps Catalog](./SUPPORTED_APPS_CATALOG.md)**.

### Category A — Storefront + Backend
Widget on the storefront. Backend stores config or processes webhook events into DB. No admin UI.
*(Examples: Announcement Bar, Trust Badges, Free Shipping Progress Bar)*

### Category B — Storefront + Backend + Admin UI
Widget on the storefront for customer interaction, plus a merchant-facing dashboard embedded in the Shopify Admin.
*(Examples: Price Drop Alert, Back In Stock Notify Me)*

### Category C — Backend Only
No storefront widget. Apps are either fully automatic (webhook or cron triggered) or admin-triggered via a Polaris UI.
*(Examples: Order Thank You Email, Bulk Order Tagger, Image Size Optimizer)*

---

## Monetization

### Pricing Tiers (via Shopify Billing API)

| Plan | Price | App limit | Unlocked categories |
|------|-------|-----------|---------------------|
| **Free** | $0/mo | 1 app | Category A only |
| **Starter** | $15/mo | 3 apps | Category A + C (backend-only) |
| **Growth** | $35/mo | 10 apps | All categories (A + B + C) |

**Why this ordering:** Category C (backend-only) apps like automated emails are simpler to understand and sell than Category B (which requires both a storefront widget AND an admin UI). Merchants on Starter can automate their order emails without needing to deal with storefront widget setup.

### Natural upgrade triggers

- **Free → Starter:** Merchant wants to automate emails or build a backend-only app
- **Starter → Growth:** Merchant wants a customer-facing widget with a subscribe form, or needs more than 3 apps

### Service gating

Email, SMS, PDF, and Files are stubs during development but plan-gated from day one. When real integrations arrive in Phase 3, the gates are already in place.

### Phase 3 Usage Billing

Once real email and SMS are live, add `UsageCharge` on top of subscriptions:
- Email: $0.001/send (first 1,000/mo included per plan)
- SMS: $0.05/send (first 100/mo included on Growth)

PDF and CSV are always free — generated in-process with zero marginal cost.

---

## Execution Phases

### Phase 0 — Foundation (~1.5 weeks)
Harness updated with all new services (stubs where noted). Admin handler (App Bridge JWT validation) implemented. Generator prompts updated with all 3 categories and all ~21 app types. Each app type manually generated and tested end-to-end.

### Phase 1 — Billing (~1 week)
Shopify `RecurringApplicationCharge` integrated. Plan stored per tenant. Services and app creation gated by plan. Upgrade prompts in platform dashboard.

### Phase 2 — App Store Launch (~2 weeks)
App Store listing and demo video. Submitted for Shopify review.

### Phase 3 — Real Integrations (~2 weeks, after first 10 paying merchants)
Email (Resend), SMS (Twilio), PDF (PDFKit), Files (GCS) replace their stubs. Usage billing added for email and SMS.

### Phase 4 — Expand (ongoing)
`ctx.queue` for fan-out, `ctx.services.ai`, wider app catalog.

---

## The Core Bet

A merchant paying $19/mo for "Notify Me," $29/mo for "Sales Pop," and $15/mo for "Announcement Bar" — three separate apps totalling $63/mo — will immediately see the value in paying $35/mo for a platform that generates all three (and 18 more) from a prompt.
