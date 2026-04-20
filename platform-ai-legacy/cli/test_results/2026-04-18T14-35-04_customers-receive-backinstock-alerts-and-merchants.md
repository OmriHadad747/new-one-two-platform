# Chat Local — Full Pipeline

**Date:** 2026-04-18 14:42:49  
**Status:** ✅ SUCCESS  
**Total:** 465072ms  
**Tokens:** in=76523 out=52178 total=128701  
**Prompt:** Customers receive back-in-stock alerts, and merchants can view/manage subscriber lists and notification logs.

## Intent (Product Agent)

```json
{
  "triggerTypes": [
    "widget",
    "webhook"
  ],
  "resources": [
    "Product",
    "Inventory",
    "Customer",
    "Email"
  ],
  "desiredOutcome": "Customers receive back-in-stock alerts, and merchants can view/manage subscriber lists and notification logs.",
  "cronHint": null,
  "appCategory": "storefront_backend_admin",
  "qualityBrief": "A good version handles: (1) duplicate subscriptions \u2014 prevent the same customer subscribing twice per product; (2) cleanup \u2014 remove subscriptions after notification is sent; (3) inventory webhook accuracy \u2014 only notify when quantity transitions from 0 to >0, not on every update; (4) merchant UX \u2014 show subscriber count per product, bulk unsubscribe options, and resend capability; (5) email deliverability \u2014 use Shopify's transactional email or a simple HTML template, never third-party email APIs."
}
```

## Architect Plan

```json
{
  "shopifyPlan": {
    "webhookTopics": [
      "inventory_levels/update"
    ],
    "cronSchedule": null
  },
  "appContracts": {
    "feasibility": "feasible",
    "blockedReason": null,
    "complexity": "high",
    "edgeCases": [
      "Duplicate subscriptions \u2014 same customer+variant combination submitted twice (e.g. double-tap, page refresh); the unique constraint plus an upsert-safe insert must prevent double rows",
      "Inventory webhook fires multiple times in rapid succession for the same inventory_item_id/location_id while quantity stays above zero \u2014 only the first transition from zero to positive should trigger notifications",
      "A customer subscribes to a variant that is already in stock at subscription time \u2014 the widget must check live availability and block or immediately warn rather than creating a subscription that will never fire",
      "A subscribed variant is deleted or product is archived before the inventory comes back \u2014 notification job must skip gracefully when the Shopify product/variant fetch returns a not-found or unavailable status",
      "Guest (non-logged-in) subscriber provides an email that matches an existing Shopify customer \u2014 treat as a distinct guest subscription row; do not conflate with the authenticated customer record",
      "Merchant triggers a resend for a subscriber that has already been notified and the subscription cleaned up \u2014 the resend route must reconstruct the email context from the notification log without requiring an active subscription row"
    ],
    "uxExpectations": {
      "storefront": "Widget should feel frictionless \u2014 a single email input (pre-filled for logged-in customers) with a clear 'Notify Me' call-to-action, shown only when the variant is out of stock. Confirm subscription inline without a page reload, and show a friendly 'You're already subscribed' message on duplicate attempts.",
      "admin": "Dashboard should prioritize actionability: show subscriber count per product/variant at a glance, allow bulk unsubscribe, and surface a notification log with per-email resend capability. Merchants should be able to identify which products have the most demand pent up and which notifications failed."
    },
    "stateMachine": {
      "entity": "inventory_level",
      "trackedField": "stock_status",
      "unknownSentinel": "null",
      "skipWhenUnknown": true,
      "transitions": [
        {
          "from": "out_of_stock",
          "to": "in_stock",
          "action": "send_back_in_stock_notifications"
        }
      ]
    },
    "platformGaps": [
      {
        "gap": "No batch notification API \u2014 each subscriber requires an individual email send call",
        "mitigation": "Pre-fetch all active subscriptions and product/variant data for the affected inventory item before the loop; send emails per-subscriber inside the loop using ctx.services.email.send, then bulk-update subscription rows to notified status in a single SQL statement after the loop completes"
      },
      {
        "gap": "Shopify inventory_levels/update webhook does not include variant or product IDs directly \u2014 only inventory_item_id and location_id are present",
        "mitigation": "Use ctx.shopify.get with the inventory_item_id to resolve the associated variant_id and product_id before querying subscriptions; cache the resolved mapping in the DB inventory_item_map table to reduce redundant API calls on repeated webhook fires"
      }
    ],
    "handlerCapabilities": [
      "shopify_rest",
      "email"
    ],
    "emailSpec": {
      "type": "transactional",
      "purpose": "Fires when a subscribed product variant transitions from out-of-stock to in-stock, notifying the customer that the item they requested is now available with a direct link to the product page"
    },
    "cronBatching": null,
    "dbContracts": [
      {
        "table": "back_in_stock_subscriptions",
        "columns": [
          {
            "name": "id",
            "type": "UUID",
            "constraints": "PRIMARY KEY DEFAULT gen_random_uuid()"
          },
          {
            "name": "tenant_id",
            "type": "UUID",
            "constraints": "NOT NULL"
          },
          {
            "name": "variant_id",
            "type": "BIGINT",
            "constraints": "NOT NULL"
          },
          {
            "name": "product_id",
            "type": "BIGINT",
            "constraints": "NOT NULL"
          },
          {
            "name": "customer_id",
            "type": "BIGINT",
            "constraints": "NULL"
          },
          {
            "name": "email",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "product_title",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "variant_title",
            "type": "TEXT",
            "constraints": "NULL"
          },
          {
            "name": "product_image_url",
            "type": "TEXT",
            "constraints": "NULL"
          },
          {
            "name": "product_url",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "is_active",
            "type": "BOOLEAN",
            "constraints": "NOT NULL DEFAULT true"
          },
          {
            "name": "created_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NOT NULL DEFAULT now()"
          }
        ],
        "uniqueConstraint": {
          "columns": [
            "tenant_id",
            "variant_id",
            "email"
          ]
        },
        "indexes": [
          "tenant_id",
          "variant_id",
          "email",
          "is_active"
        ],
        "rls": true
      },
      {
        "table": "notification_logs",
        "columns": [
          {
            "name": "id",
            "type": "UUID",
            "constraints": "PRIMARY KEY DEFAULT gen_random_uuid()"
          },
          {
            "name": "tenant_id",
            "type": "UUID",
            "constraints": "NOT NULL"
          },
          {
            "name": "subscription_id",
            "type": "UUID",
            "constraints": "NOT NULL REFERENCES back_in_stock_subscriptions(id) ON DELETE CASCADE"
          },
          {
            "name": "variant_id",
            "type": "BIGINT",
            "constraints": "NOT NULL"
          },
          {
            "name": "product_id",
            "type": "BIGINT",
            "constraints": "NOT NULL"
          },
          {
            "name": "email",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "product_title",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "variant_title",
            "type": "TEXT",
            "constraints": "NULL"
          },
          {
            "name": "product_url",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "status",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT 'sent'"
          },
          {
            "name": "sent_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NOT NULL DEFAULT now()"
          }
        ],
        "uniqueConstraint": null,
        "indexes": [
          "tenant_id",
          "subscription_id",
          "variant_id",
          "email"
        ],
        "rls": true
      },
      {
        "table": "inventory_item_map",
        "columns": [
          {
            "name": "id",
            "type": "UUID",
            "constraints": "PRIMARY KEY DEFAULT gen_random_uuid()"
          },
          {
            "name": "tenant_id",
            "type": "UUID",
            "constraints": "NOT NULL"
          },
          {
            "name": "inventory_item_id",
            "type": "BIGINT",
            "constraints": "NOT NULL"
          },
          {
            "name": "variant_id",
            "type": "BIGINT",
            "constraints": "NOT NULL"
          },
          {
            "name": "product_id",
            "type": "BIGINT",
            "constraints": "NOT NULL"
          },
          {
            "name": "stock_status",
            "type": "TEXT",
            "constraints": "NULL"
          },
          {
            "name": "updated_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NOT NULL DEFAULT now()"
          }
        ],
        "uniqueConstraint": {
          "columns": [
            "tenant_id",
            "inventory_item_id"
          ]
        },
        "indexes": [
          "tenant_id",
          "inventory_item_id"
        ],
        "rls": true
      }
    ],
    "webhookContract": {
      "payloadFields": [
        "inventory_item_id",
        "location_id",
        "available"
      ],
      "handlerMustProduce": "Using inventory_item_id, resolve variant_id and product_id by checking the inventory_item_map table first; if not cached, fetch the variant record from Shopify REST using the inventory_item_id. Derive the current stock_status as 'in_stock' when available quantity is greater than zero, or 'out_of_stock' when zero or negative. Compare derived stock_status against the previously stored stock_status in inventory_item_map (null sentinel means first observation \u2014 skip). Only when the transition is from 'out_of_stock' to 'in_stock': fetch all active subscriptions for the resolved variant_id under this tenant, and for each subscriber resolve their display name (from customer_id if present, otherwise derive from email), the full product title, variant title, and product storefront URL to populate the notification email. After sending emails, mark subscriptions as inactive (is_active = false) and insert notification_log rows in bulk."
    },
    "cronContract": null,
    "widgetTargetTemplates": [
      "product"
    ],
    "widgetApiCatalog": [
      {
        "path": "/subscribe",
        "method": "POST",
        "requestShape": {
          "variant_id": "number",
          "product_id": "number",
          "email": "string",
          "customer_id": "number | null"
        },
        "responseShape": {
          "success": "boolean",
          "already_subscribed": "boolean",
          "message": "string"
        }
      },
      {
        "path": "/subscription/status",
        "method": "POST",
        "requestShape": {
          "variant_id": "number",
          "email": "string"
        },
        "responseShape": {
          "is_subscribed": "boolean"
        }
      },
      {
        "path": "/unsubscribe",
        "method": "POST",
        "requestShape": {
          "variant_id": "number",
          "email": "string"
        },
        "responseShape": {
          "success": "boolean"
        }
      }
    ],
    "widgetCapabilities": [],
    "adminApiCatalog": [
      {
        "path": "/admin/subscribers",
        "method": "GET",
        "requestShape": {
          "page": "number",
          "page_size": "number",
          "product_id": "number | null",
          "variant_id": "number | null",
          "is_active": "boolean | null"
        },
        "responseShape": {
          "items": [
            {
              "id": "string",
              "email": "string",
              "customer_id": "number | null",
              "product_id": "number",
              "variant_id": "number",
              "product_title": "string",
              "variant_title": "string | null",
              "product_url": "string",
              "is_active": "boolean",
              "created_at": "string"
            }
          ],
          "total": "number",
          "page": "number",
          "page_size": "number"
        }
      },
      {
        "path": "/admin/subscribers/bulk-unsubscribe",
        "method": "POST",
        "requestShape": {
          "subscription_ids": "string[]"
        },
        "responseShape": {
          "unsubscribed_count": "number"
        }
      },
      {
        "path": "/admin/products/subscriber-counts",
        "method": "GET",
        "requestShape": {
          "page": "number",
          "page_size": "number"
        },
        "responseShape": {
          "items": [
            {
              "product_id": "number",
              "product_title": "string",
              "active_subscriber_count": "number",
              "variant_breakdown": [
                {
                  "variant_id": "number",
                  "variant_title": "string | null",
                  "active_subscriber_count": "number"
                }
              ]
            }
          ],
          "total": "number",
          "page": "number",
          "page_size": "number"
        }
      },
      {
        "path": "/admin/notification-logs",
        "method": "GET",
        "requestShape": {
          "page": "number",
          "page_size": "number",
          "product_id": "number | null",
          "variant_id": "number | null",
          "email": "string | null"
        },
        "responseShape": {
          "items": [
            {
              "id": "string",
              "subscription_id": "string",
              "email": "string",
              "product_id": "number",
              "variant_id": "number",
              "product_title": "string",
              "variant_title": "string | null",
              "product_url": "string",
              "status": "string",
              "sent_at": "string"
            }
          ],
          "total": "number",
          "page": "number",
          "page_size": "number"
        }
      },
      {
        "path": "/admin/notification-logs/resend",
        "method": "POST",
        "requestShape": {
          "notification_log_id": "string"
        },
        "responseShape": {
          "success": "boolean",
          "message": "string"
        }
      }
    ],
    "adminCapabilities": []
  }
}
```

