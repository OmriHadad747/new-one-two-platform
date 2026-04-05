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

## Services Supported in MVP

| Service | Status | Notes |
|---------|--------|-------|
| `ctx.shopify` (Admin API) | Real | Already working |
| `ctx.db` (Postgres, tenant-isolated) | Real | Already working |
| `ctx.http` | Real | Thin fetch wrapper with logging |
| `ctx.storefront` (Storefront GraphQL) | Real | Storefront Access Token created at OAuth, stored per tenant |
| `ctx.shop` (`{ domain }`) | Real | From env var |
| `ctx.services.email` | Stub → real Phase 3 | Logs `EMAIL_SENT` in dev; real impl uses Resend |
| `ctx.services.sms` | Stub → real Phase 3 | Logs `SMS_SENT` in dev; real impl uses Twilio |
| `ctx.services.pdf` | Stub → real Phase 3 | Real impl uses PDFKit (in-process, no external API) |
| `ctx.services.csv` | Real | Pure in-process, zero external dependency |
| `ctx.services.files` | Stub → real Phase 3 | Real impl uses GCS |
| `ctx.services.image.resize` | Stub → real Phase 3 | Stub fetches URL and returns original bytes; real impl uses sharp |
| `ctx.services.image.analyze` | Stub → real Phase 3 | Stub returns zero dims; real impl uses sharp metadata |
| `ctx.services.qrcode` | Real | Pure JS (`qrcode` package); returns PNG Buffer or SVG string |
| `ctx.services.barcode` | Real | Pure JS (`jsbarcode` + `@xmldom/xmldom`); returns SVG string |

**Not in MVP:** `ctx.queue`, `ctx.cache`, `ctx.billing`, `ctx.services.ai`

### Platform limitation detection

When the architect determines an app concept requires a capability outside the ctx surface (e.g. real-time WebSockets, native GPU processing), the pipeline fails immediately before codegen with `errorCode: "platform_limitation"` and a merchant-friendly message. The frontend shows a distinct "Not supported yet" state with the specific reason, rather than suggesting a retry.

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
No storefront widget, no custom Admin UI. Apps are fully automatic (webhook or cron triggered).
*(Examples: Order Thank You Email, Abandoned Cart SMS, Image Size Optimizer)*

### Category D — Backend + Admin UI
No storefront widget. Includes a merchant-facing dashboard or control panel embedded in the Shopify Admin.
*(Examples: Bulk Order Tagger, Custom Order CSV Exporter, App Configuration Dashboard)*

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

## The Core Bet

A merchant paying $19/mo for "Notify Me," $29/mo for "Sales Pop," and $15/mo for "Announcement Bar" — three separate apps totalling $63/mo — will immediately see the value in paying $35/mo for a platform that generates all three (and 18 more) from a prompt.
