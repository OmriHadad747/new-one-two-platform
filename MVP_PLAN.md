# MVP Plan — Small Shopify App Generator

## Context

The platform generates two artifacts per app:
1. A widget ES module (client-side, sandboxed under the host API)
2. A TypeScript handler (server-side, has access to `ctx`)

Only the TypeScript handler uses `ctx`. The widget talks to the backend through `host.backend()` calls. This plan scopes the infra to what is actually needed to power the 10 app types below — nothing more.

---

## Part 1 — The 10 App Types

These are chosen so that "Notify Me" and "Image Optimizer" sit at the ceiling of complexity. Everything below is achievable with `db`, `http`, `mail`, `sms`, and `files` — mostly just `db`.

### Tier A — Widget + DB Only (simplest)

| # | App | What it does | Infra |
|---|-----|-------------|-------|
| 1 | **Announcement Bar** | Configurable scrolling or static banner with message, color, CTA link, and optional schedule. Merchant configures via platform. | `db` (config) |
| 2 | **Trust & Payment Badges** | Displays trust badges (SSL, money-back, shipping guarantees) on product pages. Merchant picks which badges and layout. | `db` (config) |
| 3 | **Cookie Consent Banner** | GDPR/CCPA cookie consent popup. Accept/decline. Logs consent timestamp per visitor. | `db` (config + consent log) |
| 4 | **Flash Sale Countdown Timer** | Countdown widget tied to a sale end time. Shows urgency. When timer expires, widget disappears or shows "Sale ended". | `db` (config: end_time, message) |
| 5 | **Free Shipping Progress Bar** | Shows how close the cart is to a free shipping threshold. Reads cart total via host API, compares to stored threshold. | `db` (config: threshold) |

### Tier B — Widget + Webhook + DB (medium)

| # | App | What it does | Infra |
|---|-----|-------------|-------|
| 6 | **Social Proof Sales Pop** | "Sofia from Berlin just bought X" popup. Webhook captures recent orders into DB. Widget polls backend for the latest order and animates it. | `db` + webhook |
| 7 | **Low Stock Urgency Badge** | Shows "Only 3 left!" on product pages. Webhook on `inventory_levels/update` writes stock count to DB. Widget reads from DB (not live Shopify API, so no rate limit risk). | `db` + webhook |

### Tier C — Webhook + Email + DB (ceiling)

| # | App | What it does | Infra |
|---|-----|-------------|-------|
| 8 | **Order Thank You Email** | After a successful order, sends a personalized branded thank-you email with order details and a discount for the next purchase. Webhook on `orders/paid`. | `db` (template config) + `mail` |
| 9 | **Post-Purchase Review Request** | X days after fulfillment, sends an email asking the customer to leave a review, with a direct link. Webhook on `orders/fulfilled` stores a "send at" timestamp. Cron picks up due records and sends. | `db` + `mail` + cron |
| 10 | **Back In Stock Notify Me** | Widget form lets customers sign up for restock alerts. Webhook on `inventory_levels/update` triggers email to all subscribers for that variant. | `db` + `mail` + webhook + widget |

### Reference (file storage ceiling)

| App | What it does | Infra |
|-----|-------------|-------|
| **Image Alt Text Generator** | Webhook on product create/update → calls vision API via `http` → patches product alt text via Admin API. No widget, no email. Simple but demonstrates `http` usage well. | `db` + `http` |
| **Image Size Optimizer** | Webhook on product image → fetches image → compresses via `http` (TinyPNG/Kraken API) → re-uploads to Shopify. Stores before/after size stats. | `db` + `http` + `files` |

Image apps sit at the ceiling because of file handling. They are excluded from the initial 10 but useful as generator test cases for the `files` stub.

---

## Part 2 — Infra Scope for MVP

### What exists today

| Capability | Status |
|-----------|--------|
| `ctx.shopify` (Admin API client) | Real, working |
| `ctx.db` (Postgres via pg, tenant-isolated) | Real, working |
| `ctx.email` (stub, logs `EMAIL_SENT`) | Stub, working |
| `ctx.logger` | Real, working |
| `ctx.tenantId` | Real, working |
| `ctx.trigger` / `ctx.payload` | Real, working |

### What to add for MVP

| Capability | MVP Implementation | Notes |
|-----------|-------------------|-------|
| `ctx.http` | **Real** — thin `fetch` wrapper with timeout, error normalisation, logger integration | The only real new service. Needed for image apps and any external API call. |
| `ctx.services.email` | Stub — logs `EMAIL_SENT` with `{to, subject, preview}` | Rename from `ctx.email`. Real SendGrid/Resend in Phase 2. |
| `ctx.services.sms` | Stub — logs `SMS_SENT` with `{to, preview}` | No real use in the 10 apps above, but expected by the harness contract. Real Twilio in Phase 2. |
| `ctx.services.files` | Stub — logs `FILE_STORED`, returns a fake URL | Needed for image optimizer testing. Real GCS in Phase 2. |
| `ctx.shop` | `{ domain: string }` — read from env var `APP_SHOP_DOMAIN` | Used by generators to build storefront links. |

