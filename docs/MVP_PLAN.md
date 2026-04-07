# MVP Plan — Small Shopify App Generator

## What the Platform Generates

Each app consists of up to three artifacts:

- **Widget ES module** — client-side, sandboxed under the host API, runs in the storefront
- **TypeScript handler** — server-side logic, has access to `ctx`
- **Admin UI ES module** — rendered inside the Shopify Admin embedded shell (only for Category B and D apps)

---

## Storefront Widget Runtime — How Multiple Apps Work Under One Shopify App

The platform uses a **single Shopify app** (umbrella app) for all merchants. Multiple platform apps per merchant are supported through the App Block's `app_id` setting — not through multiple Shopify apps.

### How it works

1. **One theme extension** (`widget-runtime`) is deployed once and never changes.
2. The App Block's Liquid template reads a shop-level metafield (`platform_app.base_url`) written during OAuth install — this points the block at the platform API without hardcoding any URL.
3. The merchant places the App Block in their theme via the Theme Editor and sets `app_id` to the platform app's UUID.
4. At page load, `widget-runtime.js` reads `data-app-id`, fetches `GET /widgets/:shop/:appId.js` from the platform, dynamically imports the ES module, and calls `widget.mount(container, host)`.
5. **Multiple apps on one page**: the merchant can place as many App Block instances as they want in their theme, each with a different `app_id`. Each instance mounts independently in its own container. `widget-runtime.js` runs `mountBlock()` in parallel for all instances found on the page.
6. The `host` object passed to each widget is scoped to that widget's `appId` — `host.call()` routes to that app's harness container, `host.context.shop` comes from the block's data attribute.

### Key design properties

