# Enhanced Handler Context Plan

This document outlines the strategic plan to enhance the `HandlerContext` (`ctx`) provided to the generated Shopify applications. The goal is to evolve the context from supporting basic webhooks and simple widgets to supporting a wide variety of small and medium-sized Shopify applications with robust capabilities.

## 1. 3rd-Party Integrations (Services Map)

To support integrations like SMS, mailing, or external CRMs without bloating the core app logic, we will use a Dependency Injection pattern via a **Services Map**.

**Concept:**
Instead of attaching `ctx.email`, `ctx.sms`, etc., directly to the root of the context, we group them into a `ctx.services` map. The harness provides the implementations (or logging stubs during development). This ensures the generated LLM code remains pure and agnostic of the actual provider (SendGrid, Twilio, etc.).

**Implementation Plan:**
*   **Types (`@new-one-two/types`):**
    *   Define interfaces like `EmailClient` and `SmsClient`.
    *   Create a `ServicesMap` interface: `{ email: EmailClient; sms: SmsClient; }`.
    *   Replace the direct `email` property on `HandlerContext` with `services: ServicesMap`.
*   **Harness (`@new-one-two/harness`):**
    *   In `build-ctx.ts` and `widget-handler.ts`, instantiate the `services` object with logging stubs that use the existing request logger (e.g., logging `EMAIL_SENT` and `SMS_SENT` events).
    *   Inject `services` into the `HandlerContext`.
*   **Generator (`generator/`):**
    *   Update `templates/harness_contract.py` to document the new `ctx.services` structure and replace `ctx.email` examples with `ctx.services.email`.
    *   Update `subagents/architect_agent.py` to instruct the AI to use `ctx.services`.

## 2. Shop Domain & Merchant Metadata (`ctx.shop`)

Handlers frequently need shop information to generate storefront links, send customized emails, or register external webhooks. While `ctx.tenantId` isolates database rows, it is an internal UUID. Furthermore, apps need metadata like currency and timezone for formatting and scheduling.

**Concept:**
Inject a `ctx.shop` object containing the shop's domain and essential metadata.

**Implementation Plan:**
*   **Types (`@new-one-two/types`):**
    *   Add `shop: { domain: string; currency?: string; timezone?: string; name?: string; email?: string; }` to `HandlerContext`.
*   **Harness (`@new-one-two/harness`):**
    *   Initially, inject `shop: { domain: APP_SHOP_DOMAIN }` using the existing environment variable.
    *   *Future Enhancement:* Fetch and cache the extended metadata (currency, timezone, etc.) during app installation or OAuth, and populate the rest of the `ctx.shop` object in the harness.
*   **Generator (`generator/`):**
    *   Update prompt templates to instruct the LLM to use `ctx.shop.domain` for generating storefront links, instead of hardcoding or hallucinating them.

## 3. Background Queues / Task Deferral (`ctx.queue`)

While the Gateway -> Worker architecture solves the Shopify 5-second webhook timeout, Cloud Run workers still have maximum execution times. If a handler needs to process thousands of records synchronously, it will time out.

**Concept:**
Provide a `ctx.queue` object to allow handlers to use "fan-out" or "task chunking". A handler can enqueue many tiny jobs back into Pub/Sub for workers to process independently and in parallel.

**Implementation Plan:**
*   **Types (`@new-one-two/types`):** Add `queue: { push(topic: string, payload: unknown): Promise<void> }` to `HandlerContext`.
*   **Pub/Sub Client:** Update `@new-one-two/pubsub-client` to allow publishing arbitrary developer-defined topics.
*   **Harness:** Implement `ctx.queue` using the Pub/Sub client so handlers can dispatch background jobs to the existing Worker infrastructure.
*   **Generator (`generator/`):**
    *   Enhance `subagents/architect_agent.py` to identify large batch operations (e.g., syncing all products) and architect them using `ctx.queue.push()`.
    *   Update `templates/harness_contract.py` to provide a code example of task chunking.

## 4. Storefront API Client (`ctx.storefront`)

While frontend widgets call the public Ajax API natively, the backend handler sometimes needs to query data using the Storefront GraphQL API (to avoid Admin API rate limits or to generate tokens). Currently, `ctx.shopify` is strictly an Admin API client.