### What NOT to add in MVP

- `ctx.queue` — none of the 10 apps need fan-out
- `ctx.storefront` — widgets talk to Storefront directly via `host.storefront()`, no backend proxy needed
- `ctx.billing` — handled at platform level, not inside generated handlers
- `ctx.cache` — not needed until traffic warrants rate-limit protection

---

## Part 3 — Code Changes Required

### 3.1 Types (`platform/packages/types/src/index.ts`)

```typescript
// New interfaces
interface HttpClient {
  get(url: string, options?: RequestInit): Promise<unknown>;
  post(url: string, body: unknown, options?: RequestInit): Promise<unknown>;
}

interface EmailClient {
  send(params: { to: string; subject: string; html: string; text?: string }): Promise<void>;
}

interface SmsClient {
  send(params: { to: string; text: string }): Promise<void>;
}

interface FilesClient {
  upload(params: { key: string; buffer: Buffer; mimeType: string }): Promise<{ url: string }>;
  download(key: string): Promise<Buffer>;
}

interface ServicesMap {
  email: EmailClient;
  sms: SmsClient;
  files: FilesClient;
}

interface ShopContext {
  domain: string;
}

// Updated HandlerContext
interface HandlerContext {
  shopify: ShopifyClient;
  db: postgres.TransactionSql;
  http: HttpClient;           // NEW
  services: ServicesMap;      // NEW — replaces ctx.email
  shop: ShopContext;          // NEW
  payload: Record<string, unknown>;
  logger: HandlerLogger;
  tenantId: string;
  trigger: "webhook" | "cron" | "widget";
  widgetPath?: string;
  widgetBody?: Record<string, unknown>;
  customerId?: string | null;
}
```

Remove the old `email: EmailClient` direct property.

### 3.2 Harness (`platform/packages/harness/src/build-ctx.ts`)

```typescript
function buildServices(logger: HandlerLogger): ServicesMap {
  return {
    email: {
      async send({ to, subject, html }) {
        logger.info({ event: 'EMAIL_SENT', to, subject, preview: html.slice(0, 100) });
      },
    },
    sms: {
      async send({ to, text }) {
        logger.info({ event: 'SMS_SENT', to, preview: text.slice(0, 80) });
      },
    },
    files: {
      async upload({ key, mimeType }) {
        logger.info({ event: 'FILE_STORED', key, mimeType });
        return { url: `https://files.stub/${key}` };
      },
      async download(key) {
        logger.info({ event: 'FILE_FETCHED', key });
        return Buffer.alloc(0);
      },
    },
  };
}

function buildHttp(logger: HandlerLogger): HttpClient {
  return {
    async get(url, options) {
      logger.info({ event: 'HTTP_GET', url });
      const res = await fetch(url, { ...options, method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status} GET ${url}`);
      return res.json();
    },
    async post(url, body, options) {
      logger.info({ event: 'HTTP_POST', url });
      const res = await fetch(url, {
        ...options,
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', ...options?.headers },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} POST ${url}`);
      return res.json();
    },
  };
}