- The block itself is a fixed, dumb loader — generating new apps requires zero theme changes.
- `host.call()` and `host.storefront()` are the widget's only interfaces to the outside world. No direct fetch, no hardcoded URLs.
- URL changes (Shopify's client-side variant picker uses `history.pushState`) are detected via a patched `pushState`/`replaceState` that fires a synthetic `urlchange` event, causing each widget to re-evaluate its page context.

---

## Admin UI — Embedded Shell Architecture

### Two entry points, one platform

The platform maintains two separate frontend applications:

| App | URL | Purpose |
|-----|-----|---------|
| `platform-front` | `app.yourdomain.com` | Merchant-facing dashboard — generate apps, manage deployments, view logs |
| `platform-shopify-admin` | `admin.yourdomain.com` | Shopify Admin embedded shell — renders each platform app's Admin UI module |

These coexist independently. OAuth installs still redirect to `platform-front`. Merchants access `platform-shopify-admin` by clicking your app in their Shopify Admin sidebar.

### How the embedded shell works

`platform-shopify-admin` is a React app configured as a Shopify embedded app (`embedded = true` in `shopify.app.toml`). Shopify loads it inside their Admin iframe, giving it full App Bridge access — session tokens, their nav chrome, toasts.

**On load:**
1. App Bridge initialises and provides a signed `sessionToken` (JWT) identifying the merchant.
2. The shell calls `GET /tenants/:shop/apps` on the platform API to fetch the list of the merchant's platform apps that have an `adminUiModule`.
3. A sidebar renders one entry per app (e.g. "Back In Stock Notifier", "Order Exporter").
4. When the merchant selects an app, the shell fetches `GET /admin-ui/:shop/:appId.js`, dynamically imports the ES module, and calls `mount(container, bridge)`.

**The `bridge` object the shell provides:**
```typescript
{
  context: { shop, tenantId },
  call: async (path, body) => {
    // Gets a fresh App Bridge session token on every call
    const token = await getSessionToken(app);
    return fetch(`/admin-ui/${shop}/${appId}/admin${path}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(r => r.json());
  },
  notify: (message, variant) => {
    // Delegates to App Bridge Toast API
    Toast.show(app, { message, isError: variant === "error" });
  },
}
```

The `adminUiModule` has no awareness of App Bridge — it writes against `bridge.call()` and `bridge.notify()` exactly as specified. The shell is the only thing that changes.

### Security: session token verification

All `POST /admin-ui/:shop/:appId/admin/*` requests from the embedded shell carry `Authorization: Bearer <session_token>`. The platform API verifies the JWT signature using Shopify's public keys before forwarding to the harness. This replaces the current unauthenticated proxy and makes admin routes production-safe.

### Multiple apps per merchant, nested pages

- **Multiple apps**: the sidebar lists all the merchant's apps with an `adminUiModule`. Switching apps unmounts the current module and mounts the next one in the same container.
- **Nested pages within a module**: each module owns its container's DOM entirely. Nested pages are client-side show/hide state inside the module — no routing needed at the shell level.
- **App Bridge TitleBar**: the shell sets the Shopify Admin breadcrumb to the active platform app's name. Modules cannot access App Bridge directly.

---

## Services Architecture

Handler capabilities fall into two distinct categories.

### Category 1 — Platform Services (`ctx.*`)

Provided by the harness. Always available — no npm package needed. Require platform credentials or routing that the handler must not own.

| Service | Interface | MVP Status | Notes |
|---------|-----------|------------|-------|
| `ctx.shopify` | `.get()` `.post()` `.graphql()` | Real | Shopify Admin API, token from Secret Manager |
| `ctx.db` | postgres.js tagged template | Real | Postgres, RLS-scoped to tenant |
| `ctx.storefront` | `.graphql()` | Real | Storefront Access Token created at OAuth |
| `ctx.http` | `.call(url, opts)` | Real | Thin fetch wrapper with per-call logging |
| `ctx.shop` | `{ domain }` | Real | From env var |
| `ctx.services.email` | `.send({ to, subject, data? })` | Stub → Phase 3 | Logs EMAIL_SENT; real impl: Resend |
| `ctx.services.sms` | `.send({ to, body })` | Stub → Phase 3 | Logs SMS_SENT; real impl: Twilio |
| `ctx.services.files` | `.upload(name, content, mime?)` | Stub → Phase 3 | Logs FILE_UPLOADED; real impl: GCS |

**Not in MVP:** `ctx.queue`, `ctx.cache`, `ctx.billing`

### Category 2 — JS Libraries (`require()`)

Pure npm packages installed per-app at Docker build time. The handler declares them in `npmPackages`; the deployer runs `RUN npm install` for that app's container only. The harness base image never changes.

```js
// module.exports in handler.js
npmPackages: ['pdfkit@0.15.0', 'dayjs@1.11.13'],
handler: async function(ctx) {
  const PDFDocument = require('pdfkit');
  const dayjs = require('dayjs');
  // ...
}
```

**Currently supported JS libraries:**

| Package | Version | Use case |
|---------|---------|----------|
| `qrcode` | 1.5.3 | QR code PNG buffer or SVG string |
| `jsbarcode` | 3.11.6 | Barcode SVG (CODE128, EAN13, UPC…) |
| `@xmldom/xmldom` | 0.8.10 | DOM implementation required by jsbarcode |
| `sharp` | 0.33.5 | Image resize, crop, format convert |
| `pdfkit` | 0.15.0 | PDF generation |
| `exceljs` | 4.4.0 | Excel / XLSX export |
| `csv-parse` | 5.5.6 | CSV string → array of objects |
| `csv-stringify` | 6.5.2 | Array of objects → CSV string |
| `fast-xml-parser` | 4.3.6 | XML ↔ JS object |
| `handlebars` | 4.7.8 | HTML / text templating |
| `marked` | 15.0.0 | Markdown → HTML |
| `dayjs` | 1.11.13 | Date parsing, formatting, arithmetic |
| `jszip` | 3.10.1 | In-memory ZIP archive |
| `uuid` | 9.0.1 | RFC 4122 UUID v4 generation |
| `slugify` | 1.6.6 | URL-safe slug generation |

**Adding a new JS library:** add it to `ALLOWED_NPM_PACKAGES` in `validation.py` and the library table in `harness_contract.py`. Zero harness changes.

### Why this separation matters

| | Platform Services | JS Libraries |
|---|---|---|
| **Credentials** | Owned by the platform | None needed |
| **Per-app isolation** | No — shared platform infrastructure | Yes — each app installs only what it needs |
| **Harness base image** | Never changes | Never changes |
| **Adding new capability** | New microservice deployment | Two-line change in generator config |
| **MVP status** | Real (Shopify, DB, HTTP) or stub (email, SMS, files) | Always real |

### Platform limitation detection

When the generator determines an app concept requires a capability outside this surface (e.g. real-time WebSockets, native GPU), the pipeline fails immediately before codegen with `errorCode: "platform_limitation"` and a merchant-friendly message. The frontend shows a distinct "Not supported yet" state rather than suggesting a retry.

### Platform limitation detection

When the architect determines an app concept requires a capability outside the ctx surface (e.g. real-time WebSockets, native GPU processing), the pipeline fails immediately before codegen with `errorCode: "platform_limitation"` and a merchant-friendly message. The frontend shows a distinct "Not supported yet" state with the specific reason, rather than suggesting a retry.

---

## App Categories & Types

We support four primary categories of applications. For the full catalog of supported app types see **[Supported Apps Catalog](./SUPPORTED_APPS_CATALOG.md)**.

### Category A — Storefront + Backend
Widget on the storefront. Backend stores config or processes webhook events into DB. No admin UI.
*(12 apps: Announcement Bar, Trust Badges, Free Shipping Progress Bar, Social Proof Pop, Currency Switcher, Age Gate…)*

### Category B — Storefront + Backend + Admin UI
Widget on the storefront for customer interaction, plus a merchant-facing dashboard embedded in the Shopify Admin.
*(4 apps: Price Drop Alert, Back In Stock Notify Me, Spin-to-Win Discount Wheel, Product Waitlist)*

### Category C — Backend Only
No storefront widget, no custom Admin UI. Apps are fully automatic (webhook or cron triggered).
*(10 apps: Order Thank You Email, Abandoned Cart SMS, Auto Order Tagger, Image Size Optimizer, Product Feed Generator…)*

### Category D — Backend + Admin UI
No storefront widget. Merchant-facing dashboard or control panel embedded in Shopify Admin.
*(8 apps: Bulk Order Tagger, CSV Exporter, Packing Slip Printer, Discount Code Generator, Analytics Dashboard…)*

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
Harness updated with all new services (stubs where noted). Generator prompts updated with all 4 categories and all ~21 app types. Each app type manually generated and tested end-to-end.

`platform-shopify-admin` embedded shell built:
- App Bridge initialisation + session token flow
- `GET /tenants/:shop/apps` API endpoint
- Sidebar listing merchant's platform apps with admin UI modules
- Dynamic `adminUiModule` loader (`mount(container, bridge)`)
- Bridge implementation: `call()` with session token, `notify()` via App Bridge Toast
- Session token JWT verification middleware on `POST /admin-ui/:shop/:appId/admin/*`
- `shopify.app.toml`: `embedded = true`, register `platform-shopify-admin` URL as app URL

### Phase 1 — Billing (~1 week)
Shopify `RecurringApplicationCharge` integrated. Plan stored per tenant. Services and app creation gated by plan. Upgrade prompts in platform dashboard.

### Phase 2 — App Store Launch (~2 weeks)
App Store listing and demo video. Submitted for Shopify review.

### Phase 3 — Real Integrations (~2 weeks, after first 10 paying merchants)
Email (Resend), SMS (Twilio), PDF (PDFKit), Files (GCS) replace their stubs. Usage billing added for email and SMS.

### Phase 4 — Expand (ongoing)
`ctx.queue` for fan-out, `ctx.services.ai`, wider app catalog.

---

## Expert Assist — Human in the Loop

When Ton can't get a merchant's app live on its own, a certified Shopify developer steps in.

### How it works

1. **On-demand** — A "Get expert help" button appears when a merchant is stuck (repeated validation failures, too many revisions without a deploy). Clicking it opens a paid session with a platform-certified developer.
2. **Auto-detected** — The platform watches for struggle signals (N failed generations, M revisions without deploy, age threshold). When they trip, Ton proactively offers expert help.
3. **Developer role** — The developer receives a read-only session link (prompt history, generated code, validation errors). They either make small surgical code edits directly, or write precise Ton revision prompts that the non-technical merchant couldn't. They guide Ton — they don't replace it.

### Monetization

Charged per session (credit-based). Merchants who never get stuck pay nothing extra. The platform takes a cut; developers are platform-certified, not a freelance marketplace.

### What comes later

Auto-discovery: track which app types, prompts, or merchant segments consistently need human help, then feed that signal back into Ton's prompts and validation rules.

---

## The Core Bet

A merchant paying $19/mo for "Notify Me," $29/mo for "Sales Pop," and $15/mo for "Announcement Bar" — three separate apps totalling $63/mo — will immediately see the value in paying $35/mo for a platform that generates all three (and 31 more) from a prompt.