**Implementation Plan:**
*   **Types (`@new-one-two/types`):** Add a `storefront` object with a `graphql` method to `HandlerContext`.
*   **Harness:** Implement a `buildStorefrontClient` function that utilizes a `Storefront-Access-Token` to provide `ctx.storefront.graphql()`.
*   **Generator (`generator/`):**
    *   Document `ctx.storefront.graphql` in the contract template and instruct the AI when to prefer it over the Admin API (e.g., fetching product recommendations or customer public data).

## 5. Embedded Admin UI Context (`trigger: "admin"`)

Most medium-sized apps have an embedded merchant dashboard (using Shopify App Bridge).

**Implementation Plan:**
*   **Types:** Add `"admin"` to the `trigger` union in `HandlerContext`. Add optional `adminPath` and `adminBody` fields.
*   **Harness:** Create an `admin-handler.ts` (mirroring `widget-handler.ts`). It must extract the `tenantId`, validate the Shopify Session Token (App Bridge JWT) to ensure the request is authentically from the merchant, and invoke the handler with `trigger: "admin"`.
*   **Gateway/Worker:** Expose an `/admin/*` route to route traffic from the frontend dashboard to the harness.
*   **Generator (`generator/`):**
    *   Add a new agent or prompt section specifically for generating the App Bridge frontend UI (React/Polaris).
    *   Update the backend handler generation logic to handle `trigger === "admin"` explicitly, ensuring it responds with the data required by the merchant dashboard.

## 6. Billing and Monetization (`ctx.billing`)

Managing Shopify's Billing API manually via `ctx.shopify.graphql` is complex.

**Implementation Plan:**
*   **Types:** Add `billing` object to `HandlerContext`.
*   **Harness:** Implement helper methods on `ctx.billing` (e.g., `hasActiveSubscription()`, `requireActiveSubscription(planId)`) that automatically execute the correct Admin GraphQL queries and return checkout URLs if needed.
*   **Generator (`generator/`):**
    *   Add billing examples to `templates/harness_contract.py`.
    *   Instruct the generator to automatically wrap premium feature logic inside `if (await ctx.billing.hasActiveSubscription())` checks.

## 7. Key-Value Settings / App Metafields (`ctx.settings`)

*(Currently Out of Scope, but documented for completeness)*
Most small apps simply toggle features on/off. An abstraction like `ctx.settings.get('config')` that manages saving/retrieving merchant configuration (persisting to Postgres or Shopify App Metafields) simplifies code generation.

## 8. Caching (`ctx.cache`)

Shopify's Admin API has strict "leaky bucket" rate limits. A `ctx.cache.get/set` (e.g., backed by Redis) is needed to memoize API responses, products, or tenant configurations to prevent throttling in high-traffic widgets.

## 9. Bulk Operations API Helpers

Medium apps handling mass data syncing cannot use standard GraphQL queries due to pagination limits. A streamlined way to trigger and handle Shopify's asynchronous Bulk Operations API within the handler is needed.

---

## Immediate Execution Plan (Phase 1)

This phase focuses on the immediate foundational improvements: Context Foundation & 3rd-Party Integrations.

1.  **Update Types (`platform/packages/types/src/index.ts`):**
    *   Create `ServicesMap` interface containing `email` and `sms` definitions.
    *   Replace `email` property with `services: ServicesMap` in `HandlerContext`.
    *   Add `shop: { domain: string }` to `HandlerContext`.
2.  **Update Harness (`platform/packages/harness/src/build-ctx.ts` & `widget-handler.ts`):**
    *   Create the `services` object with logging stubs for `email` and `sms`.
    *   Update the returned `HandlerContext` to include `shop: { domain: APP_SHOP_DOMAIN }` and the new `services` map.
3.  **Update Consumers (Including Generator Component):**
    *   **Generator Templates:** Update `generator/templates/harness_contract.py` to document `ctx.services.email.send()` instead of `ctx.email.send()`. Document any new services like `ctx.services.sms.send()` when they are implemented.
    *   **Generator Agents:** Update `generator/subagents/architect_agent.py` to instruct the AI to use `ctx.services.email` instead of `ctx.email` and ensure it recognizes the new `ctx.services` structure.
    *   **Existing Test Apps:** Update any existing test apps or manual prompts that use `ctx.email.send()` to use `ctx.services.email.send()`.