## Validation Retries (resolved)

### Attempt 1
- **widget_js**: direct document.* access is not allowed — use container.querySelector() and container.appendChild() instead. For styles: const s = document.createElement('style'); s.textContent = '...'; container.appendChild(s) — never document.head.

## Validator + Revision

**Final outcome:** `resolved`  
**Validator issues:** 2  
**Revision attempts:** 1

**Issues raised by validator:**

- *open_review[admin_ui]*: [loadOverview() — totalSubs accumulation loop: `items.forEach(item => { totalSubs += item.active_subscriber_count; })`] totalSubs is computed by summing active_subscriber_count only for the items on the currently loaded page, not across all products. The value is written to statSubscribers, which is labelled 'Total Active Subscribers'. — When the product list spans more than one page (overviewTotal > PAGE_SIZE), navigating to page 2+ causes the stat to display only the partial sum for that page. On page 1 the displayed total is also wrong unless all products fit on the first page. The correct total would require either a separate aggregate API call or a sum returned alongside the paginated response.
- *open_review[handler]*: [/subscribe handler — product fetch try/catch block; productUrl and productTitle left as empty strings on failure] When the product fetch fails (caught exception sets productData = null), productTitle = '' and productUrl = ''. The INSERT then stores product_url = '' in back_in_stock_subscriptions, where the column is NOT NULL but not constrained to non-empty. The subscription is created silently with no product URL. — Notification emails sent later for that subscription will contain a broken (empty) product URL in the email body, and product_title in notification_logs will also be empty, making the log unreadable. The handler does not return an error to the user, so the subscriber has no indication anything went wrong.

- Attempt 1: 224205ms · in=25653 out=20372 · returned=['admin_ui', 'handler', 'widget_js'] · outcome=`accepted`

