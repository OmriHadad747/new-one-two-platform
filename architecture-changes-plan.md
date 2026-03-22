# Shopify AI-PaaS — Architecture Changes Plan

## Context

The platform uses ONE Umbrella App (Shopify Partner Dashboard), installed by all merchants via OAuth.
Multi-tenancy is handled via backend tenant routing + RLS PostgreSQL.

The following changes reflect a shift in how the AI generator handles storefront apps:
- The AI no longer generates App Block code (Liquid/JS)
- The AI now generates (1) a widget config JSON + (2) a backend handler
- The App Block is written once by the platform developer and updated independently via Shopify CLI

---

## Change 1 — Phase 0: Data Model

### Add two columns to the tenants table

```sql
ALTER TABLE tenants
  ADD COLUMN app_archetype TEXT NOT NULL
    CHECK (app_archetype IN ('storefront_ui', 'backend_only')),
  ADD COLUMN widget_config JSONB;
```

**`app_archetype`**
- `storefront_ui` — app has a visible storefront component (App Block required)
- `backend_only` — app is pure backend: sync, automation, reporting, workflow

**`widget_config`**
- Only populated when `app_archetype = 'storefront_ui'`
- Contains the full widget definition served to the App Block at runtime
- NULL for backend_only tenants

### Example tenant record (storefront_ui)

```json
{
  "tenant_id": "tenant_abc123",
  "shop": "merchantA.myshopify.com",
  "access_token": "shpua_xxxx",
  "app_archetype": "storefront_ui",
  "widget_config": {
    "widget_type": "notify_me",
    "trigger_condition": "out_of_stock",
    "ui": {
      "button_text": "Notify Me When Available",
      "input_placeholder": "Enter your email",
      "success_message": "We'll let you know!"
    },
    "actions": {
      "on_submit": "/tenant/abc123/subscribe"
    }
  }
}
```

### Example tenant record (backend_only)

```json
{
  "tenant_id": "tenant_def456",
  "shop": "merchantB.myshopify.com",
  "access_token": "shpua_yyyy",
  "app_archetype": "backend_only",
  "widget_config": null
}
```

---

## Change 2 — Phase 3: AI Generator Output Contract

### Before (old contract)
The AI generator produced:
- App Block code (Liquid/JS/CSS)
- Backend handler

### After (new contract)
The AI generator produces up to 4 outputs depending on app archetype and prompt requirements:

**For `storefront_ui` apps:**
- `widget_config` JSON (conforms to renderer schema — see below)
- Backend handler (conforms to harness interface)
- DB migration (if app requires persistent data)
- Admin UI extension config (if merchant needs a Shopify admin surface — prompt-dependent)

**For `backend_only` apps:**
- Backend handler only (conforms to harness interface)
- DB migration (if app requires persistent data)
- Admin UI extension config (if merchant needs a Shopify admin surface — prompt-dependent)
- No storefront frontend output

### Output decision matrix

| Output | storefront_ui | backend_only | Condition |
|---|---|---|---|
| `widget_config` JSON | ✅ Always | ❌ Never | archetype = storefront_ui |
| Backend handler | ✅ Always | ✅ Always | Always |
| DB migration | ⚠️ Conditional | ⚠️ Conditional | App requires persistent tenant data |
| Admin UI extension | ⚠️ Conditional | ⚠️ Conditional | Merchant needs admin-facing UI (prompt-driven) |

### Widget Config Schema (what AI must conform to)

```typescript
type WidgetConfig = {
  widget_type: "notify_me" | "stock_counter" | "countdown" | string; // extend over time
  trigger_condition?: "out_of_stock" | "always" | "low_stock";
  ui: Record<string, string | number | boolean>;
  actions: {
    on_submit?: string;   // relative endpoint path
    on_load?: string;
    data_source?: string;
  };
};
```

The AI must only use `widget_type` values that exist in the App Block renderer registry.
The AI must never generate raw HTML, Liquid, or JS for the storefront.

### Backend Handler Interface (unchanged harness contract)

```typescript
module.exports = {
  // Called when a shopper submits the widget form
  onSubscribe?: async (tenantId: string, payload: object) => void,

  // Called when Shopify fires a relevant webhook
  onWebhook?: async (tenantId: string, topic: string, payload: object) => void,

  // Called on a schedule (if app is scheduled)
  onSchedule?: async (tenantId: string) => void,
}
```

### DB Migration Contract (existing, unchanged)

The AI generates a migration file per tenant that runs in the tenant's isolated schema:

```sql
-- Example: notify me use case
CREATE TABLE tenant_abc123.subscribers (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  product_id TEXT NOT NULL,
  subscribed_at TIMESTAMPTZ DEFAULT NOW()
);
```

No change needed here — this was already part of the generator contract.

### Admin Surface — Two Distinct Types