// In buildCtx:
export function buildCtx(req, tx, logger): HandlerContext {
  return {
    shopify: buildShopifyClient(...),
    db: tx,
    http: buildHttp(logger),         // NEW
    services: buildServices(logger), // NEW
    shop: { domain: process.env.APP_SHOP_DOMAIN! }, // NEW
    payload: ...,
    logger,
    tenantId: req.tenantId,
    trigger: 'webhook',
  };
}
```

Apply same change in `widget-handler.ts`.

### 3.3 Generator (`generator/`)

**`templates/harness_contract.py`** — document the new APIs:
- Replace all `ctx.email.send()` examples with `ctx.services.email.send()`
- Add `ctx.http.get()` / `ctx.http.post()` section with a real example (fetching from an external API)
- Add `ctx.services.sms.send()` with a note that it is a stub in development
- Add `ctx.services.files.upload()` with a note it returns a fake URL in development
- Add `ctx.shop.domain` — show how to use it for storefront URLs
- Add one complete example handler per app type (see Part 4 below)

**`subagents/architect_agent.py`** — update system instructions:
- Use `ctx.services.email` not `ctx.email`
- Use `ctx.http` for all external HTTP calls (never raw `fetch`)
- Use `ctx.shop.domain` to generate storefront URLs — never hardcode or guess domains

---

## Part 4 — Monetization

### Pricing Model: Subscription Tiers via Shopify Billing API

Charge for **the platform** (running and hosting apps), not per generation. Generation is cheap; the value is in having live, working apps.

| Plan | Price | Limits | Notes |
|------|-------|--------|-------|
| **Free** | $0/mo | 1 active app, Tier A only (widget+DB apps, #1–5) | Shopify App Store discoverability |
| **Starter** | $12/mo | 3 active apps, all 10 app types | Target: solo merchants testing the idea |
| **Growth** | $29/mo | 10 active apps, all types, priority generation queue | Target: merchants with multiple stores or apps |

### Why these numbers

- Free tier gets the app into the Shopify App Store with a zero-friction install. Merchants see it working before they pay.
- $12 is below the psychological threshold where merchants casually cancel. It's cheaper than every alternative (hiring a dev, buying a dedicated app).
- $29 competes with mid-tier dedicated apps (e.g., a dedicated "Notify Me" app costs $19–39/mo for one feature; your platform generates all 10 for $29).

### What triggers upgrades

- Free → Starter: merchant wants to add email to their app (Tier C), or wants a second app.
- Starter → Growth: merchant hits the 3-app limit or wants 10+ active apps.

### Implementation

Use Shopify's `RecurringApplicationCharge` API. On install, redirect to the billing confirmation URL. On approval, store `charge_id` and `plan` in the `tenants` table. Gate app creation and trigger types (mail/sms) based on plan in `build-ctx.ts`.

```typescript
// In buildServices — gate mail/sms based on plan
email: {
  async send(params) {
    if (tenant.plan === 'free') throw new Error('Email requires Starter plan or above');
    logger.info({ event: 'EMAIL_SENT', ...params });
  },
},
```

### Future: Usage Billing (Phase 2)

Once real email and SMS integrations are live, add Shopify `UsageCharge` on top of the subscription:
- Email: $0.001/send (after 1,000 free/mo included in plan)
- SMS: $0.05/send

This protects you from a viral app costing you hundreds in Twilio/SendGrid fees.

---

## Part 5 — Execution Plan

### Phase 0 — Foundation (now, ~1 week)

**Goal:** Harness supports all 10 app types with stubs. Generator can produce working handlers for all of them.

1. Update `platform/packages/types/src/index.ts` with new interfaces (ServicesMap, HttpClient, ShopContext).
2. Update `platform/packages/harness/src/build-ctx.ts` to add `http`, `services`, `shop`. Remove top-level `email`.
3. Update `platform/packages/harness/src/widget-handler.ts` with same ctx changes.
4. Update `generator/templates/harness_contract.py` — document new ctx surface, add an example for each of the 10 app types.
5. Update `generator/subagents/architect_agent.py` — point to `ctx.services.email`, `ctx.http`, `ctx.shop.domain`.
6. Manually generate and test each of the 10 app types. Fix any prompt failures.

### Phase 1 — Monetization Infrastructure (~1 week)

**Goal:** Platform can accept paying merchants.

1. Add `plan` and `charge_id` columns to tenants table.
2. On install: present Shopify billing confirmation for Starter ($12/mo).
3. Gate `services.email` / `services.sms` behind plan check in harness.
4. Gate app creation count behind plan check in the platform API.
5. Add "upgrade" prompt in the platform UI when a merchant hits a limit.

### Phase 2 — Shopify App Store Launch (~2 weeks)

**Goal:** Public listing. Real merchants install the app.

1. Write App Store listing copy. Use the 10 app types as the feature list.
2. Create demo video showing generation → live widget in under 2 minutes.
3. Submit for Shopify review.
4. Set up basic support channel (email or Discord).

### Phase 3 — Real Service Integrations (~2 weeks, after first 10 paying merchants)

**Goal:** Email and SMS work for real. Image optimizer works end-to-end.

1. Integrate Resend (or SendGrid) for `ctx.services.email`. Swap stub for real client in `build-ctx.ts`.
2. Integrate Twilio for `ctx.services.sms`.
3. Integrate GCS for `ctx.services.files`. Image optimizer app now works.
4. Add `UsageCharge` metering for email and SMS sends.
5. Surface usage stats in the merchant platform dashboard.

### Phase 4 — Expand Catalog (ongoing)

- Add `ctx.queue` for fan-out (needed for bulk operations, syncing all products).
- Add `ctx.storefront` for backend Storefront API queries.
- Add `ctx.services.ai` for AI-powered apps (auto-tagging, description generation).
- Expand to 20–30 app templates with more complex flows.

---

## Summary

| | Phase 0 | Phase 1 | Phase 2 | Phase 3 |
|---|---------|---------|---------|---------|
| Infra | stubs + real http | billing gates | — | real email/SMS/files |
| Apps | all 10 working | — | public | image optimizer working |
| Revenue | $0 | $0 | first $ | scalable |
| Focus | generation quality | monetization plumbing | distribution | cost protection |

The bet is: merchants will pay $12/mo for a tool that generates a working "Social Proof Pop" or "Notify Me" widget in 30 seconds — something that would cost $300+ to build custom or $19+/mo for a dedicated single-purpose app.