**Full trace:** [revision_traces/2026-04-18T14-35-04_customers-receive-backinstock-alerts-and-merchants.json](revision_traces/2026-04-18T14-35-04_customers-receive-backinstock-alerts-and-merchants.json)

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: ['inventory_levels/update'],
  cronSchedule: null,
  npmPackages: [],
  handler: async function(ctx) {
    try {
      // ── WIDGET ──────────────────────────────────────────────────────────────
      if (ctx.trigger === 'widget') {
        ctx.logger.info({ trigger: ctx.trigger, path: ctx.widgetPath }, 'widget invoke');

        // POST /subscribe
        if (ctx.widgetPath === '/subscribe') {
          const { variant_id, product_id, email, customer_id } = ctx.widgetBody || {};
          if (!variant_id || !product_id || !email) {
            return { success: false, already_subscribed: false, message: 'Missing required fields: variant_id, product_id, email' };
          }

          // Check if already subscribed (active)
          const existing = await ctx.db`
            SELECT id FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variant_id}
              AND email = ${email}
              AND is_active = true
            LIMIT 1
          `;
          if (existing.length > 0) {
            return { success: true, already_subscribed: true, message: 'You are already subscribed for this product.' };
          }

          // Fetch variant from Shopify to check current stock and resolve titles
          let variantData = null;
          try {
            const variantRes = await ctx.shopify.get(`/variants/${variant_id}.json`);
            variantData = variantRes && variantRes.variant ? variantRes.variant : null;
          } catch (e) {
            ctx.logger.warn({ variant_id, err: e.message }, 'subscribe: variant fetch failed');
            return { success: false, already_subscribed: false, message: 'Could not verify product availability. Please try again.' };
          }

          if (!variantData) {
            return { success: false, already_subscribed: false, message: 'Product variant not found.' };
          }

          // Check if already in stock
          if (variantData.inventory_quantity > 0 && variantData.inventory_management !== null) {
            return { success: false, already_subscribed: false, message: 'This product is currently in stock! No need to subscribe.' };
          }

          // Fetch product for title and URL
          let productData = null;
          let variantTitle = variantData.title || null;
          let productImageUrl = '';

          try {
            const productRes = await ctx.shopify.get(`/products/${product_id}.json?fields=id,title,handle,images`);
            productData = productRes && productRes.product ? productRes.product : null;
          } catch (e) {
            ctx.logger.warn({ product_id, err: e.message }, 'subscribe: product fetch failed');
            return { success: false, already_subscribed: false, message: 'Could not load product information. Please try again.' };
          }

          if (!productData) {
            return { success: false, already_subscribed: false, message: 'Product not found. Please try again.' };
          }

          const productTitle = productData.title || '';
          const productUrl = `https://${ctx.shop.domain}/products/${productData.handle}`;
          if (productData.images && productData.images.length > 0) {
            productImageUrl = productData.images[0].src || '';
          }

          // Insert subscription — ON CONFLICT on (tenant_id, variant_id, email) to handle replay
          await ctx.db`
            INSERT INTO back_in_stock_subscriptions
              (tenant_id, variant_id, product_id, customer_id, email, product_title, variant_title, product_image_url, product_url, is_active, created_at)
            VALUES
              (${ctx.tenantId}, ${variant_id}, ${product_id}, ${customer_id || null}, ${email},
               ${productTitle}, ${variantTitle}, ${productImageUrl}, ${productUrl}, true, NOW())
            ON CONFLICT (tenant_id, variant_id, email) DO UPDATE
              SET is_active = true,
                  product_title = EXCLUDED.product_title,
                  variant_title = EXCLUDED.variant_title,
                  product_url = EXCLUDED.product_url,
                  product_image_url = EXCLUDED.product_image_url,
                  customer_id = COALESCE(EXCLUDED.customer_id, back_in_stock_subscriptions.customer_id)
          `;

          ctx.logger.info({ variant_id, email }, 'subscribe: subscription created/reactivated');
          return { success: true, already_subscribed: false, message: 'You will be notified when this product is back in stock.' };
        }

        // POST /subscription/status
        if (ctx.widgetPath === '/subscription/status') {
          const { variant_id, email } = ctx.widgetBody || {};
          if (!variant_id || !email) {
            return { is_subscribed: false };
          }
          const rows = await ctx.db`
            SELECT id FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variant_id}
              AND email = ${email}
              AND is_active = true
            LIMIT 1
          `;
          return { is_subscribed: rows.length > 0 };
        }

        // POST /unsubscribe
        if (ctx.widgetPath === '/unsubscribe') {
          const { variant_id, email } = ctx.widgetBody || {};
          if (!variant_id || !email) {
            return { success: false };
          }
          await ctx.db`
            UPDATE back_in_stock_subscriptions
            SET is_active = false
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variant_id}
              AND email = ${email}
              AND is_active = true
          `;
          return { success: true };
        }

        ctx.logger.warn({ path: ctx.widgetPath }, 'widget: unknown path');
        return { error: 'unknown path' };
      }

      // ── ADMIN ───────────────────────────────────────────────────────────────
      if (ctx.trigger === 'admin') {
        ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

        // GET /admin/subscribers
        if (ctx.adminPath === '/admin/subscribers') {
          const { page = 1, page_size = 20, product_id = null, variant_id = null, is_active = null } = ctx.adminBody || {};
          const offset = (page - 1) * page_size;

          const rows = await ctx.db`
            SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title,
                   product_url, is_active, created_at
            FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              ${product_id != null ? ctx.db`AND product_id = ${product_id}` : ctx.db``}
              ${variant_id != null ? ctx.db`AND variant_id = ${variant_id}` : ctx.db``}
              ${is_active != null ? ctx.db`AND is_active = ${is_active}` : ctx.db``}
            ORDER BY created_at DESC
            LIMIT ${page_size} OFFSET ${offset}
          `;

          const countRows = await ctx.db`
            SELECT COUNT(*) AS total
            FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              ${product_id != null ? ctx.db`AND product_id = ${product_id}` : ctx.db``}
              ${variant_id != null ? ctx.db`AND variant_id = ${variant_id}` : ctx.db``}
              ${is_active != null ? ctx.db`AND is_active = ${is_active}` : ctx.db``}
          `;

          const total = parseInt(countRows[0].total, 10);
          const items = rows.map(r => ({
            id: String(r.id),
            email: r.email,
            customer_id: r.customer_id ? Number(r.customer_id) : null,
            product_id: Number(r.product_id),
            variant_id: Number(r.variant_id),
            product_title: r.product_title || '',
            variant_title: r.variant_title || null,
            product_url: r.product_url || '',
            is_active: r.is_active,
            created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
          }));

          return { items, total, page: Number(page), page_size: Number(page_size) };
        }

        // POST /admin/subscribers/bulk-unsubscribe
        if (ctx.adminPath === '/admin/subscribers/bulk-unsubscribe') {
          const { subscription_ids } = ctx.adminBody || {};
          if (!subscription_ids || subscription_ids.length === 0) {
            return { unsubscribed_count: 0 };
          }
          const result = await ctx.db`
            UPDATE back_in_stock_subscriptions
            SET is_active = false
            WHERE tenant_id = ${ctx.tenantId}
              AND id = ANY(${subscription_ids})
              AND is_active = true
            RETURNING id
          `;
          ctx.logger.info({ count: result.length }, 'admin: bulk-unsubscribe');
          return { unsubscribed_count: result.length };
        }

        // GET /admin/products/subscriber-counts
        if (ctx.adminPath === '/admin/products/subscriber-counts') {
          const { page = 1, page_size = 20 } = ctx.adminBody || {};
          const offset = (page - 1) * page_size;

          const productRows = await ctx.db`
            SELECT product_id, product_title, COUNT(*) AS active_subscriber_count
            FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND is_active = true
            GROUP BY product_id, product_title
            ORDER BY active_subscriber_count DESC
            LIMIT ${page_size} OFFSET ${offset}
          `;

          const countRows = await ctx.db`
            SELECT COUNT(DISTINCT product_id) AS total
            FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND is_active = true
          `;
          const total = parseInt(countRows[0].total, 10);

          if (productRows.length === 0) {
            return { items: [], total, page: Number(page), page_size: Number(page_size) };
          }

          const productIds = productRows.map(r => r.product_id);

          const variantRows = await ctx.db`
            SELECT product_id, variant_id, variant_title, COUNT(*) AS active_subscriber_count
            FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND is_active = true
              AND product_id = ANY(${productIds})
            GROUP BY product_id, variant_id, variant_title
            ORDER BY product_id, active_subscriber_count DESC
          `;

          const variantMap = {};
          for (const vr of variantRows) {
            const pid = String(vr.product_id);
            if (!variantMap[pid]) variantMap[pid] = [];
            variantMap[pid].push({
              variant_id: Number(vr.variant_id),
              variant_title: vr.variant_title || null,
              active_subscriber_count: parseInt(vr.active_subscriber_count, 10),
            });
          }

          const items = productRows.map(r => ({
            product_id: Number(r.product_id),
            product_title: r.product_title || '',
            active_subscriber_count: parseInt(r.active_subscriber_count, 10),
            variant_breakdown: variantMap[String(r.product_id)] || [],
          }));

          return { items, total, page: Number(page), page_size: Number(page_size) };
        }

        // GET /admin/notification-logs
        if (ctx.adminPath === '/admin/notification-logs') {
          const { page = 1, page_size = 20, product_id = null, variant_id = null, email = null } = ctx.adminBody || {};
          const offset = (page - 1) * page_size;

          const rows = await ctx.db`
            SELECT id, subscription_id, email, product_id, variant_id,
                   product_title, variant_title, product_url, status, sent_at
            FROM notification_logs
            WHERE tenant_id = ${ctx.tenantId}
              ${product_id != null ? ctx.db`AND product_id = ${product_id}` : ctx.db``}
              ${variant_id != null ? ctx.db`AND variant_id = ${variant_id}` : ctx.db``}
              ${email != null ? ctx.db`AND email = ${email}` : ctx.db``}
            ORDER BY sent_at DESC
            LIMIT ${page_size} OFFSET ${offset}
          `;

          const countRows = await ctx.db`
            SELECT COUNT(*) AS total
            FROM notification_logs
            WHERE tenant_id = ${ctx.tenantId}
              ${product_id != null ? ctx.db`AND product_id = ${product_id}` : ctx.db``}
              ${variant_id != null ? ctx.db`AND variant_id = ${variant_id}` : ctx.db``}
              ${email != null ? ctx.db`AND email = ${email}` : ctx.db``}
          `;

          const total = parseInt(countRows[0].total, 10);
          const items = rows.map(r => ({
            id: String(r.id),
            subscription_id: String(r.subscription_id),
            email: r.email,
            product_id: Number(r.product_id),
            variant_id: Number(r.variant_id),
            product_title: r.product_title || '',
            variant_title: r.variant_title || null,
            product_url: r.product_url || '',
            status: r.status,
            sent_at: r.sent_at instanceof Date ? r.sent_at.toISOString() : String(r.sent_at),
          }));

          return { items, total, page: Number(page), page_size: Number(page_size) };
        }

        // POST /admin/notification-logs/resend
        if (ctx.adminPath === '/admin/notification-logs/resend') {
          const { notification_log_id } = ctx.adminBody || {};
          if (!notification_log_id) {
            return { success: false, message: 'Missing notification_log_id' };
          }

          const logRows = await ctx.db`
            SELECT id, subscription_id, email, product_id, variant_id,
                   product_title, variant_title, product_url, status
            FROM notification_logs
            WHERE tenant_id = ${ctx.tenantId}
              AND id = ${notification_log_id}
            LIMIT 1
          `;

          if (logRows.length === 0) {
            return { success: false, message: 'Notification log not found.' };
          }

          const log = logRows[0];

          try {
            await ctx.services.email.send({
              to: log.email,
              data: {
                customerName: log.email,
                productTitle: log.product_title || '',
                variantTitle: log.variant_title || null,
                productUrl: log.product_url || '',
              },
            });
          } catch (e) {
            ctx.logger.error({ notification_log_id, err: e.message }, 'admin: resend email failed');
            return { success: false, message: 'Failed to resend notification email.' };
          }

          await ctx.db`
            INSERT INTO notification_logs
              (tenant_id, subscription_id, variant_id, product_id, email, product_title,
               variant_title, product_url, status, sent_at)
            VALUES
              (${ctx.tenantId}, ${log.subscription_id}, ${log.variant_id}, ${log.product_id},
               ${log.email}, ${log.product_title}, ${log.variant_title}, ${log.product_url},
               'resent', NOW())
          `;

          ctx.logger.info({ notification_log_id, email: log.email }, 'admin: resend notification sent');
          return { success: true, message: 'Notification resent successfully.' };
        }

        ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
        return { error: 'unknown path' };
      }

      // ── WEBHOOK: inventory_levels/update ────────────────────────────────────
      if (ctx.trigger === 'webhook') {
        const { inventory_item_id, location_id, available } = ctx.payload;
        ctx.logger.info({ inventory_item_id, location_id, available }, 'webhook: inventory_levels/update received');

        if (inventory_item_id == null) {
          ctx.logger.warn({}, 'webhook: missing inventory_item_id — skipping');
          return;
        }

        const newStockStatus = (available != null && available > 0) ? 'in_stock' : 'out_of_stock';

        const cached = await ctx.db`
          SELECT id, variant_id, product_id, stock_status
          FROM inventory_item_map
          WHERE tenant_id = ${ctx.tenantId}
            AND inventory_item_id = ${inventory_item_id}
          LIMIT 1
        `;

        let variantId = null;
        let productId = null;
        let prevStockStatus = null;

        if (cached.length > 0) {
          variantId = cached[0].variant_id;
          productId = cached[0].product_id;
          prevStockStatus = cached[0].stock_status;
          ctx.logger.info({ variantId, productId, prevStockStatus, newStockStatus }, 'webhook: resolved from cache');
        } else {
          let variantRes = null;
          try {
            variantRes = await ctx.shopify.get(`/variants.json?inventory_item_ids=${inventory_item_id}&limit=1`);
          } catch (e) {
            ctx.logger.error({ inventory_item_id, err: e.message }, 'webhook: variant lookup failed');
            return;
          }

          const variants = variantRes && variantRes.variants ? variantRes.variants : [];
          if (variants.length === 0) {
            ctx.logger.warn({ inventory_item_id }, 'webhook: no variant found for inventory_item_id — skipping');
            return;
          }

          variantId = variants[0].id;
          productId = variants[0].product_id;
          prevStockStatus = null;
          ctx.logger.info({ variantId, productId }, 'webhook: resolved from Shopify API');
        }

        await ctx.db`
          INSERT INTO inventory_item_map
            (tenant_id, inventory_item_id, variant_id, product_id, stock_status, updated_at)
          VALUES
            (${ctx.tenantId}, ${inventory_item_id}, ${variantId}, ${productId}, ${newStockStatus}, NOW())
          ON CONFLICT (tenant_id, inventory_item_id) DO UPDATE
            SET stock_status = EXCLUDED.stock_status,
                updated_at = NOW()
        `;

        if (prevStockStatus === null) {
          ctx.logger.info({ inventory_item_id }, 'webhook: first observation — baseline set, skipping notification');
          return;
        }

        if (prevStockStatus !== 'out_of_stock' || newStockStatus !== 'in_stock') {
          ctx.logger.info({ prevStockStatus, newStockStatus }, 'webhook: no transition to notify — skipping');
          return;
        }

        ctx.logger.info({ variantId, productId, prevStockStatus, newStockStatus }, 'webhook: out_of_stock → in_stock transition detected');

        const subscriptions = await ctx.db`
          SELECT id, email, customer_id, product_title, variant_title, product_url, product_id, variant_id
          FROM back_in_stock_subscriptions
          WHERE tenant_id = ${ctx.tenantId}
            AND variant_id = ${variantId}
            AND is_active = true
        `;

        if (subscriptions.length === 0) {
          ctx.logger.info({ variantId }, 'webhook: no active subscriptions — nothing to notify');
          return;
        }

        ctx.logger.info({ variantId, count: subscriptions.length }, 'webhook: found active subscriptions to notify');

        let resolvedProductTitle = '';
        let resolvedVariantTitle = '';
        let resolvedProductUrl = '';

        try {
          const productRes = await ctx.shopify.get(`/products/${productId}.json?fields=id,title,handle,status,variants`);
          const product = productRes && productRes.product ? productRes.product : null;

          if (!product || product.status === 'archived' || product.status === 'draft') {
            ctx.logger.warn({ productId, status: product ? product.status : 'not_found' }, 'webhook: product archived/deleted — skipping notifications');
            return;
          }

          resolvedProductTitle = product.title || '';
          resolvedProductUrl = `https://${ctx.shop.domain}/products/${product.handle}`;

          const matchingVariant = product.variants ? product.variants.find(v => String(v.id) === String(variantId)) : null;
          if (!matchingVariant) {
            ctx.logger.warn({ productId, variantId }, 'webhook: variant not found on product — skipping notifications');
            return;
          }
          resolvedVariantTitle = matchingVariant.title || '';
        } catch (e) {
          ctx.logger.error({ productId, variantId, err: e.message }, 'webhook: product/variant fetch failed — skipping notifications');
          return;
        }

        const subIds = subscriptions.map(s => s.id);
        const claimed = await ctx.db`
          UPDATE back_in_stock_subscriptions
          SET is_active = false
          WHERE tenant_id = ${ctx.tenantId}
            AND id = ANY(${subIds})
            AND is_active = true
          RETURNING id, email, customer_id, product_title, variant_title, product_url
        `;

        if (claimed.length === 0) {
          ctx.logger.info({ variantId }, 'webhook: all subscriptions already claimed by prior execution — skipping');
          return;
        }

        ctx.logger.info({ claimedCount: claimed.length, variantId }, 'webhook: claimed subscriptions for notification');

        const notificationLogInserts = [];
        for (const sub of claimed) {
          const customerName = sub.email;
          const productTitle = resolvedProductTitle || sub.product_title || '';
          const variantTitle = resolvedVariantTitle || sub.variant_title || '';
          const productUrl = resolvedProductUrl || sub.product_url || '';

          try {
            await ctx.services.email.send({
              to: sub.email,
              data: {
                customerName,
                productTitle,
                variantTitle,
                productUrl,
              },
            });
            notificationLogInserts.push({
              subscriptionId: sub.id,
              email: sub.email,
              productTitle,
              variantTitle,
              productUrl,
              status: 'sent',
            });
          } catch (e) {
            ctx.logger.error({ email: sub.email, err: e.message }, 'webhook: email send failed');
            notificationLogInserts.push({
              subscriptionId: sub.id,
              email: sub.email,
              productTitle,
              variantTitle,
              productUrl,
              status: 'failed',
            });
          }
        }

        if (notificationLogInserts.length > 0) {
          for (const logEntry of notificationLogInserts) {
            await ctx.db`
              INSERT INTO notification_logs
                (tenant_id, subscription_id, variant_id, product_id, email,
                 product_title, variant_title, product_url, status, sent_at)
              VALUES
                (${ctx.tenantId}, ${logEntry.subscriptionId}, ${variantId}, ${productId},
                 ${logEntry.email}, ${logEntry.productTitle}, ${logEntry.variantTitle},
                 ${logEntry.productUrl}, ${logEntry.status}, NOW())
            `;
          }
          ctx.logger.info({ inserted: notificationLogInserts.length }, 'webhook: notification logs inserted');
        }

        return;
      }

    } catch (err) {
      ctx.logger.error({ err: err.message, stack: err.stack }, 'handler: unhandled error');
    }
  }
};
```

### handler email metadata (sidecar)

```json
{
  "variables": [
    "customerName",
    "productTitle",
    "variantTitle",
    "productUrl"
  ],
  "starterContent": {
    "subject": "{{productTitle}} is back in stock!",
    "heading": "Great news, {{customerName}}!",
    "body": "The item you were waiting for \u2014 {{productTitle}} ({{variantTitle}}) \u2014 is back in stock. Grab it before it sells out again!",
    "ctaLabel": "Shop Now",
    "ctaUrl": "{{productUrl}}"
  }
}
```

### migration.sql

```sql
CREATE TABLE back_in_stock_subscriptions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL,
  variant_id        BIGINT      NOT NULL,
  product_id        BIGINT      NOT NULL,
  customer_id       BIGINT      NULL,
  email             TEXT        NOT NULL,
  product_title     TEXT        NOT NULL,
  variant_title     TEXT        NULL,
  product_image_url TEXT        NULL,
  product_url       TEXT        NOT NULL,
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, variant_id, email)
);

