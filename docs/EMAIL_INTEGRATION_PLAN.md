# Platform Email Integration — Implementation Plan

**Branch:** `claude/platform-email-integration`

This document captures the design, decisions, and implementation of the
platform-owned email service. Generated Ton apps can send polished,
brand-consistent emails to end customers; merchants configure content in a
dedicated tab in the Ton dashboard; the platform owns delivery, rendering,
branding, analytics, and unsubscribe.

---

## 1. Goals

- Replace the stubbed `ctx.email.send()` with a real Resend-backed
  implementation
- Make every email-using app look professional out of the box without asking
  merchants to write HTML
- Preserve a clean separation: handlers do business logic, the platform does
  everything about emails except the recipient and runtime variables
- Ship a minimal but usable merchant experience: one Email tab per app, one
  Brand panel per tenant
- Prevent broken email UX by blocking deploy of email-using apps until the
  merchant confirms their template

## 2. Non-goals (out of scope for MVP)

- Open / click / conversion tracking (only sent/delivered/bounced)
- Per-merchant custom sending domains (Ton subdomain only for MVP)
- Raw HTML escape hatch for advanced merchants
- Multi-template per app (one email per app; multi-step sequences = multiple apps)
- Real marketing-vs-transactional enforcement differences (informational only)
- Platform-level consent tracking (handler business logic handles it)
- Abuse detection beyond existing plan quotas
- Visual drag-and-drop template editor
- Localization / multi-language templates

---

## 3. Decisions

| ID | Topic | Decision |
|---|---|---|
| D1 | Delivery provider | **Resend** |
| D2 | "From" domain | **Ton platform subdomain** (`notifications@mail.ton-platform.com` / `marketing@mail.ton-platform.com`) |
| D3 | Brand storage | **Tenant-level** — one `tenant_brands` row per merchant, shared across all apps |
| D4 | Multi-email per app | **One email per app**; multi-step flows become multiple Ton apps |
| D5 | Send-test button | **Yes** — sends rendered preview with sample data to the merchant's email |
| D6 | Raw HTML escape hatch | **No** — form fields only |
| D7 | Analytics depth | **Sent / delivered / bounced / complained / failed** (no opens/clicks) |
| D8 | Email tab location | **`platform-front` dashboard only** (not the Shopify Admin embedded shell) |
| D9 | Config changes | **Apply immediately** — no redeploy required |
| D10 | Email tab fields | Subject, heading, body, CTA label, CTA URL, email type |
| D11 | Missing email config | **Block deploy** until merchant saves the Email tab once; deploy endpoint returns `409 email_not_confirmed` |
| D12 | Unsubscribe | **Platform auto-appends** footer; clicks go to a Ton-hosted page; per-tenant suppression |
| D13 | Marketing vs transactional | **Informational for MVP**; architect pre-selects; merchant can override |
| D14 | Backward compatibility | **None** — clean break on `ctx.email.send({to, data})`; no `subject`/`templateId` |
| D15 | Auto-populate from Shopify theme | **Deferred** — merchant fills brand manually in Settings for MVP |

---

## 4. Architecture

### Pipeline — one path for every email

```
[Generated handler]
   ctx.email.send({ to, data })
       │
       ▼
[platform/packages/harness/src/email-service.ts]
   1. Suppression check (silent skip if recipient is blocked)
   2. Plan quota check
   3. Load app_email_configs for this.appId
   4. Load tenant_brands for this.tenantId (falls back to defaults)
   5. Sign unsubscribe token (HMAC)
   6. Render blocks → MJML → HTML via email-renderer.ts
   7. Insert email_deliveries row (status=queued)
   8. Submit to Resend
   9. Update row → sent / failed
  10. Increment emails_sent usage counter
       │
       ▼
[Resend MTA]
   DKIM / SPF / DMARC on mail.ton-platform.com
       │
       ▼
[Customer inbox]
       │
       ▼
[Resend webhook → webhook-gateway /webhook/resend]
   email.delivered → email_deliveries.status = delivered
   email.bounced   → status = bounced, INSERT email_suppressions
   email.complained → status = complained, INSERT email_suppressions
   email.failed    → status = failed
```

### Responsibility split