There are two separate admin surfaces. They serve different purposes and are built differently.

---

#### 1. Embedded App (primary merchant UI — SSR, your own pages)

When the merchant needs a full management interface
(e.g. "I want to manage my subscribers", "show me a dashboard for my app"),
this is served via your **Embedded App** — an iframe rendered inside the Shopify admin
pointing at your own backend pages.

- Fully server-side rendered — Node/Fastify, your stack, your freedom
- No constraint to Shopify's component library (though Polaris is recommended)
- Supports complex multi-page flows, tables, settings, charts
- Already part of your Umbrella App — no additional Shopify deployment needed
- Uses App Bridge to communicate with the Shopify admin shell

The AI generates a **route config** that tells your Embedded App what pages/views
to expose for this tenant:

```json
{
  "admin_pages": [
    {
      "route": "/tenant/abc123/subscribers",
      "page_type": "data_table",
      "title": "Back in Stock Subscribers",
      "columns": ["email", "product_id", "subscribed_at"],
      "actions": [{ "label": "Export CSV", "endpoint": "/tenant/abc123/subscribers/export" }]
    }
  ]
}
```

Same config-driven renderer pattern — your Embedded App has pre-built page templates,
AI generates the config that maps to them.

---

#### 2. Admin UI Extension (optional, contextual — client-side Preact/React)

Small components injected into **existing Shopify admin pages**
(e.g. a block that appears directly on the Order or Product detail page).

- Client-side only (Preact/React), constrained to Shopify's component library
- Deployed via Shopify CLI, same track as App Block
- Only relevant when the merchant wants contextual data surfaced inside a native admin page
- Prompt-driven — only generated when explicitly needed

```json
{
  "admin_extension_type": "product_block",
  "target": "admin.product-details.block.render",
  "data_source": "/tenant/abc123/stock-subscribers?product={product_id}"
}
```

**Deployment:** Deployed via Shopify CLI. Same additive-only versioning rules as App Block.

---

## Change 3 — Phase 1: Webhook Gateway

### Add archetype-aware routing

When a webhook arrives, the gateway must:
1. Resolve tenant from shop domain
2. Check `app_archetype`
3. If `backend_only` → route directly to handler
4. If `storefront_ui` → route to handler (widget config is not involved in webhook processing)

No structural change to the gateway — just ensure `app_archetype` is included in the tenant
context object passed through the routing pipeline.

---

## New Track — App Block (outside the AI pipeline)

This is a separate operational track, not part of Phases 0–3.

### Responsibilities
- Written and maintained by the platform developer (not AI-generated)
- Deployed and updated via Shopify CLI independently of the tenant pipeline
- Serves all merchants — one deployment, all tenants

### Runtime behavior

```javascript
// App Block pseudocode — written once, updated as new widget types are added
const RENDERERS = {
  "notify_me":     renderNotifyMeWidget,
  "stock_counter": renderStockCounterWidget,
  // add new renderers here over time — never remove existing ones
};

const config = await fetch(`https://platform.com/widget-config?shop=${shop}&product=${productId}`);
const renderer = RENDERERS[config.widget_type] ?? renderFallbackWidget;
renderer(config.ui, config.actions);
```

### API endpoint to expose (add to Phase 1 gateway)

```
GET /widget-config?shop={shop}&product={product_id}

→ Resolves tenant from shop param
→ Returns tenant.widget_config from DB
→ Used by App Block on every storefront page load
```

### Deployment rule
- New widget types → add renderer to App Block → push via Shopify CLI → auto-propagates to all merchants
- Never rename or remove an existing `widget_type` key (breaks existing tenant configs)
- Always add a fallback renderer for unknown widget types

---

## Summary of Changes Per Phase

| Phase | Change | Type |
|---|---|---|
| Phase 0 | Add `app_archetype` + `widget_config` columns to tenants table | Data model |
| Phase 1 | Add `/widget-config` endpoint to webhook gateway | New endpoint |
| Phase 1 | Pass `app_archetype` in tenant context through routing pipeline | Minor addition |
| Phase 3 | AI generator outputs widget config JSON instead of App Block code | Core logic change |
| Phase 3 | AI generator skips frontend output entirely for `backend_only` archetype | Conditional logic |
| Phase 3 | AI generator conditionally outputs DB migration (unchanged contract) | Clarification only |
| Phase 3 | AI generator conditionally outputs Embedded App route config (SSR, prompt-driven) | New output type |
| Phase 3 | AI generator conditionally outputs Admin UI Extension config (contextual, prompt-driven) | New output type |
| New track | App Block renderer — written once, deployed via Shopify CLI | Separate track |
| New track | Admin UI Extension renderer — written once, deployed via Shopify CLI | Separate track |
| New track | Embedded App pages — SSR, your stack, pre-built page templates | Separate track |