ALTER TABLE back_in_stock_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY back_in_stock_subscriptions_tenant_isolation ON back_in_stock_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX back_in_stock_subscriptions_tenant_id_idx
  ON back_in_stock_subscriptions (tenant_id);

CREATE INDEX back_in_stock_subscriptions_tenant_id_variant_id_idx
  ON back_in_stock_subscriptions (tenant_id, variant_id);

CREATE INDEX back_in_stock_subscriptions_tenant_id_email_idx
  ON back_in_stock_subscriptions (tenant_id, email);

CREATE INDEX back_in_stock_subscriptions_tenant_id_is_active_idx
  ON back_in_stock_subscriptions (tenant_id, is_active);


CREATE TABLE notification_logs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
  subscription_id UUID        NOT NULL REFERENCES back_in_stock_subscriptions(id) ON DELETE CASCADE,
  variant_id      BIGINT      NOT NULL,
  product_id      BIGINT      NOT NULL,
  email           TEXT        NOT NULL,
  product_title   TEXT        NOT NULL,
  variant_title   TEXT        NULL,
  product_url     TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'sent',
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_logs_tenant_isolation ON notification_logs
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX notification_logs_tenant_id_idx
  ON notification_logs (tenant_id);

CREATE INDEX notification_logs_tenant_id_subscription_id_idx
  ON notification_logs (tenant_id, subscription_id);