| Concern | Owner |
|---|---|
| Recipient (`to`) | Handler — only it knows this at runtime |
| Variables (`data`) | Handler — only it knows the runtime values |
| Subject / heading / body / CTA template | Merchant (via Email tab) |
| Logo / primary color / footer | Merchant (via Brand panel) |
| Base layout + MJML rendering | Platform |
| "From" address + DKIM/SPF/DMARC | Platform |
| Unsubscribe link + suppression | Platform |
| Delivery tracking | Platform (via Resend webhooks) |
| Quota enforcement | Platform (existing code) |

---

## 5. Handler API

### Minimal shape

```ts
interface EmailSendParams {
  to: string;
  data?: Record<string, unknown>;
}

interface EmailClient {
  send(params: EmailSendParams): Promise<void>;
}
```

No `subject`, no `templateId`, no HTML. Clean break — nothing in production
yet, so we don't support the old shape.

### Example handler

```js
await ctx.email.send({
  to: cart.customerEmail,
  data: {
    customerName: cart.customerName,
    cartTotal: cart.total,
    currency: cart.currency,
    recoveryUrl: cart.recoveryUrl,
  },
});
```

The variable names in `data` become the merchant's token palette in the
Email tab.

---

## 6. Database schema (migration `0025_email_integration.sql`)

### Enums

- `email_type` — `transactional` | `marketing`
- `email_delivery_status` — `queued` | `sent` | `delivered` | `bounced` | `complained` | `failed`
- `email_suppression_reason` — `unsubscribed` | `bounced` | `complained` | `manual`

### Tables

**`tenant_brands`** — 1:1 with tenants. All fields nullable (defaults apply).

**`app_email_configs`** — 1:1 with email-using apps. Auto-seeded on bundle
storage, merchant edits in the dashboard. `configured_by_merchant` gates deploy.

**`email_deliveries`** — one row per send attempt. Status updated via Resend
webhooks. `is_test` filters Send Test previews out of analytics.

**`email_suppressions`** — `(tenant_id, email)` composite PK. Fast existence
check before every send. Populated by unsubscribes, bounces, complaints.

### `apps` additions

- `uses_email BOOLEAN` — drives Email tab visibility and deploy blocking
- `email_variables JSONB` — variable manifest from the bundle metadata

---

## 7. Implementation layout

### Backend (TypeScript)

| File | Role |
|---|---|
| `platform-back/packages/db/migrations/0001_initial_schema.sql` | Schema + RLS policies (email tables are part of the initial schema, not a separate migration) |
| `platform-back/packages/db/src/email.ts` | Typed DB helpers for all 4 tables |
| `platform-back/packages/email/src/renderer.ts` | MJML template + variable substitution + unsubscribe tokens |
| `platform-back/packages/email/src/sender.ts` | Resend adapter (`SendEmailInput` → Resend SDK) |
| `platform-back/apps/api/src/pubsub/schemas.ts` | `BundleSchema` — `usesEmail/emailVariables/emailStarterContent/emailTypeSuggestion` |
| `platform-back/apps/api/src/routes/email.ts` | Config CRUD, test send, stats, brand CRUD, public unsubscribe page |
| `platform-back/apps/api/src/routes/generation.ts` | Deploy block check (**`applyBundleEmailMetadata` not yet wired — see §14**) |
| `platform-back/apps/api/src/plugins/auth.ts` | Exempts `/email/u/` from auth |
| `platform-back/apps/webhook-gateway/src/routes/resend-webhook.ts` | Ingests Resend delivery events (**not yet implemented — see §14**) |

### Generator (Python)

| File | Role |
|---|---|
| `platform-ai/contract/validators.py` | `EmailStarterContent` + new `Bundle` fields |
| `platform-ai/crews/feature_generator/crew.py` | Email metadata detection + variable extraction + starter content (inline, no separate subagent file) |
| `platform-ai/templates/harness_contract.py` | Documents new `ctx.email.send({to, data})` API |

### Frontend (React)

| File | Role |
|---|---|
| `platform-front/src/types/dashboard.ts` | `AppEmailConfig`, `TenantBrand`, `EmailStatsSummary`, etc.; `App.usesEmail` |
| `platform-front/src/lib/api.ts` | `api.email.*` client methods |
| `platform-front/src/hooks/useEmail.ts` | React Query hooks |
| `platform-front/src/components/features/email/EmailTab.tsx` | Per-app email config UI |
| `platform-front/src/components/features/email/BrandPanel.tsx` | Tenant brand form |
| `platform-front/src/pages/AppDetailPage.tsx` | Conditional Email tab + deploy-block handler |
| `platform-front/src/pages/SettingsPage.tsx` | Embeds `BrandPanel` |

