# External Services and Monetization Strategy

This document outlines the recommended 3rd-party services to include in the platform's `ServicesMap` to support small-to-medium Shopify apps, along with strategies for monetizing and controlling the variable costs associated with these services.

---

## 1. Recommended External Services

Beyond `email`, `sms`, and basic `http`, Shopify merchants typically request apps that handle these specific domains. Having typed, pre-built abstractions for these makes the LLM's job much easier and the generated apps much more reliable.

*   **`ctx.services.pdf` (Document Generation)**
    *   *Why:* Generating invoices, customized packing slips, return labels, or digital product downloads is a massive category of Shopify apps.
    *   *Methods:* `generate(htmlOrTemplateId: string, data: any): Promise<Buffer>`

*   **`ctx.services.spreadsheet` (Google Sheets / Airtable)**
    *   *Why:* Non-technical merchants run their businesses on spreadsheets. Apps that say "Export all high-value customers to a Google Sheet" or "Sync inventory from Airtable" are incredibly common.
    *   *Methods:* `appendRow(sheetId: string, row: any[])`, `updateRow(...)`

*   **`ctx.services.ai` (LLM / OpenAI)**
    *   *Why:* Auto-tagging products, generating localized product descriptions, summarizing customer support tickets, or deciding if an order looks fraudulent.
    *   *Methods:* `generateText(prompt: string)`, `analyzeImage(imageUrl: string)`

*   **`ctx.services.crm` (Klaviyo / Mailchimp Abstraction)**
    *   *Why:* While `email` sends a transactional message, merchants want to *subscribe* users to marketing flows.
    *   *Methods:* `addSubscriber(listId: string, email: string, traits?: any)`

*   **`ctx.services.translation` (DeepL / Google Translate)**
    *   *Why:* Shopify multi-market is huge. Auto-translating metafields, reviews, or customized widget text based on the buyer's locale.
    *   *Methods:* `translateText(text: string, targetLanguage: string)`

---

## 2. Monetization & Cost Control Strategy

If you offer a flat monthly subscription (e.g., "$29/mo for up to 3 apps") but those apps use your Twilio SMS or OpenAI accounts, a single viral app could cost you hundreds of dollars in API fees, bankrupting the platform.

Here are the three best ways to structure monetization for a PaaS like this:

### Option A: "Bring Your Own Key" (BYOK) - *Safest & Easiest to Start*
You charge the merchant for the **platform and the AI generation**, but they pay for the variable costs of external services.
*   **How it works:** In your platform dashboard, you have an "Integrations" page. To use the SMS feature in their generated app, the merchant must paste their own Twilio API Key. To use AI, they paste their own OpenAI key.
*   **Monetization:** You charge a flat monthly fee (e.g., $19/mo Starter, $49/mo Pro) based on the *number of generated apps* and *database storage*.
*   **Pros:** Zero risk to you. No complex billing logic required.
*   **Cons:** Higher friction for the merchant during onboarding.

### Option B: The "Platform Credits" System - *Most Scalable & Profitable*
This is the standard model for platforms like Zapier or Make.com. You abstract the underlying providers completely.
*   **How it works:** Merchants subscribe to a plan that gives them a monthly bucket of "Compute Credits."
    *   App execution (Webhook): 1 Credit
    *   Sending an Email: 5 Credits
    *   Sending an SMS: 50 Credits
    *   AI Generation: 100 Credits
*   **Monetization:** 
    *   Starter ($19/mo) = 10,000 Credits. 
    *   Pro ($49/mo) = 50,000 Credits.
    *   Using Shopify's **App Usage Billing API**, if they exceed their credits, you automatically charge them $0.005 per extra credit.
*   **Pros:** Highly profitable. You buy SMS/AI at wholesale API prices and sell them at retail credit prices. Frictionless for merchants (it "just works").
*   **Cons:** Requires building a metering system in your `harness` to track usage.

### Option C: Tiered Capability Unlocks - *Value-Based Pricing*
You limit *which* services the `ctx` object is allowed to use based on their platform subscription.
*   **How it works:** When the harness builds the `ctx`, it checks the tenant's plan. If a Starter plan app tries to call `ctx.services.sms.send()`, the stub throws a "Feature requires Pro plan" error.
*   **Monetization:**
    *   **Starter ($15/mo):** Up to 2 apps. Access to `shopify`, `db`, `http`, `email`.
    *   **Growth ($49/mo):** Up to 5 apps. Unlocks `sms`, `ai`, `spreadsheet`.
    *   **Plus ($99/mo):** Unlimited apps. Unlocks `pdf`, `crm`, and `queue` (for bulk operations).
*   **Cost Control:** You still need a hard cap (e.g., max 100 SMS per month on Growth) to prevent abuse, utilizing Shopify Usage Billing for overages.

---

## 3. Recommendation for Your Architecture

A **Hybrid of B (Credits) and C (Tiers)**, implemented directly via the Shopify Billing API, is the most robust approach:

1.  **Use Shopify Usage Billing:** Shopify has a built-in `appSubscriptionCreate` GraphQL mutation where you define a capped usage amount (e.g., "Max $100/mo of variable usage").
2.  **The Harness Metering Wrapper:** In `platform/packages/harness/src/build-ctx.ts`, you implement your `services` map so that every time a service is called, it increments a Redis counter or database row for that `tenantId`.
    ```typescript
    sms: {
      async send(phone, text) {
        await meterUsage(tenantId, 'sms', 1); // Charges the merchant $0.05 via Shopify API
        await realSmsProvider.send(phone, text);
      }
    }
    ```
3.  **The Pitch to the Merchant:** "Generate unlimited custom internal apps. $29/mo platform fee. Pay only for the SMS/Emails/AI you actually use via Shopify billing."

This keeps your basic subscription simple (focusing on the value of having a custom app) while entirely protecting you from the variable API costs of the `ctx.services` you are providing.