CREATE INDEX notification_logs_tenant_id_variant_id_idx
  ON notification_logs (tenant_id, variant_id);

CREATE INDEX notification_logs_tenant_id_email_idx
  ON notification_logs (tenant_id, email);


CREATE TABLE inventory_item_map (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL,
  inventory_item_id  BIGINT      NOT NULL,
  variant_id         BIGINT      NOT NULL,
  product_id         BIGINT      NOT NULL,
  stock_status       TEXT        NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, inventory_item_id)
);

ALTER TABLE inventory_item_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_item_map_tenant_isolation ON inventory_item_map
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX inventory_item_map_tenant_id_idx
  ON inventory_item_map (tenant_id);

CREATE INDEX inventory_item_map_tenant_id_inventory_item_id_idx
  ON inventory_item_map (tenant_id, inventory_item_id);
```

### widget.js

```javascript
export function mount(container, host) {
  const style = document.createElement('style');
  style.textContent = `
    .bis-widget { font-family: inherit; padding: 12px 0; }
    .bis-widget h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; color: #333; }
    .bis-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .bis-input { flex: 1 1 200px; padding: 10px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; outline: none; transition: border-color 0.2s; }
    .bis-input:focus { border-color: #111; }
    .bis-btn { padding: 10px 18px; background: #111; color: #fff; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; white-space: nowrap; transition: background 0.2s; }
    .bis-btn:hover:not(:disabled) { background: #333; }
    .bis-btn:disabled { background: #888; cursor: not-allowed; }
    .bis-msg { margin-top: 8px; font-size: 13px; padding: 8px 12px; border-radius: 4px; display: none; }
    .bis-msg.success { background: #e6f4ea; color: #2d6a4f; display: block; }
    .bis-msg.error { background: #fdecea; color: #c0392b; display: block; }
    .bis-msg.info { background: #e8f0fe; color: #1a56db; display: block; }
    .bis-unsub-link { display: inline-block; margin-top: 6px; font-size: 12px; color: #888; cursor: pointer; text-decoration: underline; background: none; border: none; padding: 0; }
  `;
  container.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.className = 'bis-widget';
  container.appendChild(wrapper);

  let currentVariantId = null;
  let currentProductId = null;
  let currentEmail = '';

  function getVariantAndProduct() {
    const variantInput = container.querySelector('[name="id"]') ||
      container.querySelector('[data-variant-id]') ||
      container.querySelector('input[name="id"]');
    const vid = variantInput
      ? parseInt(variantInput.value || variantInput.dataset.variantId, 10)
      : null;
    const pidEl = container.querySelector('[data-product-id]');
    const pid = pidEl ? parseInt(pidEl.dataset.productId, 10) : null;
    return { vid, pid };
  }

  function render(variantId, productId) {
    currentVariantId = variantId;
    currentProductId = productId;

    wrapper.innerHTML = '';

    const title = document.createElement('h3');
    title.textContent = 'Get notified when back in stock';
    wrapper.appendChild(title);

    const form = document.createElement('form');
    form.className = 'bis-form';

    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.name = 'email';
    emailInput.className = 'bis-input';
    emailInput.placeholder = 'Enter your email';
    emailInput.required = true;
    if (currentEmail) emailInput.value = currentEmail;

    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'bis-btn';
    btn.textContent = 'Notify Me';

    form.appendChild(emailInput);
    form.appendChild(btn);
    wrapper.appendChild(form);

    const msg = document.createElement('div');
    msg.className = 'bis-msg';
    wrapper.appendChild(msg);

    const unsubBtn = document.createElement('button');
    unsubBtn.className = 'bis-unsub-link';
    unsubBtn.textContent = 'Unsubscribe from this alert';
    unsubBtn.style.display = 'none';
    wrapper.appendChild(unsubBtn);

    function showMsg(text, type) {
      msg.textContent = text;
      msg.className = 'bis-msg ' + type;
    }

    function hideMsg() {
      msg.className = 'bis-msg';
      msg.textContent = '';
    }

    if (variantId && currentEmail) {
      host.call('/subscription/status', { variant_id: variantId, email: currentEmail })
        .then(res => {
          if (res && res.is_subscribed) {
            showMsg("You're already subscribed for this item.", 'info');
            unsubBtn.style.display = 'inline-block';
          }
        })
        .catch(() => {});
    }

    form.addEventListener('submit', function(e) {
      e.preventDefault();
      const email = emailInput.value.trim();
      if (!email) return;
      if (!currentVariantId) {
        showMsg('Please select a variant first.', 'error');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Subscribing\u2026';
      hideMsg();

      const customerId = host.context.customerId ? parseInt(host.context.customerId, 10) : null;

      host.call('/subscribe', {
        variant_id: currentVariantId,
        product_id: currentProductId,
        email: email,
        customer_id: customerId
      }).then(res => {
        btn.disabled = false;
        btn.textContent = 'Notify Me';
        if (res.already_subscribed) {
          showMsg("You're already subscribed for this item.", 'info');
          unsubBtn.style.display = 'inline-block';
        } else if (res.success) {
          showMsg("You're subscribed! We'll email you when it's back.", 'success');
          unsubBtn.style.display = 'inline-block';
          currentEmail = email;
        } else {
          showMsg(res.message || 'Something went wrong. Please try again.', 'error');
        }
      }).catch(() => {
        btn.disabled = false;
        btn.textContent = 'Notify Me';
        showMsg('Something went wrong. Please try again.', 'error');
      });
    });

    unsubBtn.addEventListener('click', function() {
      const email = emailInput.value.trim() || currentEmail;
      if (!email || !currentVariantId) return;
      unsubBtn.disabled = true;
      host.call('/unsubscribe', { variant_id: currentVariantId, email: email })
        .then(res => {
          unsubBtn.disabled = false;
          if (res && res.success) {
            showMsg('You have been unsubscribed.', 'info');
            unsubBtn.style.display = 'none';
          } else {
            showMsg('Could not unsubscribe. Please try again.', 'error');
          }
        })
        .catch(() => {
          unsubBtn.disabled = false;
          showMsg('Could not unsubscribe. Please try again.', 'error');
        });
    });
  }

  function init() {
    if (host.context && host.context.customerId) {
      currentEmail = '';
    }
    const { vid, pid } = getVariantAndProduct();
    render(vid, pid);
  }

  init();
}
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  const PAGE_SIZE = 20;

  const style = document.createElement('style');
  style.textContent = `
    .tab-bar { display: flex; gap: 0; border-bottom: 1px solid var(--p-color-border); margin-bottom: var(--p-space-400); }
    .tab-btn { background: none; border: none; border-bottom: 2px solid transparent; padding: var(--p-space-300) var(--p-space-500); font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text-secondary); cursor: pointer; margin-bottom: -1px; transition: color 0.15s, border-color 0.15s; }
    .tab-btn:hover { color: var(--p-color-text); }
    .tab-btn.active { color: var(--p-color-text); border-bottom-color: #008060; font-weight: var(--p-font-weight-semibold); }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .product-row { display: flex; align-items: center; justify-content: space-between; padding: var(--p-space-300) var(--p-space-400); border-bottom: 1px solid var(--p-color-border); gap: var(--p-space-400); }
    .product-row:last-child { border-bottom: none; }
    .product-info { flex: 1; min-width: 0; }
    .product-title { font-weight: var(--p-font-weight-semibold); font-size: var(--p-font-size-350); color: var(--p-color-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .variant-breakdown { margin-top: var(--p-space-100); display: flex; flex-wrap: wrap; gap: var(--p-space-100); }
    .variant-chip { background: var(--p-color-bg-surface-secondary); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-full); padding: 2px var(--p-space-200); font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); }
    .count-badge { background: #008060; color: #fff; border-radius: var(--p-border-radius-full); padding: var(--p-space-100) var(--p-space-300); font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-semibold); white-space: nowrap; }
    .filter-row { display: flex; gap: var(--p-space-300); flex-wrap: wrap; align-items: flex-end; margin-bottom: var(--p-space-400); }
    .filter-group { display: flex; flex-direction: column; gap: var(--p-space-100); }
    .filter-label { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); font-weight: var(--p-font-weight-medium); }
    .filter-input { padding: var(--p-space-200) var(--p-space-300); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); background: var(--p-color-bg-surface); color: var(--p-color-text); font-size: var(--p-font-size-350); min-width: 160px; }
    .filter-input:focus { outline: none; border-color: #008060; box-shadow: 0 0 0 2px rgba(0,128,96,0.18); }
    .select-col { width: 36px; text-align: center; }
    .bulk-bar { display: flex; align-items: center; gap: var(--p-space-300); padding: var(--p-space-200) var(--p-space-400); background: var(--p-color-bg-surface-secondary); border-radius: var(--p-border-radius-100); margin-bottom: var(--p-space-300); }
    .bulk-bar-text { font-size: var(--p-font-size-350); color: var(--p-color-text); flex: 1; }
    .log-status-sent { color: var(--p-color-text-success); font-weight: var(--p-font-weight-semibold); }
    .log-status-failed { color: var(--p-color-text-critical); font-weight: var(--p-font-weight-semibold); }
    .log-status-other { color: var(--p-color-text-secondary); }
    .demand-bar-wrap { width: 120px; background: var(--p-color-bg-surface-secondary); border-radius: var(--p-border-radius-full); height: 8px; overflow: hidden; }
    .demand-bar { height: 8px; border-radius: var(--p-border-radius-full); background: #008060; }
    .pagination-info { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); }
    .section-hdr { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--p-space-300); }
    .stat-pill { display: inline-flex; align-items: center; gap: var(--p-space-100); }
    .empty-state { padding: var(--p-space-800) var(--p-space-400); text-align: center; color: var(--p-color-text-secondary); font-size: var(--p-font-size-350); }
  `;

  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Back-in-Stock Alerts</span>
      </div>
      <div class="tab-bar">
        <button class="tab-btn active" data-tab="overview">Overview</button>
        <button class="tab-btn" data-tab="subscribers">Subscribers</button>
        <button class="tab-btn" data-tab="logs">Notification Logs</button>
      </div>

      <!-- OVERVIEW TAB -->
      <div class="tab-panel active" id="tab-overview">
        <div class="shell-stats-row" id="overview-stats">
          <div class="shell-stat-card"><div class="shell-stat-label">Total Products with Waitlist</div><div class="shell-stat-value" id="stat-products">—</div></div>
          <div class="shell-stat-card"><div class="shell-stat-label">Total Active Subscribers</div><div class="shell-stat-value" id="stat-subscribers">—</div></div>
        </div>
        <div class="shell-card" style="padding:0;overflow:hidden;">
          <div class="section-hdr" style="padding: var(--p-space-400) var(--p-space-400) var(--p-space-300);">
            <span class="shell-section-title" style="margin:0;">Products by Demand</span>
            <span class="pagination-info" id="overview-pagination-info"></span>
          </div>
          <div id="overview-loading" class="shell-loading"><div class="shell-spinner"></div></div>
          <div id="overview-error" class="shell-error-banner" style="display:none;"></div>
          <div id="overview-list"></div>
          <div class="shell-pagination" style="padding: var(--p-space-300) var(--p-space-400);">
            <span class="pagination-info" id="overview-page-label"></span>
            <div class="shell-pagination-btns">
              <button class="btn-secondary" id="overview-prev" disabled>Previous</button>
              <button class="btn-secondary" id="overview-next" disabled>Next</button>
            </div>
          </div>
        </div>
      </div>

      <!-- SUBSCRIBERS TAB -->
      <div class="tab-panel" id="tab-subscribers">
        <div class="shell-card" style="padding: var(--p-space-400);">
          <div class="filter-row">
            <div class="filter-group">
              <span class="filter-label">Status</span>
              <select class="filter-input" id="sub-filter-status">
                <option value="">All</option>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </div>
            <div class="filter-group">
              <span class="filter-label">Product ID</span>
              <input type="number" class="filter-input" id="sub-filter-product" placeholder="e.g. 123456" style="max-width:140px;" />
            </div>
            <div class="filter-group">
              <span class="filter-label">Variant ID</span>
              <input type="number" class="filter-input" id="sub-filter-variant" placeholder="e.g. 789012" style="max-width:140px;" />
            </div>
            <div class="filter-group" style="justify-content:flex-end;">
              <button class="btn-primary" id="sub-filter-apply">Apply Filters</button>
            </div>
          </div>
          <div id="sub-bulk-bar" class="bulk-bar" style="display:none;">
            <span class="bulk-bar-text" id="sub-bulk-text">0 selected</span>
            <button class="btn-danger" id="sub-bulk-unsub">Bulk Unsubscribe</button>
            <button class="btn-secondary" id="sub-bulk-clear">Clear Selection</button>
          </div>
          <div id="sub-loading" class="shell-loading"><div class="shell-spinner"></div></div>
          <div id="sub-error" class="shell-error-banner" style="display:none;"></div>
          <div id="sub-table-wrap" class="shell-table-wrap" style="display:none;">
            <table class="shell-table">
              <thead>
                <tr>
                  <th class="select-col"><input type="checkbox" id="sub-check-all" /></th>
                  <th>Email</th>
                  <th>Product</th>
                  <th>Variant</th>
                  <th>Status</th>
                  <th>Subscribed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="sub-tbody"></tbody>
            </table>
          </div>
          <div id="sub-empty" class="empty-state" style="display:none;">No subscribers found.</div>
          <div class="shell-pagination">
            <span class="pagination-info" id="sub-page-label"></span>
            <div class="shell-pagination-btns">
              <button class="btn-secondary" id="sub-prev" disabled>Previous</button>
              <button class="btn-secondary" id="sub-next" disabled>Next</button>
            </div>
          </div>
        </div>
      </div>

      <!-- LOGS TAB -->
      <div class="tab-panel" id="tab-logs">
        <div class="shell-card" style="padding: var(--p-space-400);">
          <div class="filter-row">
            <div class="filter-group">
              <span class="filter-label">Email</span>
              <input type="text" class="filter-input" id="log-filter-email" placeholder="customer@email.com" />
            </div>
            <div class="filter-group">
              <span class="filter-label">Product ID</span>
              <input type="number" class="filter-input" id="log-filter-product" placeholder="e.g. 123456" style="max-width:140px;" />
            </div>
            <div class="filter-group">
              <span class="filter-label">Variant ID</span>
              <input type="number" class="filter-input" id="log-filter-variant" placeholder="e.g. 789012" style="max-width:140px;" />
            </div>
            <div class="filter-group" style="justify-content:flex-end;">
              <button class="btn-primary" id="log-filter-apply">Apply Filters</button>
            </div>
          </div>
          <div id="log-loading" class="shell-loading"><div class="shell-spinner"></div></div>
          <div id="log-error" class="shell-error-banner" style="display:none;"></div>
          <div id="log-table-wrap" class="shell-table-wrap" style="display:none;">
            <table class="shell-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Product</th>
                  <th>Variant</th>
                  <th>Status</th>
                  <th>Sent At</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="log-tbody"></tbody>
            </table>
          </div>
          <div id="log-empty" class="empty-state" style="display:none;">No notification logs found.</div>
          <div class="shell-pagination">
            <span class="pagination-info" id="log-page-label"></span>
            <div class="shell-pagination-btns">
              <button class="btn-secondary" id="log-prev" disabled>Previous</button>
              <button class="btn-secondary" id="log-next" disabled>Next</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(style);

  // ── helpers ──────────────────────────────────────────────────────────────
  function fmt(dateStr) {
    if (!dateStr) return '\u2014';
    try { return new Date(dateStr).toLocaleString(); } catch (e) { return dateStr; }
  }

  function showEl(el, show) {
    el.style.display = show ? '' : 'none';
  }

  function setError(el, msg) {
    el.textContent = msg;
    showEl(el, !!msg);
  }

  // ── TAB NAVIGATION ────────────────────────────────────────────────────────
  const tabBtns = container.querySelectorAll('.tab-btn');
  const tabPanels = container.querySelectorAll('.tab-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      container.querySelector(`#tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // OVERVIEW
  // ══════════════════════════════════════════════════════════════════════════
  let overviewPage = 1;
  let overviewTotal = 0;
  let overviewMaxCount = 1;

  const overviewLoading = container.querySelector('#overview-loading');
  const overviewError = container.querySelector('#overview-error');
  const overviewList = container.querySelector('#overview-list');
  const overviewPrev = container.querySelector('#overview-prev');
  const overviewNext = container.querySelector('#overview-next');
  const overviewPageLabel = container.querySelector('#overview-page-label');
  const overviewPaginationInfo = container.querySelector('#overview-pagination-info');
  const statProducts = container.querySelector('#stat-products');
  const statSubscribers = container.querySelector('#stat-subscribers');

  async function loadOverview() {
    showEl(overviewLoading, true);
    overviewList.innerHTML = '';
    setError(overviewError, '');
    overviewPrev.disabled = true;
    overviewNext.disabled = true;

    try {
      // Fetch paginated product counts and total active subscriber count in parallel
      const [data, subTotalData] = await Promise.all([
        bridge.call('/admin/products/subscriber-counts', { page: overviewPage, page_size: PAGE_SIZE }),
        bridge.call('/admin/subscribers', { page: 1, page_size: 1, product_id: null, variant_id: null, is_active: true })
      ]);

      overviewTotal = data.total;
      const items = data.items || [];

      overviewMaxCount = items.reduce((mx, it) => Math.max(mx, it.active_subscriber_count), 1) || 1;

      // Set stats: product count from paginated total; subscriber count from dedicated aggregate query
      statProducts.textContent = overviewTotal;
      statSubscribers.textContent = subTotalData.total;

      if (items.length === 0) {
        const emp = document.createElement('div');
        emp.className = 'empty-state';
        emp.textContent = 'No products with active subscribers.';
        overviewList.appendChild(emp);
      } else {
        items.forEach(item => {
          const row = document.createElement('div');
          row.className = 'product-row';

          const pct = Math.round((item.active_subscriber_count / overviewMaxCount) * 100);

          const infoDiv = document.createElement('div');
          infoDiv.className = 'product-info';

          const titleDiv = document.createElement('div');
          titleDiv.className = 'product-title';
          titleDiv.textContent = item.product_title || `Product #${item.product_id}`;
          infoDiv.appendChild(titleDiv);

          if (item.variant_breakdown && item.variant_breakdown.length > 0) {
            const vbDiv = document.createElement('div');
            vbDiv.className = 'variant-breakdown';
            item.variant_breakdown.forEach(v => {
              const chip = document.createElement('span');
              chip.className = 'variant-chip';
              chip.textContent = `${v.variant_title || 'Default'}: ${v.active_subscriber_count}`;
              vbDiv.appendChild(chip);
            });
            infoDiv.appendChild(vbDiv);
          }

          const barWrap = document.createElement('div');
          barWrap.className = 'demand-bar-wrap';
          const bar = document.createElement('div');
          bar.className = 'demand-bar';
          bar.style.width = pct + '%';
          barWrap.appendChild(bar);

          const countBadge = document.createElement('span');
          countBadge.className = 'count-badge';
          countBadge.textContent = item.active_subscriber_count + ' waiting';

          const viewBtn = document.createElement('button');
          viewBtn.className = 'btn-secondary';
          viewBtn.textContent = 'View Subscribers';
          viewBtn.style.whiteSpace = 'nowrap';
          viewBtn.addEventListener('click', () => {
            container.querySelector('#sub-filter-product').value = item.product_id;
            container.querySelector('#sub-filter-variant').value = '';
            container.querySelector('#sub-filter-status').value = 'true';
            container.querySelector('[data-tab="subscribers"]').click();
            subPage = 1;
            loadSubscribers();
          });

          row.appendChild(infoDiv);
          row.appendChild(barWrap);
          row.appendChild(countBadge);
          row.appendChild(viewBtn);
          overviewList.appendChild(row);
        });
      }

      const totalPages = Math.ceil(overviewTotal / PAGE_SIZE);
      overviewPageLabel.textContent = `Page ${overviewPage} of ${Math.max(1, totalPages)} (${overviewTotal} products)`;
      overviewPaginationInfo.textContent = `${overviewTotal} products`;
      overviewPrev.disabled = overviewPage <= 1;
      overviewNext.disabled = overviewPage >= totalPages;
    } catch (e) {
      setError(overviewError, 'Failed to load product subscriber counts: ' + (e.message || e));
    } finally {
      showEl(overviewLoading, false);
    }
  }

  overviewPrev.addEventListener('click', () => { overviewPage--; loadOverview(); });
  overviewNext.addEventListener('click', () => { overviewPage++; loadOverview(); });

  // ══════════════════════════════════════════════════════════════════════════
  // SUBSCRIBERS
  // ══════════════════════════════════════════════════════════════════════════
  let subPage = 1;
  let subTotal = 0;
  let selectedSubIds = new Set();

  const subLoading = container.querySelector('#sub-loading');
  const subError = container.querySelector('#sub-error');
  const subTableWrap = container.querySelector('#sub-table-wrap');
  const subEmpty = container.querySelector('#sub-empty');
  const subTbody = container.querySelector('#sub-tbody');
  const subPrev = container.querySelector('#sub-prev');
  const subNext = container.querySelector('#sub-next');
  const subPageLabel = container.querySelector('#sub-page-label');
  const subCheckAll = container.querySelector('#sub-check-all');
  const subBulkBar = container.querySelector('#sub-bulk-bar');
  const subBulkText = container.querySelector('#sub-bulk-text');
  const subBulkUnsub = container.querySelector('#sub-bulk-unsub');
  const subBulkClear = container.querySelector('#sub-bulk-clear');
  const subFilterStatus = container.querySelector('#sub-filter-status');
  const subFilterProduct = container.querySelector('#sub-filter-product');
  const subFilterVariant = container.querySelector('#sub-filter-variant');
  const subFilterApply = container.querySelector('#sub-filter-apply');

  function updateBulkBar() {
    const cnt = selectedSubIds.size;
    showEl(subBulkBar, cnt > 0);
    subBulkText.textContent = `${cnt} subscriber${cnt !== 1 ? 's' : ''} selected`;
  }

  function syncCheckAll() {
    const boxes = subTbody.querySelectorAll('.sub-check');
    const checked = [...boxes].filter(b => b.checked);
    subCheckAll.indeterminate = checked.length > 0 && checked.length < boxes.length;
    subCheckAll.checked = boxes.length > 0 && checked.length === boxes.length;
  }

  async function loadSubscribers() {
    showEl(subLoading, true);
    showEl(subTableWrap, false);
    showEl(subEmpty, false);
    setError(subError, '');
    subPrev.disabled = true;
    subNext.disabled = true;

    const statusVal = subFilterStatus.value;
    const productVal = subFilterProduct.value;
    const variantVal = subFilterVariant.value;

    const body = {
      page: subPage,
      page_size: PAGE_SIZE,
      product_id: productVal ? parseInt(productVal, 10) : null,
      variant_id: variantVal ? parseInt(variantVal, 10) : null,
      is_active: statusVal === '' ? null : statusVal === 'true',
    };

    try {
      const data = await bridge.call('/admin/subscribers', body);
      subTotal = data.total;
      const items = data.items || [];

      subTbody.innerHTML = '';

      if (items.length === 0) {
        showEl(subEmpty, true);
      } else {
        items.forEach(item => {
          const tr = document.createElement('tr');

          const tdCheck = document.createElement('td');
          tdCheck.className = 'select-col';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'sub-check';
          cb.dataset.id = item.id;
          cb.checked = selectedSubIds.has(item.id);
          cb.addEventListener('change', () => {
            if (cb.checked) selectedSubIds.add(item.id);
            else selectedSubIds.delete(item.id);
            updateBulkBar();
            syncCheckAll();
          });
          tdCheck.appendChild(cb);

          const tdEmail = document.createElement('td');
          tdEmail.textContent = item.email;

          const tdProduct = document.createElement('td');
          const link = document.createElement('a');
          link.href = item.product_url || '#';
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = item.product_title || `#${item.product_id}`;
          link.style.color = '#008060';
          tdProduct.appendChild(link);

          const tdVariant = document.createElement('td');
          tdVariant.textContent = item.variant_title || 'Default';

          const tdStatus = document.createElement('td');
          const badge = document.createElement('span');
          badge.className = item.is_active ? 'badge badge-success' : 'badge badge-neutral';
          badge.textContent = item.is_active ? 'Active' : 'Inactive';
          tdStatus.appendChild(badge);

          const tdDate = document.createElement('td');
          tdDate.textContent = fmt(item.created_at);

          const tdAction = document.createElement('td');
          if (item.is_active) {
            const unsubBtn = document.createElement('button');
            unsubBtn.className = 'btn-danger';
            unsubBtn.textContent = 'Unsubscribe';
            unsubBtn.style.fontSize = 'var(--p-font-size-300)';
            unsubBtn.style.padding = 'var(--p-space-100) var(--p-space-200)';
            unsubBtn.addEventListener('click', async () => {
              unsubBtn.disabled = true;
              try {
                const result = await bridge.call('/admin/subscribers/bulk-unsubscribe', { subscription_ids: [item.id] });
                bridge.notify(`Unsubscribed ${result.unsubscribed_count} subscriber`, 'success');
                loadSubscribers();
                loadOverview();
              } catch (e) {
                bridge.notify('Failed to unsubscribe: ' + (e.message || e), 'error');
                unsubBtn.disabled = false;
              }
            });
            tdAction.appendChild(unsubBtn);
          }

          tr.appendChild(tdCheck);
          tr.appendChild(tdEmail);
          tr.appendChild(tdProduct);
          tr.appendChild(tdVariant);
          tr.appendChild(tdStatus);
          tr.appendChild(tdDate);
          tr.appendChild(tdAction);
          subTbody.appendChild(tr);
        });

        showEl(subTableWrap, true);
        syncCheckAll();
      }

      const totalPages = Math.ceil(subTotal / PAGE_SIZE);
      subPageLabel.textContent = `Page ${subPage} of ${Math.max(1, totalPages)} (${subTotal} subscribers)`;
      subPrev.disabled = subPage <= 1;
      subNext.disabled = subPage >= totalPages;
    } catch (e) {
      setError(subError, 'Failed to load subscribers: ' + (e.message || e));
    } finally {
      showEl(subLoading, false);
    }
  }

  subCheckAll.addEventListener('change', () => {
    const boxes = subTbody.querySelectorAll('.sub-check');
    boxes.forEach(cb => {
      cb.checked = subCheckAll.checked;
      if (cb.checked) selectedSubIds.add(cb.dataset.id);
      else selectedSubIds.delete(cb.dataset.id);
    });
    updateBulkBar();
  });

  subBulkClear.addEventListener('click', () => {
    selectedSubIds.clear();
    subTbody.querySelectorAll('.sub-check').forEach(cb => { cb.checked = false; });
    subCheckAll.checked = false;
    subCheckAll.indeterminate = false;
    updateBulkBar();
  });

  subBulkUnsub.addEventListener('click', async () => {
    if (selectedSubIds.size === 0) return;
    subBulkUnsub.disabled = true;
    try {
      const ids = [...selectedSubIds];
      const result = await bridge.call('/admin/subscribers/bulk-unsubscribe', { subscription_ids: ids });
      bridge.notify(`Unsubscribed ${result.unsubscribed_count} subscriber(s)`, 'success');
      selectedSubIds.clear();
      updateBulkBar();
      loadSubscribers();
      loadOverview();
    } catch (e) {
      bridge.notify('Bulk unsubscribe failed: ' + (e.message || e), 'error');
      subBulkUnsub.disabled = false;
    }
  });

  subFilterApply.addEventListener('click', () => {
    subPage = 1;
    selectedSubIds.clear();
    updateBulkBar();
    loadSubscribers();
  });

  [subFilterProduct, subFilterVariant].forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        subPage = 1;
        selectedSubIds.clear();
        updateBulkBar();
        loadSubscribers();
      }
    });
  });

  subPrev.addEventListener('click', () => { subPage--; loadSubscribers(); });
  subNext.addEventListener('click', () => { subPage++; loadSubscribers(); });

  // ══════════════════════════════════════════════════════════════════════════
  // NOTIFICATION LOGS
  // ══════════════════════════════════════════════════════════════════════════
  let logPage = 1;
  let logTotal = 0;

  const logLoading = container.querySelector('#log-loading');
  const logError = container.querySelector('#log-error');
  const logTableWrap = container.querySelector('#log-table-wrap');
  const logEmpty = container.querySelector('#log-empty');
  const logTbody = container.querySelector('#log-tbody');
  const logPrev = container.querySelector('#log-prev');
  const logNext = container.querySelector('#log-next');
  const logPageLabel = container.querySelector('#log-page-label');
  const logFilterEmail = container.querySelector('#log-filter-email');
  const logFilterProduct = container.querySelector('#log-filter-product');
  const logFilterVariant = container.querySelector('#log-filter-variant');
  const logFilterApply = container.querySelector('#log-filter-apply');

  async function loadLogs() {
    showEl(logLoading, true);
    showEl(logTableWrap, false);
    showEl(logEmpty, false);
    setError(logError, '');
    logPrev.disabled = true;
    logNext.disabled = true;

    const emailVal = logFilterEmail.value.trim();
    const productVal = logFilterProduct.value;
    const variantVal = logFilterVariant.value;

    const body = {
      page: logPage,
      page_size: PAGE_SIZE,
      product_id: productVal ? parseInt(productVal, 10) : null,
      variant_id: variantVal ? parseInt(variantVal, 10) : null,
      email: emailVal || null,
    };

    try {
      const data = await bridge.call('/admin/notification-logs', body);
      logTotal = data.total;
      const items = data.items || [];

      logTbody.innerHTML = '';

      if (items.length === 0) {
        showEl(logEmpty, true);
      } else {
        items.forEach(item => {
          const tr = document.createElement('tr');

          const tdEmail = document.createElement('td');
          tdEmail.textContent = item.email;

          const tdProduct = document.createElement('td');
          const link = document.createElement('a');
          link.href = item.product_url || '#';
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = item.product_title || `#${item.product_id}`;
          link.style.color = '#008060';
          tdProduct.appendChild(link);

          const tdVariant = document.createElement('td');
          tdVariant.textContent = item.variant_title || 'Default';

          const tdStatus = document.createElement('td');
          const statusNorm = (item.status || '').toLowerCase();
          const statusEl = document.createElement('span');
          if (statusNorm === 'sent' || statusNorm === 'delivered') {
            statusEl.className = 'badge badge-success';
          } else if (statusNorm === 'failed' || statusNorm === 'error') {
            statusEl.className = 'badge badge-error';
          } else {
            statusEl.className = 'badge badge-neutral';
          }
          statusEl.textContent = item.status || '\u2014';
          tdStatus.appendChild(statusEl);

          const tdSentAt = document.createElement('td');
          tdSentAt.textContent = fmt(item.sent_at);

          const tdAction = document.createElement('td');
          const resendBtn = document.createElement('button');
          resendBtn.className = 'btn-secondary';
          resendBtn.textContent = 'Resend';
          resendBtn.style.fontSize = 'var(--p-font-size-300)';
          resendBtn.style.padding = 'var(--p-space-100) var(--p-space-200)';
          resendBtn.addEventListener('click', async () => {
            resendBtn.disabled = true;
            resendBtn.textContent = 'Sending\u2026';
            try {
              const res = await bridge.call('/admin/notification-logs/resend', { notification_log_id: item.id });
              if (res.success) {
                bridge.notify('Notification resent successfully', 'success');
                loadLogs();
              } else {
                bridge.notify('Resend failed: ' + (res.message || 'Unknown error'), 'error');
                resendBtn.disabled = false;
                resendBtn.textContent = 'Resend';
              }
            } catch (e) {
              bridge.notify('Resend error: ' + (e.message || e), 'error');
              resendBtn.disabled = false;
              resendBtn.textContent = 'Resend';
            }
          });
          tdAction.appendChild(resendBtn);

          tr.appendChild(tdEmail);
          tr.appendChild(tdProduct);
          tr.appendChild(tdVariant);
          tr.appendChild(tdStatus);
          tr.appendChild(tdSentAt);
          tr.appendChild(tdAction);
          logTbody.appendChild(tr);
        });

        showEl(logTableWrap, true);
      }

      const totalPages = Math.ceil(logTotal / PAGE_SIZE);
      logPageLabel.textContent = `Page ${logPage} of ${Math.max(1, totalPages)} (${logTotal} logs)`;
      logPrev.disabled = logPage <= 1;
      logNext.disabled = logPage >= totalPages;
    } catch (e) {
      setError(logError, 'Failed to load notification logs: ' + (e.message || e));
    } finally {
      showEl(logLoading, false);
    }
  }

  logFilterApply.addEventListener('click', () => { logPage = 1; loadLogs(); });
  [logFilterEmail, logFilterProduct, logFilterVariant].forEach(input => {
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { logPage = 1; loadLogs(); } });
  });

  logPrev.addEventListener('click', () => { logPage--; loadLogs(); });
  logNext.addEventListener('click', () => { logPage++; loadLogs(); });

  // ── Tab switch lazy-loads ─────────────────────────────────────────────────
  let subsLoaded = false;
  let logsLoaded = false;

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === 'subscribers' && !subsLoaded) { subsLoaded = true; loadSubscribers(); }
      if (tab === 'logs' && !logsLoaded) { logsLoaded = true; loadLogs(); }
    });
  });

  // ── Initial load ─────────────────────────────────────────────────────────
  loadOverview();
}
```


## Explanation

Your back-in-stock notification feature lets customers sign up to be notified when sold-out products come back into stock. When a customer clicks "Notify me" on your storefront, their email is saved. Once inventory for that product increases from zero, all subscribers automatically receive an email alert—no manual action needed from you. You can view and manage all subscriber lists directly from your Shopify Admin dashboard, see how many customers are waiting for each product, send reminder notifications manually if needed, and remove subscribers in bulk. The system automatically cleans up subscriptions after notifications are sent and prevents the same customer from subscribing multiple times to the same product, keeping your subscriber lists clean and accurate.