---

## 8. End-to-end flow (a merchant's first email-using app)

1. Merchant describes the app in chat (e.g. "send abandoned cart emails")
2. Generator produces the handler → `handler_code` contains `ctx.email.send(...)`
3. `email_metadata.py` regex-detects the call, extracts variables, builds
   starter content, classifies as `transactional`
4. Bundle is published with `usesEmail=true`, `emailVariables`,
   `emailStarterContent`, `emailTypeSuggestion`
5. **[NOT YET IMPLEMENTED — see §14]** Platform `generation.ts` completed
   listener calls `applyBundleEmailMetadata`:
   - Sets `apps.uses_email = TRUE`
   - Sets `apps.email_variables = [...]`
   - Upserts `app_email_configs` with starter content, `configured_by_merchant = FALSE`
6. App appears in dashboard with an Email tab (driven by `app.usesEmail`)
7. Merchant clicks Deploy → API returns `409 email_not_confirmed`
8. Frontend intercepts the error and jumps to the Email tab
9. Merchant sees pre-filled form (subject, body, CTA) with their variable
   palette at the top
10. Merchant edits content, clicks Save → `configured_by_merchant = TRUE`
11. Merchant clicks "Send test to me" → sample-value render → Resend → inbox
12. Merchant clicks Deploy again → passes the check → app goes live
13. Handler executes → `ctx.email.send({to, data})` → platform renders with
    merchant's brand → Resend → customer inbox
14. **[NOT YET IMPLEMENTED — see §14]** Resend webhooks update
    `email_deliveries` → merchant sees delivery stats in the Email tab
15. If customer clicks Unsubscribe → Ton-hosted page → `email_suppressions`
    insert → all future sends to that address from this merchant are silent-skipped

---

## 9. Operational setup (not automated)

These are one-time manual steps needed before production use:

- Create Resend account
- Verify sending domain
- Add DKIM / SPF / DMARC records on `mail.ton-platform.com`
- Create Resend API key → store in Secret Manager as `RESEND_API_KEY`
- Configure webhook endpoint → `https://platform.ton-platform.com/webhook/resend`
- Store webhook signing secret → `RESEND_WEBHOOK_SECRET`
- Set `EMAIL_UNSUBSCRIBE_SECRET` (HMAC key for signed unsubscribe tokens)
- Set `RESEND_FROM_TRANSACTIONAL` and `RESEND_FROM_MARKETING`
- Warm up the sending domain (low volume in weeks 1–3, scale up in week 4+)
- Build bounce/complaint rate monitoring before opening to real merchants

---

## 10. Accepted limitations

These are conscious gaps for MVP. Not tracked in `TECH_DEBT.md` — they live
here because they only make sense in the context of this plan.

1. **No opens/clicks/conversions** — only sent/delivered/bounced. Opens
   require pixel tracking; clicks require URL rewriting. Both can be added
   later without schema changes.
2. **No custom merchant domains** — everyone sends from
   `mail.ton-platform.com`. Shared reputation risk mitigated by plan quotas
   + bounce/complaint monitoring.
3. **No raw HTML mode** — merchants can't paste HTML. Form fields only.
4. **One email per app** — abandoned-cart 1h/24h/48h sequences become three
   Ton apps.
5. **Marketing vs transactional is informational** — no consent enforcement,
   no routing differences. Reserved as a field for future work.
6. **Regex-based email detection** — `email_metadata.py` uses regex, not AST
   parsing. Works for standard handler code patterns; edge cases may miss.
7. **Starter content is template-based, not LLM-generated** — keeps the
   critical-path fast and deterministic. The merchant still needs to
   personalize before deploy (which is enforced).
8. **`email_deliveries` has no retention policy** — grows unbounded. Add a
   purge job once volume warrants it.
9. **Test sends share the deliveries table** — filtered via `is_test = TRUE`
   flag, excluded from merchant analytics.
10. **Brand fallback is platform defaults** — empty brand row = generic blue
    button, no logo (store name as text), no footer.
11. **Domain warm-up is manual** — no automated rate limiting during the
    first weeks. Operators must monitor and throttle manually if needed.

---

## 11. Future upgrades

In rough priority order after MVP ships:

1. Open + click tracking (biggest merchant value unlock)
2. Per-merchant custom sending domains (Pro tier feature)
3. Multi-email per app / named templates
4. Real consent tracking + preference center
5. Visual block editor (hero, product grid, etc.)
6. A/B testing subject lines
7. Scheduled sends + timezone handling
8. Merchant-branded unsubscribe page
9. Attachment support (invoices, packing slips)
10. Per-app suppression scope (opt out of specific apps instead of all)
11. Auto-populate brand from Shopify theme on install
12. Automated warm-up throttling
13. Retention policy / purge job for `email_deliveries`

---

## 12. File manifest (this implementation)

New files:
- `platform-back/packages/db/src/email.ts`
- `platform-back/packages/email/src/renderer.ts`
- `platform-back/packages/email/src/sender.ts`
- `platform-back/apps/api/src/routes/email.ts`
- `platform-back/apps/webhook-gateway/src/routes/resend-webhook.ts` (**not yet created — see §14**)
- `platform-front/src/hooks/useEmail.ts`
- `platform-front/src/components/features/email/EmailTab.tsx`
- `platform-front/src/components/features/email/BrandPanel.tsx`
- `docs/EMAIL_INTEGRATION_PLAN.md` (this file)

Modified files:
- `platform-back/packages/db/migrations/0001_initial_schema.sql` (email tables added to initial schema)
- `platform-back/apps/api/src/pubsub/schemas.ts` (email bundle fields)
- `platform-back/apps/api/src/server.ts`
- `platform-back/apps/api/src/plugins/auth.ts`
- `platform-back/apps/api/src/routes/generation.ts` (`applyBundleEmailMetadata` **not yet wired — see §14**)
- `platform-back/apps/webhook-gateway/src/server.ts`
- `platform-ai/contract/validators.py`
- `platform-ai/crews/feature_generator/crew.py` (email metadata inline; no separate subagent file)
- `platform-ai/templates/harness_contract.py`
- `platform-front/src/types/dashboard.ts`
- `platform-front/src/lib/api.ts`
- `platform-front/src/pages/AppDetailPage.tsx`
- `platform-front/src/pages/SettingsPage.tsx`

---

## 14. Implementation gaps

Two pieces described in this plan are not yet implemented. Everything else
is shipped.

### Gap 1 — `applyBundleEmailMetadata` bridge (blocking for Email tab UX)

**What's missing:** after the generator publishes a bundle with
`usesEmail=true`, nothing reads those fields and writes them to the
database. The DB helpers already exist
(`platform-back/packages/db/src/email.ts` — `setAppUsesEmail`,
`createAppEmailConfigFromStarter`), but no code in the generation subscriber
or generation route calls them.

**Impact:** `apps.uses_email` stays `FALSE`, no `app_email_configs` row is
created, the Email tab never appears in the dashboard, and the deploy-block
check never triggers.

**Fix needed:** in `platform-back/apps/api/src/routes/generation.ts` (or its
pub/sub subscriber), after bundle storage, call `setAppUsesEmail` and
`createAppEmailConfigFromStarter` when `bundle.usesEmail === true`.

### Gap 2 — Resend webhook route

**What's missing:** `platform-back/apps/webhook-gateway/src/routes/resend-webhook.ts`
does not exist. The webhook-gateway only handles Shopify webhooks today.

**Impact:** Resend delivery events (`email.delivered`, `email.bounced`,
`email.complained`, `email.failed`) are never ingested. `email_deliveries`
rows stay at `sent` status forever; bounces and complaints never create
`email_suppressions` entries.

**Fix needed:** create the route, verify Svix signature with
`RESEND_WEBHOOK_SECRET`, and update `email_deliveries` + insert
`email_suppressions` on bounce/complaint.

---

## 13. Environment variables

New env vars the implementation expects:

| Variable | Where | Purpose |
|---|---|---|
| `RESEND_API_KEY` | api, harness | Resend SDK auth |
| `RESEND_FROM_TRANSACTIONAL` | harness, api | "From" address for transactional emails |
| `RESEND_FROM_MARKETING` | harness | "From" address for marketing emails |
| `RESEND_WEBHOOK_SECRET` | webhook-gateway | Svix webhook signature verification |
| `EMAIL_UNSUBSCRIBE_SECRET` | harness, api | HMAC secret for signed unsubscribe tokens |
| `UNSUBSCRIBE_BASE_URL` | harness | Base URL for unsubscribe links |
