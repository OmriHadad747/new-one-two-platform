# Chat Local — Full Pipeline

**Date:** 2026-04-14 14:09:10  
**Status:** ✅ SUCCESS  
**Total:** 292975ms  
**Tokens:** in=62614 out=45496 total=108110  
**Prompt:** Customers receive email notifications when subscribed products return to stock, and merchants can review subscription activity and manually send test notifications.

## Intent (Product Agent)

```json
{
  "triggerTypes": [
    "webhook",
    "widget",
    "admin"
  ],
  "resources": [
    "Product",
    "Inventory",
    "Customer"
  ],
  "desiredOutcome": "Customers receive email notifications when subscribed products return to stock, and merchants can review subscription activity and manually send test notifications.",
  "cronSchedule": null,
  "appCategory": "storefront_backend_admin",
  "qualityBrief": "A good version handles: duplicate subscriptions (one per product-email pair), inventory threshold configuration (merchants set minimum stock level before triggering), unsubscribe links in emails, graceful handling of deleted products, and a clean admin table showing subscriber count, last notification date, and bulk actions (pause, delete subscriptions). Avoid: sending multiple emails for a single restocking event, subscribing unauthenticated customers without consent flow, or breaking when variant inventory changes."
}
```

## Architect Plan

```json
{
  "shopifyPlan": {
    "webhookTopics": [
      "inventory_levels/update",
      "products/delete"
    ],
    "cronSchedule": null
  },
  "appContracts": {
    "feasibility": "feasible",
    "blockedReason": null,
    "complexity": "high",
    "edgeCases": [
      "Multiple inventory_levels/update webhooks fire in rapid succession for the same inventory_item_id \u2014 deduplicate using a DB-level lock or idempotency check before sending notifications",
      "A product or variant is deleted before restocking triggers \u2014 clean up orphaned subscriptions and skip notification dispatch",
      "Customer subscribes to a variant that is already in stock at subscription time \u2014 do not notify immediately, only notify on a transition from out-of-stock to in-stock",
      "Same email subscribes to the same product/variant twice (e.g. page reload or double-click) \u2014 enforce unique constraint and return success silently on duplicate",
      "Merchant sends a test notification to a subscription record whose associated product has since been deleted \u2014 return a clear error from the handler rather than a broken email",
      "inventory_levels/update payload references an inventory_item_id that maps to multiple variants \u2014 resolve all affected variant subscriptions and notify each distinct subscriber once per product"
    ],
    "uxExpectations": {
      "storefront": "Widget should feel lightweight and inline on the product page \u2014 email field pre-filled for logged-in customers, single-click subscribe with immediate confirmation copy. Show a short 'You'll be notified when this is back' message on success, and an unsubscribe option for customers who are already subscribed.",
      "admin": "Dashboard should lead with a summary table of products with active subscribers, showing subscriber count and last notification sent date. Inline bulk actions (pause, delete) should be fast and confirm before destructive operations. Test notification should be a prominent button per row, with clear success/failure feedback."
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
          "action": "dispatch_restock_notifications"
        },
        {
          "from": "in_stock",
          "to": "out_of_stock",
          "action": "update_tracked_status_only"
        }
      ]
    },
    "platformGaps": [
      {
        "gap": "No batch write API for sending restock notification emails \u2014 each subscriber requires an individual email dispatch call",
        "mitigation": "Pre-fetch all subscriptions for affected variants in a single DB query before the loop; per-subscriber email sends inside the loop are unavoidable. Mark each subscription with last_notified_at in the same loop iteration to prevent duplicate sends."
      },
      {
        "gap": "Shopify inventory_levels/update payload provides inventory_item_id and available quantity but does not directly provide product_id or variant_id \u2014 a mapping lookup is required",
        "mitigation": "Maintain an inventory_item_variant_map table populated at subscription time (and refreshed via Storefront API lookup when missing) so the handler can resolve inventory_item_id to variant_id and product_id without a live Shopify API call on every webhook"
      },
      {
        "gap": "Unsubscribe link in email requires a stateless verifiable token so customers can unsubscribe without being logged in",
        "mitigation": "Generate a UUID token column on the subscription row at insert time; embed it in the unsubscribe URL handled by the widget API /subscription/unsubscribe route \u2014 no auth required, token is the credential"
      }
    ],
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
            "name": "email",
            "type": "TEXT",
            "constraints": "NOT NULL"
          },
          {
            "name": "customer_id",
            "type": "BIGINT",
            "constraints": "NULL"
          },
          {
            "name": "product_id",
            "type": "BIGINT",
            "constraints": "NOT NULL"
          },
          {
            "name": "variant_id",
            "type": "BIGINT",
            "constraints": "NOT NULL"
          },
          {
            "name": "status",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT 'active'"
          },
          {
            "name": "unsubscribe_token",
            "type": "UUID",
            "constraints": "NOT NULL DEFAULT gen_random_uuid()"
          },
          {
            "name": "last_notified_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NULL"
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
            "email",
            "variant_id"
          ]
        },
        "indexes": [
          "tenant_id",
          "variant_id",
          "product_id",
          "status",
          "unsubscribe_token"
        ],
        "rls": true
      },
      {
        "table": "inventory_item_variant_map",
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
          "inventory_item_id",
          "variant_id"
        ],
        "rls": true
      },
      {
        "table": "inventory_stock_state",
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
            "name": "location_id",
            "type": "BIGINT",
            "constraints": "NOT NULL"
          },
          {
            "name": "stock_status",
            "type": "TEXT",
            "constraints": "NULL"
          },
          {
            "name": "available",
            "type": "INTEGER",
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
            "inventory_item_id",
            "location_id"
          ]
        },
        "indexes": [
          "tenant_id",
          "inventory_item_id"
        ],
        "rls": true
      },
      {
        "table": "restock_settings",
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
            "name": "minimum_stock_threshold",
            "type": "INTEGER",
            "constraints": "NOT NULL DEFAULT 1"
          },
          {
            "name": "email_subject_template",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT 'Your item is back in stock!'"
          },
          {
            "name": "updated_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NOT NULL DEFAULT now()"
          }
        ],
        "uniqueConstraint": {
          "columns": [
            "tenant_id"
          ]
        },
        "indexes": [
          "tenant_id"
        ],
        "rls": true
      },
      {
        "table": "notification_log",
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
            "name": "email",
            "type": "TEXT",
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
            "name": "notification_type",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT 'restock'"
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
          "sent_at"
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
      "handlerMustProduce": "Before writing to the DB, the handler must: (1) resolve inventory_item_id + location_id to a stock_status string ('in_stock' when available >= tenant's minimum_stock_threshold, 'out_of_stock' otherwise) using the available quantity from the payload and the threshold from restock_settings; (2) look up the prior stock_status from inventory_stock_state for this tenant/inventory_item_id/location_id combination; (3) if prior state is null (unknown sentinel), upsert the new state and skip notification dispatch; (4) if transition is out_of_stock \u2192 in_stock, resolve variant_id and product_id from inventory_item_variant_map using inventory_item_id, then fetch all active back_in_stock_subscriptions for that tenant/variant_id, and dispatch one email per subscriber; (5) upsert inventory_stock_state with the new stock_status and available value; (6) for each successfully notified subscriber, update last_notified_at on the subscription row and insert a notification_log record."
    },
    "cronContract": null,
    "widgetTargetTemplates": [
      "product"
    ],
    "widgetApiCatalog": [
      {
        "path": "/subscription/create",
        "method": "POST",
        "requestShape": {
          "email": "string",
          "product_id": "number",
          "variant_id": "number",
          "customer_id": "number | null"
        },
        "responseShape": {
          "success": "boolean",
          "subscription_id": "string",
          "already_subscribed": "boolean"
        }
      },
      {
        "path": "/subscription/status",
        "method": "POST",
        "requestShape": {
          "email": "string",
          "variant_id": "number"
        },
        "responseShape": {
          "subscribed": "boolean",
          "status": "string | null"
        }
      },
      {
        "path": "/subscription/unsubscribe",
        "method": "POST",
        "requestShape": {
          "token": "string"
        },
        "responseShape": {
          "success": "boolean"
        }
      }
    ],
    "adminApiCatalog": [
      {
        "path": "/admin/subscriptions",
        "method": "GET",
        "requestShape": {
          "page": "number",
          "page_size": "number",
          "product_id": "number | null",
          "status": "string | null"
        },
        "responseShape": {
          "items": [
            {
              "id": "string",
              "email": "string",
              "customer_id": "number | null",
              "product_id": "number",
              "variant_id": "number",
              "status": "string",
              "last_notified_at": "string | null",
              "created_at": "string"
            }
          ],
          "total": "number",
          "page": "number",
          "page_size": "number"
        }
      },
      {
        "path": "/admin/subscriptions/bulk-update",
        "method": "POST",
        "requestShape": {
          "ids": "string[]",
          "action": "string"
        },
        "responseShape": {
          "success": "boolean",
          "affected": "number"
        }
      },
      {
        "path": "/admin/subscriptions/bulk-delete",
        "method": "POST",
        "requestShape": {
          "ids": "string[]"
        },
        "responseShape": {
          "success": "boolean",
          "deleted": "number"
        }
      },
      {
        "path": "/admin/subscriptions/test-notification",
        "method": "POST",
        "requestShape": {
          "subscription_id": "string"
        },
        "responseShape": {
          "success": "boolean",
          "email_sent_to": "string"
        }
      },
      {
        "path": "/admin/products/summary",
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
              "last_notification_sent_at": "string | null"
            }
          ],
          "total": "number",
          "page": "number",
          "page_size": "number"
        }
      },
      {
        "path": "/admin/notification-log",
        "method": "GET",
        "requestShape": {
          "page": "number",
          "page_size": "number",
          "subscription_id": "string | null"
        },
        "responseShape": {
          "items": [
            {
              "id": "string",
              "subscription_id": "string",
              "email": "string",
              "variant_id": "number",
              "product_id": "number",
              "notification_type": "string",
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
        "path": "/admin/settings",
        "method": "GET",
        "requestShape": {},
        "responseShape": {
          "minimum_stock_threshold": "number",
          "email_subject_template": "string"
        }
      },
      {
        "path": "/admin/settings/update",
        "method": "POST",
        "requestShape": {
          "minimum_stock_threshold": "number",
          "email_subject_template": "string"
        },
        "responseShape": {
          "success": "boolean"
        }
      }
    ]
  }
}
```

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: ['inventory_levels/update', 'products/delete'],
  cronSchedule: null,
  npmPackages: ['uuid@9.0.1'],
  handler: async function(ctx) {
    const { v4: uuidv4 } = require('uuid');

    try {
      // ── WIDGET ──────────────────────────────────────────────────────────────
      if (ctx.trigger === 'widget') {

        // POST /subscription/create
        if (ctx.widgetPath === '/subscription/create') {
          try {
            const { email, product_id, variant_id, customer_id } = ctx.widgetBody;
            if (!email || !product_id || !variant_id) {
              return { success: false, subscription_id: null, already_subscribed: false };
            }

            // Look up inventory_item_id for this variant to populate the map
            let inventoryItemId = null;
            try {
              const { variant } = await ctx.shopify.get(`/variants/${variant_id}.json`);
              if (variant && variant.inventory_item_id) {
                inventoryItemId = variant.inventory_item_id;
                // Upsert the mapping table
                await ctx.db`
                  INSERT INTO inventory_item_variant_map (tenant_id, inventory_item_id, variant_id, product_id)
                  VALUES (${ctx.tenantId}, ${inventoryItemId}, ${variant_id}, ${product_id})
                  ON CONFLICT (tenant_id, inventory_item_id, variant_id) DO NOTHING
                `;
              }
            } catch (shopifyErr) {
              ctx.logger.warn({ variant_id, err: shopifyErr.message }, 'widget/create: failed to fetch variant for map');
            }

            const token = uuidv4();

            // Check existing
            const existing = await ctx.db`
              SELECT id, status FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
                AND email = ${email}
                AND variant_id = ${variant_id}
            `;

            if (existing.length > 0) {
              const row = existing[0];
              // Reactivate if previously inactive
              if (row.status !== 'active') {
                await ctx.db`
                  UPDATE back_in_stock_subscriptions
                  SET status = 'active', customer_id = ${customer_id ?? null}
                  WHERE tenant_id = ${ctx.tenantId} AND id = ${row.id}
                `;
              }
              return { success: true, subscription_id: String(row.id), already_subscribed: true };
            }

            const inserted = await ctx.db`
              INSERT INTO back_in_stock_subscriptions
                (tenant_id, email, customer_id, product_id, variant_id, status, unsubscribe_token, created_at)
              VALUES
                (${ctx.tenantId}, ${email}, ${customer_id ?? null}, ${product_id}, ${variant_id}, 'active', ${token}, NOW())
              ON CONFLICT (tenant_id, email, variant_id) DO NOTHING
              RETURNING id
            `;

            if (inserted.length === 0) {
              // Race — already exists
              const [race] = await ctx.db`
                SELECT id FROM back_in_stock_subscriptions
                WHERE tenant_id = ${ctx.tenantId} AND email = ${email} AND variant_id = ${variant_id}
              `;
              return { success: true, subscription_id: String(race.id), already_subscribed: true };
            }

            return { success: true, subscription_id: String(inserted[0].id), already_subscribed: false };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'widget/subscription/create error');
            return { success: false, subscription_id: null, already_subscribed: false };
          }
        }

        // POST /subscription/status
        if (ctx.widgetPath === '/subscription/status') {
          try {
            const { email, variant_id } = ctx.widgetBody;
            if (!email || !variant_id) {
              return { subscribed: false, status: null };
            }
            const [row] = await ctx.db`
              SELECT status FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND email = ${email} AND variant_id = ${variant_id}
            `;
            if (!row) return { subscribed: false, status: null };
            return { subscribed: row.status === 'active', status: row.status };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'widget/subscription/status error');
            return { subscribed: false, status: null };
          }
        }

        // POST /subscription/unsubscribe
        if (ctx.widgetPath === '/subscription/unsubscribe') {
          try {
            const { token } = ctx.widgetBody;
            if (!token) return { success: false };
            const result = await ctx.db`
              UPDATE back_in_stock_subscriptions
              SET status = 'unsubscribed'
              WHERE tenant_id = ${ctx.tenantId} AND unsubscribe_token = ${token} AND status = 'active'
              RETURNING id
            `;
            return { success: result.length > 0 };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'widget/subscription/unsubscribe error');
            return { success: false };
          }
        }

        return { error: 'unknown path' };
      }

      // ── ADMIN ────────────────────────────────────────────────────────────────
      if (ctx.trigger === 'admin') {
        ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

        // GET /admin/subscriptions
        if (ctx.adminPath === '/admin/subscriptions') {
          try {
            const { page = 1, page_size = 20, product_id = null, status = null } = ctx.adminBody || {};
            const offset = (page - 1) * page_size;

            let items, total;
            if (product_id !== null && status !== null) {
              items = await ctx.db`
                SELECT id, email, customer_id, product_id, variant_id, status, last_notified_at, created_at
                FROM back_in_stock_subscriptions
                WHERE tenant_id = ${ctx.tenantId} AND product_id = ${product_id} AND status = ${status}
                ORDER BY created_at DESC LIMIT ${page_size} OFFSET ${offset}
              `;
              const [cnt] = await ctx.db`
                SELECT COUNT(*)::int AS cnt FROM back_in_stock_subscriptions
                WHERE tenant_id = ${ctx.tenantId} AND product_id = ${product_id} AND status = ${status}
              `;
              total = cnt.cnt;
            } else if (product_id !== null) {
              items = await ctx.db`
                SELECT id, email, customer_id, product_id, variant_id, status, last_notified_at, created_at
                FROM back_in_stock_subscriptions
                WHERE tenant_id = ${ctx.tenantId} AND product_id = ${product_id}
                ORDER BY created_at DESC LIMIT ${page_size} OFFSET ${offset}
              `;
              const [cnt] = await ctx.db`
                SELECT COUNT(*)::int AS cnt FROM back_in_stock_subscriptions
                WHERE tenant_id = ${ctx.tenantId} AND product_id = ${product_id}
              `;
              total = cnt.cnt;
            } else if (status !== null) {
              items = await ctx.db`
                SELECT id, email, customer_id, product_id, variant_id, status, last_notified_at, created_at
                FROM back_in_stock_subscriptions
                WHERE tenant_id = ${ctx.tenantId} AND status = ${status}
                ORDER BY created_at DESC LIMIT ${page_size} OFFSET ${offset}
              `;
              const [cnt] = await ctx.db`
                SELECT COUNT(*)::int AS cnt FROM back_in_stock_subscriptions
                WHERE tenant_id = ${ctx.tenantId} AND status = ${status}
              `;
              total = cnt.cnt;
            } else {
              items = await ctx.db`
                SELECT id, email, customer_id, product_id, variant_id, status, last_notified_at, created_at
                FROM back_in_stock_subscriptions
                WHERE tenant_id = ${ctx.tenantId}
                ORDER BY created_at DESC LIMIT ${page_size} OFFSET ${offset}
              `;
              const [cnt] = await ctx.db`
                SELECT COUNT(*)::int AS cnt FROM back_in_stock_subscriptions
                WHERE tenant_id = ${ctx.tenantId}
              `;
              total = cnt.cnt;
            }

            return {
              items: items.map(r => ({
                id: String(r.id),
                email: r.email,
                customer_id: r.customer_id ? Number(r.customer_id) : null,
                product_id: Number(r.product_id),
                variant_id: Number(r.variant_id),
                status: r.status,
                last_notified_at: r.last_notified_at ? r.last_notified_at.toISOString() : null,
                created_at: r.created_at.toISOString(),
              })),
              total,
              page,
              page_size,
            };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'admin/subscriptions error');
            return { error: 'Failed to fetch subscriptions' };
          }
        }

        // POST /admin/subscriptions/bulk-update
        if (ctx.adminPath === '/admin/subscriptions/bulk-update') {
          try {
            const { ids, action } = ctx.adminBody || {};
            if (!ids || !Array.isArray(ids) || ids.length === 0 || !action) {
              return { success: false, affected: 0 };
            }
            const allowedActions = ['activate', 'deactivate', 'unsubscribe'];
            if (!allowedActions.includes(action)) {
              return { success: false, affected: 0 };
            }
            const newStatus = action === 'activate' ? 'active' : action === 'deactivate' ? 'inactive' : 'unsubscribed';
            ctx.logger.info({ action, count: ids.length }, 'admin bulk-update subscriptions');
            const result = await ctx.db`
              UPDATE back_in_stock_subscriptions
              SET status = ${newStatus}
              WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${ids})
              RETURNING id
            `;
            return { success: true, affected: result.length };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'admin/subscriptions/bulk-update error');
            return { success: false, affected: 0 };
          }
        }

        // POST /admin/subscriptions/bulk-delete
        if (ctx.adminPath === '/admin/subscriptions/bulk-delete') {
          try {
            const { ids } = ctx.adminBody || {};
            if (!ids || !Array.isArray(ids) || ids.length === 0) {
              return { success: false, deleted: 0 };
            }
            ctx.logger.info({ count: ids.length }, 'admin bulk-delete subscriptions');
            const result = await ctx.db`
              DELETE FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${ids})
              RETURNING id
            `;
            return { success: true, deleted: result.length };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'admin/subscriptions/bulk-delete error');
            return { success: false, deleted: 0 };
          }
        }

        // POST /admin/subscriptions/test-notification
        if (ctx.adminPath === '/admin/subscriptions/test-notification') {
          try {
            const { subscription_id } = ctx.adminBody || {};
            if (!subscription_id) {
              return { success: false, email_sent_to: '' };
            }

            const [sub] = await ctx.db`
              SELECT id, email, product_id, variant_id, status
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND id = ${subscription_id}
            `;
            if (!sub) {
              return { success: false, email_sent_to: '' };
            }

            // Verify product still exists
            let productTitle = 'your product';
            try {
              const { product } = await ctx.shopify.get(`/products/${sub.product_id}.json?fields=id,title`);
              if (!product) {
                ctx.logger.warn({ product_id: sub.product_id }, 'admin/test-notification: product not found');
                return { success: false, email_sent_to: '' };
              }
              productTitle = product.title;
            } catch (shopifyErr) {
              ctx.logger.warn({ product_id: sub.product_id, err: shopifyErr.message }, 'admin/test-notification: product fetch failed');
              return { success: false, email_sent_to: '' };
            }

            const [settings] = await ctx.db`
              SELECT minimum_stock_threshold FROM restock_settings WHERE tenant_id = ${ctx.tenantId}
            `;

            // Build unsubscribe token lookup
            const unsubscribeUrl = `https://${ctx.shop.domain}/apps/back-in-stock/unsubscribe?token=${sub.unsubscribe_token || ''}`;

            ctx.logger.info({ subscription_id, email: sub.email }, 'admin: sending test notification');
            await ctx.services.email.send({
              to: sub.email,
              data: {
                productTitle,
                productUrl: `https://${ctx.shop.domain}/products/${sub.product_id}`,
                variantId: Number(sub.variant_id),
                unsubscribeUrl,
                isTest: true,
              },
            });

            await ctx.db`
              INSERT INTO notification_log (tenant_id, subscription_id, email, variant_id, product_id, notification_type, status, sent_at)
              VALUES (${ctx.tenantId}, ${sub.id}, ${sub.email}, ${sub.variant_id}, ${sub.product_id}, 'test', 'sent', NOW())
            `;

            return { success: true, email_sent_to: sub.email };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'admin/subscriptions/test-notification error');
            return { success: false, email_sent_to: '' };
          }
        }

        // GET /admin/products/summary
        if (ctx.adminPath === '/admin/products/summary') {
          try {
            const { page = 1, page_size = 20 } = ctx.adminBody || {};
            const offset = (page - 1) * page_size;

            const rows = await ctx.db`
              SELECT
                s.product_id,
                COUNT(*) FILTER (WHERE s.status = 'active') AS active_subscriber_count,
                MAX(nl.sent_at) AS last_notification_sent_at
              FROM back_in_stock_subscriptions s
              LEFT JOIN notification_log nl
                ON nl.tenant_id = s.tenant_id AND nl.product_id = s.product_id AND nl.notification_type = 'restock'
              WHERE s.tenant_id = ${ctx.tenantId}
              GROUP BY s.product_id
              ORDER BY active_subscriber_count DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;

            const [cntRow] = await ctx.db`
              SELECT COUNT(DISTINCT product_id)::int AS cnt
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
            `;
            const total = cntRow.cnt;

            // Batch-fetch product titles
            const productIds = rows.map(r => String(r.product_id));
            const productTitleMap = {};
            for (let i = 0; i < productIds.length; i += 250) {
              const chunk = productIds.slice(i, i + 250);
              try {
                const { products } = await ctx.shopify.get(
                  `/products.json?ids=${chunk.join(',')}&fields=id,title&limit=250`
                );
                for (const p of (products || [])) {
                  productTitleMap[String(p.id)] = p.title;
                }
              } catch (shopifyErr) {
                ctx.logger.warn({ err: shopifyErr.message }, 'admin/products/summary: batch fetch failed');
              }
            }

            return {
              items: rows.map(r => ({
                product_id: Number(r.product_id),
                product_title: productTitleMap[String(r.product_id)] || 'Unknown Product',
                active_subscriber_count: Number(r.active_subscriber_count),
                last_notification_sent_at: r.last_notification_sent_at
                  ? new Date(r.last_notification_sent_at).toISOString()
                  : null,
              })),
              total,
              page,
              page_size,
            };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'admin/products/summary error');
            return { error: 'Failed to fetch products summary' };
          }
        }

        // GET /admin/notification-log
        if (ctx.adminPath === '/admin/notification-log') {
          try {
            const { page = 1, page_size = 20, subscription_id = null } = ctx.adminBody || {};
            const offset = (page - 1) * page_size;

            let items, total;
            if (subscription_id !== null) {
              items = await ctx.db`
                SELECT id, subscription_id, email, variant_id, product_id, notification_type, status, sent_at
                FROM notification_log
                WHERE tenant_id = ${ctx.tenantId} AND subscription_id = ${subscription_id}
                ORDER BY sent_at DESC LIMIT ${page_size} OFFSET ${offset}
              `;
              const [cnt] = await ctx.db`
                SELECT COUNT(*)::int AS cnt FROM notification_log
                WHERE tenant_id = ${ctx.tenantId} AND subscription_id = ${subscription_id}
              `;
              total = cnt.cnt;
            } else {
              items = await ctx.db`
                SELECT id, subscription_id, email, variant_id, product_id, notification_type, status, sent_at
                FROM notification_log
                WHERE tenant_id = ${ctx.tenantId}
                ORDER BY sent_at DESC LIMIT ${page_size} OFFSET ${offset}
              `;
              const [cnt] = await ctx.db`
                SELECT COUNT(*)::int AS cnt FROM notification_log WHERE tenant_id = ${ctx.tenantId}
              `;
              total = cnt.cnt;
            }

            return {
              items: items.map(r => ({
                id: String(r.id),
                subscription_id: String(r.subscription_id),
                email: r.email,
                variant_id: Number(r.variant_id),
                product_id: Number(r.product_id),
                notification_type: r.notification_type,
                status: r.status,
                sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null,
              })),
              total,
              page,
              page_size,
            };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'admin/notification-log error');
            return { error: 'Failed to fetch notification log' };
          }
        }

        // GET /admin/settings
        if (ctx.adminPath === '/admin/settings') {
          try {
            const [settings] = await ctx.db`
              SELECT minimum_stock_threshold, email_subject_template
              FROM restock_settings
              WHERE tenant_id = ${ctx.tenantId}
            `;
            if (!settings) {
              return { minimum_stock_threshold: 1, email_subject_template: 'Your item is back in stock!' };
            }
            return {
              minimum_stock_threshold: Number(settings.minimum_stock_threshold),
              email_subject_template: settings.email_subject_template,
            };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'admin/settings error');
            return { error: 'Failed to fetch settings' };
          }
        }

        // POST /admin/settings/update
        if (ctx.adminPath === '/admin/settings/update') {
          try {
            const { minimum_stock_threshold, email_subject_template } = ctx.adminBody || {};
            if (minimum_stock_threshold === undefined || !email_subject_template) {
              return { success: false };
            }
            ctx.logger.info({ minimum_stock_threshold, email_subject_template }, 'admin: update settings');
            await ctx.db`
              INSERT INTO restock_settings (tenant_id, minimum_stock_threshold, email_subject_template, updated_at)
              VALUES (${ctx.tenantId}, ${minimum_stock_threshold}, ${email_subject_template}, NOW())
              ON CONFLICT (tenant_id) DO UPDATE
                SET minimum_stock_threshold = EXCLUDED.minimum_stock_threshold,
                    email_subject_template = EXCLUDED.email_subject_template,
                    updated_at = NOW()
            `;
            return { success: true };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'admin/settings/update error');
            return { success: false };
          }
        }

        ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
        return { error: 'unknown path' };
      }

      // ── WEBHOOK ──────────────────────────────────────────────────────────────
      const { inventory_item_id, location_id, available } = ctx.payload;
      const topic = ctx.payload.__topic || '';

      ctx.logger.info({ trigger: ctx.trigger, inventory_item_id, location_id, available }, 'webhook received');

      // products/delete
      if (ctx.trigger === 'webhook' && ctx.payload.variants !== undefined || (inventory_item_id === undefined && ctx.payload.id !== undefined)) {
        // Detect products/delete by presence of id and absence of inventory fields
        if (inventory_item_id === undefined && ctx.payload.id !== undefined) {
          const deletedProductId = ctx.payload.id;
          ctx.logger.info({ product_id: deletedProductId }, 'products/delete: cleaning up subscriptions');
          await ctx.db`
            UPDATE back_in_stock_subscriptions
            SET status = 'product_deleted'
            WHERE tenant_id = ${ctx.tenantId} AND product_id = ${deletedProductId} AND status = 'active'
          `;
          // Clean up inventory map entries
          await ctx.db`
            DELETE FROM inventory_item_variant_map
            WHERE tenant_id = ${ctx.tenantId} AND product_id = ${deletedProductId}
          `;
          return;
        }
      }

      // inventory_levels/update
      if (inventory_item_id !== undefined) {
        // Get threshold from settings
        const [settings] = await ctx.db`
          SELECT minimum_stock_threshold FROM restock_settings WHERE tenant_id = ${ctx.tenantId}
        `;
        const threshold = settings ? Number(settings.minimum_stock_threshold) : 1;

        const newStockStatus = (available !== null && available >= threshold) ? 'in_stock' : 'out_of_stock';

        // Fetch prior state atomically
        const [priorState] = await ctx.db`
          SELECT stock_status FROM inventory_stock_state
          WHERE tenant_id = ${ctx.tenantId}
            AND inventory_item_id = ${inventory_item_id}
            AND location_id = ${location_id}
        `;

        const prevStatus = priorState ? priorState.stock_status : null;
        ctx.logger.info({ inventory_item_id, location_id, prevStatus, newStockStatus, available }, 'stock state evaluation');

        // Upsert the new state first (idempotent)
        await ctx.db`
          INSERT INTO inventory_stock_state (tenant_id, inventory_item_id, location_id, stock_status, available, updated_at)
          VALUES (${ctx.tenantId}, ${inventory_item_id}, ${location_id}, ${newStockStatus}, ${available}, NOW())
          ON CONFLICT (tenant_id, inventory_item_id, location_id) DO UPDATE
            SET stock_status = EXCLUDED.stock_status,
                available = EXCLUDED.available,
                updated_at = NOW()
        `;

        // If first observation (null), set baseline and skip notifications
        if (prevStatus === null) {
          ctx.logger.info({ inventory_item_id }, 'first observation — baseline set');
          return;
        }

        // Only notify on out_of_stock → in_stock transition
        if (prevStatus !== 'out_of_stock' || newStockStatus !== 'in_stock') {
          ctx.logger.info({ prevStatus, newStockStatus }, 'no restock transition detected');
          return;
        }

        ctx.logger.info({ inventory_item_id, location_id }, 'restock transition detected — dispatching notifications');

        // Resolve all variant/product IDs from the mapping table
        const mappings = await ctx.db`
          SELECT variant_id, product_id FROM inventory_item_variant_map
          WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventory_item_id}
        `;

        if (mappings.length === 0) {
          ctx.logger.warn({ inventory_item_id }, 'no variant mapping found — skipping notification dispatch');
          return;
        }

        // Collect all variant_ids for this inventory_item_id
        const variantIds = mappings.map(m => m.variant_id);

        // Fetch all active subscriptions for all affected variants in one query
        const subscriptions = await ctx.db`
          SELECT id, email, product_id, variant_id, unsubscribe_token
          FROM back_in_stock_subscriptions
          WHERE tenant_id = ${ctx.tenantId}
            AND variant_id = ANY(${variantIds})
            AND status = 'active'
            AND (last_notified_at IS NULL OR last_notified_at < NOW() - INTERVAL '1 hour')
        `;

        if (subscriptions.length === 0) {
          ctx.logger.info({ inventory_item_id }, 'no active subscriptions to notify');
          return;
        }

        // Batch-fetch product info for all affected products
        const productIds = [...new Set(subscriptions.map(s => String(s.product_id)))];
        const productInfoMap = {};
        for (let i = 0; i < productIds.length; i += 250) {
          const chunk = productIds.slice(i, i + 250);
          try {
            const { products } = await ctx.shopify.get(
              `/products.json?ids=${chunk.join(',')}&fields=id,title,handle&limit=250`
            );
            for (const p of (products || [])) {
              productInfoMap[String(p.id)] = { title: p.title, handle: p.handle };
            }
          } catch (shopifyErr) {
            ctx.logger.warn({ err: shopifyErr.message }, 'webhook: failed to batch-fetch products');
          }
        }

        // Deduplicate: one notification per unique (email, product_id) pair
        const notifiedPairs = new Set();

        // Process each subscription
        for (const sub of subscriptions) {
          const pairKey = `${sub.email}::${String(sub.product_id)}`;
          if (notifiedPairs.has(pairKey)) {
            continue; // already notified this email for this product in this run
          }

          const productInfo = productInfoMap[String(sub.product_id)];
          if (!productInfo) {
            ctx.logger.warn({ product_id: sub.product_id, subscription_id: sub.id }, 'product not found — skipping notification');
            continue;
          }

          // Atomically claim this subscription to prevent duplicate sends
          const claimed = await ctx.db`
            UPDATE back_in_stock_subscriptions
            SET last_notified_at = NOW()
            WHERE tenant_id = ${ctx.tenantId}
              AND id = ${sub.id}
              AND status = 'active'
              AND (last_notified_at IS NULL OR last_notified_at < NOW() - INTERVAL '1 hour')
            RETURNING id, email, product_id, variant_id, unsubscribe_token
          `;

          if (claimed.length === 0) {
            ctx.logger.info({ subscription_id: sub.id }, 'subscription already claimed — skip');
            continue;
          }

          const claimedSub = claimed[0];
          const unsubscribeUrl = `https://${ctx.shop.domain}/apps/back-in-stock/unsubscribe?token=${claimedSub.unsubscribe_token}`;
          const productUrl = `https://${ctx.shop.domain}/products/${productInfo.handle}`;

          try {
            await ctx.services.email.send({
              to: claimedSub.email,
              data: {
                productTitle: productInfo.title,
                productUrl,
                variantId: Number(claimedSub.variant_id),
                unsubscribeUrl,
                storeDomain: ctx.shop.domain,
              },
            });

            await ctx.db`
              INSERT INTO notification_log
                (tenant_id, subscription_id, email, variant_id, product_id, notification_type, status, sent_at)
              VALUES
                (${ctx.tenantId}, ${claimedSub.id}, ${claimedSub.email}, ${claimedSub.variant_id}, ${claimedSub.product_id}, 'restock', 'sent', NOW())
            `;

            notifiedPairs.add(pairKey);
            ctx.logger.info({ subscription_id: claimedSub.id, email: claimedSub.email }, 'restock notification sent');
          } catch (emailErr) {
            ctx.logger.error({ subscription_id: claimedSub.id, err: emailErr.message }, 'failed to send restock email');
            // Revert last_notified_at so it can be retried
            await ctx.db`
              UPDATE back_in_stock_subscriptions
              SET last_notified_at = NULL
              WHERE tenant_id = ${ctx.tenantId} AND id = ${claimedSub.id}
            `.catch(() => {});

            await ctx.db`
              INSERT INTO notification_log
                (tenant_id, subscription_id, email, variant_id, product_id, notification_type, status, sent_at)
              VALUES
                (${ctx.tenantId}, ${claimedSub.id}, ${claimedSub.email}, ${claimedSub.variant_id}, ${claimedSub.product_id}, 'restock', 'failed', NOW())
            `.catch(() => {});
          }
        }

        return;
      }

      // products/delete topic (no inventory fields)
      if (ctx.payload.id !== undefined && inventory_item_id === undefined) {
        const deletedProductId = ctx.payload.id;
        ctx.logger.info({ product_id: deletedProductId }, 'products/delete handler');
        await ctx.db`
          UPDATE back_in_stock_subscriptions
          SET status = 'product_deleted'
          WHERE tenant_id = ${ctx.tenantId} AND product_id = ${deletedProductId} AND status = 'active'
        `;
        await ctx.db`
          DELETE FROM inventory_item_variant_map
          WHERE tenant_id = ${ctx.tenantId} AND product_id = ${deletedProductId}
        `;
      }

    } catch (err) {
      ctx.logger.error({ err: err.message, stack: err.stack }, 'handler top-level error');
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE back_in_stock_subscriptions (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL,
  email              TEXT        NOT NULL,
  customer_id        BIGINT      NULL,
  product_id         BIGINT      NOT NULL,
  variant_id         BIGINT      NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'active',
  unsubscribe_token  UUID        NOT NULL DEFAULT gen_random_uuid(),
  last_notified_at   TIMESTAMPTZ NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, email, variant_id)
);

ALTER TABLE back_in_stock_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY back_in_stock_subscriptions_tenant_isolation ON back_in_stock_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX back_in_stock_subscriptions_tenant_id_idx ON back_in_stock_subscriptions (tenant_id);
CREATE INDEX back_in_stock_subscriptions_tenant_id_variant_id_idx ON back_in_stock_subscriptions (tenant_id, variant_id);
CREATE INDEX back_in_stock_subscriptions_tenant_id_product_id_idx ON back_in_stock_subscriptions (tenant_id, product_id);
CREATE INDEX back_in_stock_subscriptions_tenant_id_status_idx ON back_in_stock_subscriptions (tenant_id, status);
CREATE INDEX back_in_stock_subscriptions_unsubscribe_token_idx ON back_in_stock_subscriptions (unsubscribe_token);

CREATE TABLE inventory_item_variant_map (
  id                 UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID   NOT NULL,
  inventory_item_id  BIGINT NOT NULL,
  variant_id         BIGINT NOT NULL,
  product_id         BIGINT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, inventory_item_id)
);

ALTER TABLE inventory_item_variant_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_item_variant_map_tenant_isolation ON inventory_item_variant_map
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX inventory_item_variant_map_tenant_id_inventory_item_id_idx ON inventory_item_variant_map (tenant_id, inventory_item_id);
CREATE INDEX inventory_item_variant_map_tenant_id_variant_id_idx ON inventory_item_variant_map (tenant_id, variant_id);

CREATE TABLE inventory_stock_state (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL,
  inventory_item_id  BIGINT      NOT NULL,
  location_id        BIGINT      NOT NULL,
  stock_status       TEXT        NULL,
  available          INTEGER     NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, inventory_item_id, location_id)
);

ALTER TABLE inventory_stock_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_stock_state_tenant_isolation ON inventory_stock_state
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX inventory_stock_state_tenant_id_inventory_item_id_idx ON inventory_stock_state (tenant_id, inventory_item_id);

CREATE TABLE restock_settings (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID        NOT NULL,
  minimum_stock_threshold   INTEGER     NOT NULL DEFAULT 1,
  email_subject_template    TEXT        NOT NULL DEFAULT 'Your item is back in stock!',
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id)
);

ALTER TABLE restock_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY restock_settings_tenant_isolation ON restock_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX restock_settings_tenant_id_idx ON restock_settings (tenant_id);

CREATE TABLE notification_log (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL,
  subscription_id    UUID        NOT NULL REFERENCES back_in_stock_subscriptions(id) ON DELETE CASCADE,
  email              TEXT        NOT NULL,
  variant_id         BIGINT      NOT NULL,
  product_id         BIGINT      NOT NULL,
  notification_type  TEXT        NOT NULL DEFAULT 'restock',
  status             TEXT        NOT NULL DEFAULT 'sent',
  sent_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_log_tenant_isolation ON notification_log
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX notification_log_tenant_id_idx ON notification_log (tenant_id);
CREATE INDEX notification_log_tenant_id_subscription_id_idx ON notification_log (tenant_id, subscription_id);
CREATE INDEX notification_log_tenant_id_variant_id_idx ON notification_log (tenant_id, variant_id);
CREATE INDEX notification_log_tenant_id_sent_at_idx ON notification_log (tenant_id, sent_at);
```

### widget.js

```javascript
export function mount(container, host) {
  const style = document.createElement('style');
  style.textContent = `
    .ris-widget {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 420px;
      margin: 16px 0;
    }
    .ris-widget * {
      box-sizing: border-box;
    }
    .ris-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .ris-label {
      font-size: 13px;
      font-weight: 600;
      color: #333;
      margin-bottom: 2px;
      display: block;
    }
    .ris-input {
      width: 100%;
      padding: 10px 12px;
      border: 1.5px solid #d0d0d0;
      border-radius: 6px;
      font-size: 14px;
      color: #222;
      outline: none;
      transition: border-color 0.2s;
      background: #fff;
    }
    .ris-input:focus {
      border-color: #4a90e2;
    }
    .ris-input.error {
      border-color: #e05252;
    }
    .ris-btn {
      padding: 10px 18px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, opacity 0.2s;
    }
    .ris-btn-primary {
      background: #222;
      color: #fff;
    }
    .ris-btn-primary:hover:not(:disabled) {
      background: #444;
    }
    .ris-btn-primary:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .ris-btn-unsub {
      background: transparent;
      color: #888;
      border: 1.5px solid #d0d0d0;
      font-size: 13px;
      padding: 7px 14px;
    }
    .ris-btn-unsub:hover:not(:disabled) {
      background: #f5f5f5;
      color: #444;
    }
    .ris-success {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      background: #f0faf4;
      border: 1.5px solid #b2e0c4;
      border-radius: 8px;
      padding: 14px 16px;
    }
    .ris-success-icon {
      font-size: 20px;
      line-height: 1;
      flex-shrink: 0;
    }
    .ris-success-text {
      font-size: 14px;
      color: #1a6636;
      line-height: 1.5;
    }
    .ris-success-text strong {
      display: block;
      margin-bottom: 2px;
    }
    .ris-error-msg {
      font-size: 12px;
      color: #e05252;
      margin-top: 2px;
    }
    .ris-already {
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: #f7f9fc;
      border: 1.5px solid #c8d8f0;
      border-radius: 8px;
      padding: 14px 16px;
    }
    .ris-already-text {
      font-size: 14px;
      color: #2a4a7f;
    }
    .ris-loading {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid #aaa;
      border-top-color: #fff;
      border-radius: 50%;
      animation: ris-spin 0.7s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes ris-spin {
      to { transform: rotate(360deg); }
    }
    .ris-consent {
      font-size: 11px;
      color: #888;
      line-height: 1.4;
    }
    .ris-unsub-done {
      font-size: 14px;
      color: #555;
      background: #f5f5f5;
      border-radius: 8px;
      padding: 12px 16px;
    }
  `;
  container.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.className = 'ris-widget';
  container.appendChild(wrapper);

  let state = {
    loading: true,
    email: '',
    productId: null,
    variantId: null,
    subscribed: false,
    subscriptionToken: null,
    submitted: false,
    unsubDone: false,
    error: '',
    checkingToken: false,
  };

  function render() {
    wrapper.innerHTML = '';

    if (state.loading) {
      const loader = document.createElement('div');
      loader.style.cssText = 'font-size:13px;color:#888;padding:8px 0;';
      loader.textContent = 'Loading…';
      wrapper.appendChild(loader);
      return;
    }

    if (state.unsubDone) {
      const div = document.createElement('div');
      div.className = 'ris-unsub-done';
      div.textContent = "You've been unsubscribed. We won't send you further notifications for this product.";
      wrapper.appendChild(div);
      return;
    }

    if (state.submitted) {
      const div = document.createElement('div');
      div.className = 'ris-success';
      div.innerHTML = `<span class="ris-success-icon">✅</span><div class="ris-success-text"><strong>You're on the list!</strong>You'll be notified when this product is back in stock.</div>`;
      wrapper.appendChild(div);
      return;
    }

    if (state.subscribed) {
      renderAlreadySubscribed();
      return;
    }

    renderForm();
  }

  function renderAlreadySubscribed() {
    const div = document.createElement('div');
    div.className = 'ris-already';

    const text = document.createElement('div');
    text.className = 'ris-already-text';
    text.innerHTML = `<strong>✓ You're subscribed</strong> We'll notify <em>${escapeHtml(state.email)}</em> when this is back in stock.`;
    div.appendChild(text);

    const unsubBtn = document.createElement('button');
    unsubBtn.className = 'ris-btn ris-btn-unsub';
    unsubBtn.textContent = 'Unsubscribe';
    unsubBtn.addEventListener('click', handleUnsubscribe);
    div.appendChild(unsubBtn);

    wrapper.appendChild(div);
  }

  function renderForm() {
    const form = document.createElement('form');
    form.className = 'ris-form';
    form.noValidate = true;

    const label = document.createElement('label');
    label.className = 'ris-label';
    label.textContent = 'Notify me when available';
    form.appendChild(label);

    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.name = 'email';
    emailInput.className = 'ris-input' + (state.error ? ' error' : '');
    emailInput.placeholder = 'Enter your email address';
    emailInput.value = state.email;
    emailInput.autocomplete = 'email';
    emailInput.addEventListener('input', (e) => {
      state.email = e.target.value;
      if (state.error) {
        state.error = '';
        emailInput.classList.remove('error');
        const errEl = form.querySelector('.ris-error-msg');
        if (errEl) errEl.remove();
      }
    });
    form.appendChild(emailInput);

    if (state.error) {
      const errEl = document.createElement('div');
      errEl.className = 'ris-error-msg';
      errEl.textContent = state.error;
      form.appendChild(errEl);
    }

    const consent = document.createElement('div');
    consent.className = 'ris-consent';
    consent.textContent = 'By subscribing you agree to receive a one-time restock email. You can unsubscribe at any time.';
    form.appendChild(consent);

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'ris-btn ris-btn-primary';
    submitBtn.disabled = state.checkingToken;
    if (state.checkingToken) {
      const spinner = document.createElement('span');
      spinner.className = 'ris-loading';
      submitBtn.appendChild(spinner);
      submitBtn.appendChild(document.createTextNode('Subscribing…'));
    } else {
      submitBtn.textContent = 'Notify Me';
    }
    form.appendChild(submitBtn);

    form.addEventListener('submit', handleSubmit);
    wrapper.appendChild(form);
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const email = state.email.trim();
    if (!isValidEmail(email)) {
      state.error = 'Please enter a valid email address.';
      render();
      return;
    }
    if (!state.variantId || !state.productId) {
      state.error = 'Unable to identify this product. Please refresh and try again.';
      render();
      return;
    }

    state.checkingToken = true;
    state.error = '';
    render();

    try {
      const result = await host.call('/subscription/create', {
        email: email,
        product_id: state.productId,
        variant_id: state.variantId,
        customer_id: host.context.customerId ? Number(host.context.customerId) : null,
      });

      if (result.already_subscribed) {
        state.subscribed = true;
        state.checkingToken = false;
        render();
        return;
      }

      if (result.success) {
        state.submitted = true;
        state.checkingToken = false;
        render();
      } else {
        state.error = 'Something went wrong. Please try again.';
        state.checkingToken = false;
        render();
      }
    } catch (err) {
      state.error = 'Unable to subscribe right now. Please try again later.';
      state.checkingToken = false;
      render();
    }
  }

  async function handleUnsubscribe() {
    if (!state.subscriptionToken) {
      state.subscribed = false;
      state.unsubDone = true;
      render();
      return;
    }
    try {
      const result = await host.call('/subscription/unsubscribe', {
        token: state.subscriptionToken,
      });
      if (result.success) {
        state.unsubDone = true;
        render();
      }
    } catch (err) {
      // fallback: just show as done
      state.unsubDone = true;
      render();
    }
  }

  async function init() {
    // Parse product handle and variant from URL
    const pathname = location.pathname;
    const search = location.search;

    const productMatch = pathname.match(/\/products\/([^/?#]+)/);
    if (!productMatch) {
      // Not a product page, don't show widget
      wrapper.innerHTML = '';
      return;
    }
    const handle = productMatch[1];

    // Get variant from query string
    const params = new URLSearchParams(search);
    const variantParam = params.get('variant');

    try {
      const productData = await host.storefront('/products/' + handle + '.js');

      if (!productData || !productData.id) {
        wrapper.innerHTML = '';
        return;
      }

      state.productId = productData.id;

      // Determine variant
      let variant = null;
      if (variantParam) {
        const varId = parseInt(variantParam, 10);
        variant = (productData.variants || []).find(v => v.id === varId) || null;
      }
      if (!variant && productData.variants && productData.variants.length > 0) {
        variant = productData.variants[0];
      }

      if (!variant) {
        wrapper.innerHTML = '';
        return;
      }

      state.variantId = variant.id;

      // Only show widget if variant is out of stock
      if (variant.available) {
        wrapper.innerHTML = '';
        return;
      }

      // Pre-fill email for logged-in customers
      if (host.context.customerId) {
        // Try to check subscription status if we have an email from context
        // We don't have email from context directly, so check after email is typed
        // For logged-in users, we can check status after they type, but we have no email
        // We'll leave email blank and let them fill
        state.email = '';
      }

      state.loading = false;
      render();

    } catch (err) {
      wrapper.innerHTML = '';
    }
  }

  // Check subscription status when email is set and valid
  let statusCheckTimeout = null;
  const originalRenderForm = renderForm;

  // Override email input to check status on blur
  const origRender = render;
  function renderWithStatusCheck() {
    wrapper.innerHTML = '';

    if (state.loading) {
      const loader = document.createElement('div');
      loader.style.cssText = 'font-size:13px;color:#888;padding:8px 0;';
      loader.textContent = 'Loading…';
      wrapper.appendChild(loader);
      return;
    }

    if (state.unsubDone) {
      const div = document.createElement('div');
      div.className = 'ris-unsub-done';
      div.textContent = "You've been unsubscribed. We won't send you further notifications for this product.";
      wrapper.appendChild(div);
      return;
    }

    if (state.submitted) {
      const div = document.createElement('div');
      div.className = 'ris-success';
      div.innerHTML = `<span class="ris-success-icon">✅</span><div class="ris-success-text"><strong>You're on the list!</strong>You'll be notified when this product is back in stock.</div>`;
      wrapper.appendChild(div);
      return;
    }

    if (state.subscribed) {
      renderAlreadySubscribed();
      return;
    }

    // Render form with status-check on email blur
    const form = document.createElement('form');
    form.className = 'ris-form';
    form.noValidate = true;

    const label = document.createElement('label');
    label.className = 'ris-label';
    label.textContent = 'Notify me when available';
    form.appendChild(label);

    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.name = 'email';
    emailInput.className = 'ris-input' + (state.error ? ' error' : '');
    emailInput.placeholder = 'Enter your email address';
    emailInput.value = state.email;
    emailInput.autocomplete = 'email';

    emailInput.addEventListener('input', (e) => {
      state.email = e.target.value;
      if (state.error) {
        state.error = '';
        emailInput.classList.remove('error');
        const errEl = form.querySelector('.ris-error-msg');
        if (errEl) errEl.remove();
      }
      if (statusCheckTimeout) clearTimeout(statusCheckTimeout);
      const val = e.target.value.trim();
      if (isValidEmail(val)) {
        statusCheckTimeout = setTimeout(() => checkStatus(val), 400);
      }
    });

    emailInput.addEventListener('blur', () => {
      const val = emailInput.value.trim();
      if (isValidEmail(val)) {
        checkStatus(val);
      }
    });

    form.appendChild(emailInput);

    if (state.error) {
      const errEl = document.createElement('div');
      errEl.className = 'ris-error-msg';
      errEl.textContent = state.error;
      form.appendChild(errEl);
    }

    const consent = document.createElement('div');
    consent.className = 'ris-consent';
    consent.textContent = 'By subscribing you agree to receive a one-time restock email. You can unsubscribe at any time.';
    form.appendChild(consent);

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'ris-btn ris-btn-primary';
    submitBtn.disabled = state.checkingToken;
    if (state.checkingToken) {
      const spinner = document.createElement('span');
      spinner.className = 'ris-loading';
      submitBtn.appendChild(spinner);
      submitBtn.appendChild(document.createTextNode('Subscribing…'));
    } else {
      submitBtn.textContent = 'Notify Me';
    }
    form.appendChild(submitBtn);

    form.addEventListener('submit', handleSubmit);
    wrapper.appendChild(form);
  }

  async function checkStatus(email) {
    if (!state.variantId) return;
    try {
      const result = await host.call('/subscription/status', {
        email: email,
        variant_id: state.variantId,
      });
      if (result.subscribed) {
        state.subscribed = true;
        state.email = email;
        render();
      }
    } catch (e) {
      // silently ignore status check failures
    }
  }

  // Replace render with status-check-aware version
  render = renderWithStatusCheck;

  init();
}
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  // Inject app-specific styles
  const style = document.createElement('style');
  style.textContent = `
    .tabs-row {
      display: flex;
      gap: var(--p-space-200);
      border-bottom: 1px solid var(--p-color-border);
      margin-bottom: var(--p-space-400);
    }
    .tab-btn {
      background: none;
      border: none;
      border-bottom: 3px solid transparent;
      padding: var(--p-space-300) var(--p-space-400);
      font-size: var(--p-font-size-350);
      font-weight: var(--p-font-weight-medium);
      color: var(--p-color-text-secondary);
      cursor: pointer;
      margin-bottom: -1px;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab-btn:hover { color: var(--p-color-text); }
    .tab-btn.active {
      color: var(--p-color-text);
      border-bottom-color: #008060;
      font-weight: var(--p-font-weight-semibold);
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .product-row-clickable { cursor: pointer; }
    .product-row-clickable:hover td { background: var(--p-color-bg-fill) !important; }
    .bulk-bar {
      display: flex;
      align-items: center;
      gap: var(--p-space-300);
      padding: var(--p-space-300) var(--p-space-400);
      background: var(--p-color-bg-surface-secondary);
      border-radius: var(--p-border-radius-200);
      margin-bottom: var(--p-space-300);
      font-size: var(--p-font-size-350);
    }
    .bulk-bar.hidden { display: none; }
    .check-all-wrap { display: flex; align-items: center; gap: var(--p-space-200); }
    .sub-filter-row {
      display: flex;
      gap: var(--p-space-300);
      margin-bottom: var(--p-space-300);
      flex-wrap: wrap;
      align-items: center;
    }
    .sub-filter-row select, .sub-filter-row input {
      padding: var(--p-space-200) var(--p-space-300);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      font-size: var(--p-font-size-350);
      background: var(--p-color-bg-surface);
      color: var(--p-color-text);
      min-width: 120px;
    }
    .log-filter-row {
      display: flex;
      gap: var(--p-space-300);
      margin-bottom: var(--p-space-300);
      flex-wrap: wrap;
      align-items: center;
    }
    .settings-form {
      max-width: 480px;
      display: flex;
      flex-direction: column;
      gap: var(--p-space-400);
    }
    .settings-field label {
      display: block;
      font-size: var(--p-font-size-350);
      font-weight: var(--p-font-weight-medium);
      color: var(--p-color-text);
      margin-bottom: var(--p-space-100);
    }
    .settings-field input[type=number], .settings-field input[type=text] {
      width: 100%;
      padding: var(--p-space-200) var(--p-space-300);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      font-size: var(--p-font-size-350);
      background: var(--p-color-bg-surface);
      color: var(--p-color-text);
      box-sizing: border-box;
    }
    .settings-field .field-hint {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      margin-top: var(--p-space-100);
    }
    .back-btn {
      background: none;
      border: none;
      color: #008060;
      font-size: var(--p-font-size-350);
      cursor: pointer;
      padding: 0;
      display: flex;
      align-items: center;
      gap: var(--p-space-100);
      margin-bottom: var(--p-space-300);
      font-weight: var(--p-font-weight-medium);
    }
    .back-btn:hover { text-decoration: underline; }
    .product-detail-header {
      margin-bottom: var(--p-space-400);
    }
    .product-detail-header h2 {
      font-size: var(--p-font-size-500);
      font-weight: var(--p-font-weight-bold);
      color: var(--p-color-text);
      margin: 0 0 var(--p-space-100) 0;
    }
    .product-detail-header p {
      margin: 0;
      color: var(--p-color-text-secondary);
      font-size: var(--p-font-size-350);
    }
    .test-btn {
      padding: var(--p-space-100) var(--p-space-300);
      font-size: var(--p-font-size-300);
      background: var(--p-color-bg-surface);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      color: var(--p-color-text);
      cursor: pointer;
      white-space: nowrap;
      font-weight: var(--p-font-weight-medium);
    }
    .test-btn:hover { border-color: var(--p-color-border-emphasis); }
    .test-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .pagination-info {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
    }
    .badge-paused {
      background: var(--p-color-bg-fill-warning);
      color: var(--p-color-text);
      border-radius: var(--p-border-radius-full);
      padding: 2px 8px;
      font-size: var(--p-font-size-300);
      font-weight: var(--p-font-weight-medium);
    }
    .section-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--p-space-400);
    }
  `;
  container.appendChild(style);

  // Set initial HTML skeleton
  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Back in Stock Notifications</span>
      </div>
      <div class="tabs-row">
        <button class="tab-btn active" data-tab="products">Products</button>
        <button class="tab-btn" data-tab="subscriptions">Subscriptions</button>
        <button class="tab-btn" data-tab="log">Notification Log</button>
        <button class="tab-btn" data-tab="settings">Settings</button>
      </div>
      <div id="tab-products" class="tab-panel active"></div>
      <div id="tab-subscriptions" class="tab-panel"></div>
      <div id="tab-log" class="tab-panel"></div>
      <div id="tab-settings" class="tab-panel"></div>
    </div>
  `;
  container.appendChild(style);

  // Tab navigation
  const tabBtns = container.querySelectorAll('.tab-btn');
  const tabPanels = container.querySelectorAll('.tab-panel');

  function switchTab(tabName) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    tabPanels.forEach(p => p.classList.toggle('active', p.id === `tab-${tabName}`));
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
      if (btn.dataset.tab === 'products') loadProductsSummary();
      if (btn.dataset.tab === 'subscriptions') loadSubscriptions();
      if (btn.dataset.tab === 'log') loadNotificationLog();
      if (btn.dataset.tab === 'settings') loadSettings();
    });
  });

  // ─── HELPER UTILITIES ─────────────────────────────────────────────────────

  function formatDate(str) {
    if (!str) return '—';
    const d = new Date(str);
    if (isNaN(d)) return str;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function statusBadge(status) {
    if (status === 'active') return `<span class="badge badge-success">Active</span>`;
    if (status === 'paused') return `<span class="badge-paused">Paused</span>`;
    if (status === 'notified') return `<span class="badge badge-neutral">Notified</span>`;
    if (status === 'sent') return `<span class="badge badge-success">Sent</span>`;
    if (status === 'failed') return `<span class="badge badge-error">Failed</span>`;
    return `<span class="badge badge-neutral">${status}</span>`;
  }

  function showConfirm(title, body, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'shell-confirm-overlay';
    overlay.innerHTML = `
      <div class="shell-confirm-dialog">
        <div class="shell-confirm-title">${title}</div>
        <div class="shell-confirm-body">${body}</div>
        <div class="shell-confirm-actions">
          <button class="btn-secondary" id="confirm-cancel">Cancel</button>
          <button class="btn-danger" id="confirm-ok">Confirm</button>
        </div>
      </div>
    `;
    container.appendChild(overlay);
    overlay.querySelector('#confirm-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#confirm-ok').addEventListener('click', () => { overlay.remove(); onConfirm(); });
  }

  // ─── PRODUCTS SUMMARY TAB ─────────────────────────────────────────────────

  let productPage = 1;
  const productPageSize = 20;
  let productTotal = 0;

  function loadProductsSummary() {
    const panel = container.querySelector('#tab-products');
    panel.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;
    bridge.call('/admin/products/summary', { page: productPage, page_size: productPageSize })
      .then(data => renderProductsSummary(data))
      .catch(err => {
        panel.innerHTML = `<div class="shell-error-banner">Failed to load products: ${err.message || err}</div>`;
      });
  }

  function renderProductsSummary(data) {
    const panel = container.querySelector('#tab-products');
    productTotal = data.total || 0;

    const items = data.items || [];
    const totalSubs = items.reduce((s, i) => s + (i.active_subscriber_count || 0), 0);

    panel.innerHTML = `
      <div class="shell-stats-row">
        <div class="shell-stat-card">
          <div class="shell-stat-label">Products with Subscribers</div>
          <div class="shell-stat-value">${productTotal}</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Active Subscribers (this page)</div>
          <div class="shell-stat-value">${totalSubs}</div>
        </div>
      </div>
      <div class="shell-card">
        <div class="section-title-row">
          <span class="shell-section-title">Products with Active Subscribers</span>
          <button class="btn-secondary" id="refresh-products">Refresh</button>
        </div>
        ${items.length === 0 ? '<div class="shell-empty">No products with active subscribers found.</div>' : `
        <div class="shell-table-wrap">
          <table class="shell-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Active Subscribers</th>
                <th>Last Notification Sent</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(item => `
                <tr class="product-row-clickable" data-product-id="${item.product_id}" data-product-title="${encodeURIComponent(item.product_title)}">
                  <td><strong>${item.product_title}</strong><br><small style="color:var(--p-color-text-secondary)">ID: ${item.product_id}</small></td>
                  <td>${item.active_subscriber_count}</td>
                  <td>${formatDate(item.last_notification_sent_at)}</td>
                  <td>
                    <button class="btn-secondary view-subs-btn" data-product-id="${item.product_id}" data-product-title="${encodeURIComponent(item.product_title)}" style="font-size:var(--p-font-size-300)">View Subscribers</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="shell-pagination">
          <span class="pagination-info">Showing ${items.length} of ${productTotal} products</span>
          <div class="shell-pagination-btns">
            <button class="btn-secondary" id="prod-prev" ${productPage <= 1 ? 'disabled' : ''}>Previous</button>
            <button class="btn-secondary" id="prod-next" ${productPage * productPageSize >= productTotal ? 'disabled' : ''}>Next</button>
          </div>
        </div>
        `}
      </div>
    `;

    panel.querySelector('#refresh-products')?.addEventListener('click', () => { productPage = 1; loadProductsSummary(); });
    panel.querySelector('#prod-prev')?.addEventListener('click', () => { productPage--; loadProductsSummary(); });
    panel.querySelector('#prod-next')?.addEventListener('click', () => { productPage++; loadProductsSummary(); });

    panel.querySelectorAll('.view-subs-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pid = parseInt(btn.dataset.productId);
        const title = decodeURIComponent(btn.dataset.productTitle);
        showProductSubscribers(pid, title);
      });
    });
  }

  // ─── PRODUCT DETAIL: SUBSCRIBERS ─────────────────────────────────────────

  function showProductSubscribers(productId, productTitle) {
    const panel = container.querySelector('#tab-products');
    panel.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;

    let subPage = 1;
    const subPageSize = 50;
    let selectedIds = new Set();

    function loadSubs() {
      bridge.call('/admin/subscriptions', { page: subPage, page_size: subPageSize, product_id: productId, status: null })
        .then(data => renderSubs(data))
        .catch(err => {
          panel.innerHTML = `<div class="shell-error-banner">Failed to load subscribers: ${err.message || err}</div>`;
        });
    }

    function renderSubs(data) {
      const items = data.items || [];
      const total = data.total || 0;

      panel.innerHTML = `
        <button class="back-btn" id="back-to-products">← Back to Products</button>
        <div class="product-detail-header">
          <h2>${productTitle}</h2>
          <p>${total} subscriber(s) for this product</p>
        </div>
        <div class="shell-card">
          <div class="bulk-bar ${selectedIds.size === 0 ? 'hidden' : ''}" id="bulk-bar">
            <span id="bulk-selected-count">${selectedIds.size} selected</span>
            <button class="btn-secondary" id="bulk-pause">Pause</button>
            <button class="btn-secondary" id="bulk-activate">Activate</button>
            <button class="btn-danger" id="bulk-delete">Delete</button>
          </div>
          ${items.length === 0 ? '<div class="shell-empty">No subscribers found for this product.</div>' : `
          <div class="shell-table-wrap">
            <table class="shell-table">
              <thead>
                <tr>
                  <th><input type="checkbox" id="check-all-detail"></th>
                  <th>Email</th>
                  <th>Variant ID</th>
                  <th>Status</th>
                  <th>Last Notified</th>
                  <th>Subscribed</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${items.map(item => `
                  <tr data-id="${item.id}">
                    <td><input type="checkbox" class="row-check" data-id="${item.id}" ${selectedIds.has(item.id) ? 'checked' : ''}></td>
                    <td>${item.email}</td>
                    <td>${item.variant_id}</td>
                    <td>${statusBadge(item.status)}</td>
                    <td>${formatDate(item.last_notified_at)}</td>
                    <td>${formatDate(item.created_at)}</td>
                    <td>
                      <button class="test-btn" data-id="${item.id}" data-email="${item.email}">Send Test</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          <div class="shell-pagination">
            <span class="pagination-info">Page ${subPage} · ${total} total</span>
            <div class="shell-pagination-btns">
              <button class="btn-secondary" id="detail-prev" ${subPage <= 1 ? 'disabled' : ''}>Previous</button>
              <button class="btn-secondary" id="detail-next" ${subPage * subPageSize >= total ? 'disabled' : ''}>Next</button>
            </div>
          </div>
          `}
        </div>
      `;

      panel.querySelector('#back-to-products').addEventListener('click', () => { productPage = 1; loadProductsSummary(); });
      panel.querySelector('#detail-prev')?.addEventListener('click', () => { subPage--; loadSubs(); });
      panel.querySelector('#detail-next')?.addEventListener('click', () => { subPage++; loadSubs(); });

      const checkAll = panel.querySelector('#check-all-detail');
      if (checkAll) {
        checkAll.addEventListener('change', () => {
          panel.querySelectorAll('.row-check').forEach(cb => {
            cb.checked = checkAll.checked;
            if (checkAll.checked) selectedIds.add(cb.dataset.id);
            else selectedIds.delete(cb.dataset.id);
          });
          updateBulkBar();
        });
      }

      panel.querySelectorAll('.row-check').forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.checked) selectedIds.add(cb.dataset.id);
          else selectedIds.delete(cb.dataset.id);
          updateBulkBar();
        });
      });

      function updateBulkBar() {
        const bar = panel.querySelector('#bulk-bar');
        const count = panel.querySelector('#bulk-selected-count');
        if (bar) bar.classList.toggle('hidden', selectedIds.size === 0);
        if (count) count.textContent = `${selectedIds.size} selected`;
      }

      panel.querySelector('#bulk-pause')?.addEventListener('click', () => {
        showConfirm('Pause Subscriptions', `Pause ${selectedIds.size} subscription(s)?`, () => {
          bridge.call('/admin/subscriptions/bulk-update', { ids: Array.from(selectedIds), action: 'pause' })
            .then(r => {
              bridge.notify(`Paused ${r.affected} subscription(s)`, 'success');
              selectedIds.clear();
              loadSubs();
            })
            .catch(err => bridge.notify(`Error: ${err.message || err}`, 'error'));
        });
      });

      panel.querySelector('#bulk-activate')?.addEventListener('click', () => {
        showConfirm('Activate Subscriptions', `Activate ${selectedIds.size} subscription(s)?`, () => {
          bridge.call('/admin/subscriptions/bulk-update', { ids: Array.from(selectedIds), action: 'activate' })
            .then(r => {
              bridge.notify(`Activated ${r.affected} subscription(s)`, 'success');
              selectedIds.clear();
              loadSubs();
            })
            .catch(err => bridge.notify(`Error: ${err.message || err}`, 'error'));
        });
      });

      panel.querySelector('#bulk-delete')?.addEventListener('click', () => {
        showConfirm('Delete Subscriptions', `Permanently delete ${selectedIds.size} subscription(s)? This cannot be undone.`, () => {
          bridge.call('/admin/subscriptions/bulk-delete', { ids: Array.from(selectedIds) })
            .then(r => {
              bridge.notify(`Deleted ${r.deleted} subscription(s)`, 'success');
              selectedIds.clear();
              loadSubs();
            })
            .catch(err => bridge.notify(`Error: ${err.message || err}`, 'error'));
        });
      });

      panel.querySelectorAll('.test-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          const email = btn.dataset.email;
          btn.disabled = true;
          btn.textContent = 'Sending…';
          bridge.call('/admin/subscriptions/test-notification', { subscription_id: id })
            .then(r => {
              if (r.success) bridge.notify(`Test email sent to ${r.email_sent_to}`, 'success');
              else bridge.notify('Test notification failed', 'error');
              btn.disabled = false;
              btn.textContent = 'Send Test';
            })
            .catch(err => {
              bridge.notify(`Error: ${err.message || err}`, 'error');
              btn.disabled = false;
              btn.textContent = 'Send Test';
            });
        });
      });
    }

    loadSubs();
  }

  // ─── SUBSCRIPTIONS TAB ────────────────────────────────────────────────────

  let subTabPage = 1;
  const subTabPageSize = 50;
  let subTabStatus = null;
  let selectedSubIds = new Set();

  function loadSubscriptions() {
    const panel = container.querySelector('#tab-subscriptions');
    panel.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;
    bridge.call('/admin/subscriptions', { page: subTabPage, page_size: subTabPageSize, product_id: null, status: subTabStatus })
      .then(data => renderSubscriptions(data))
      .catch(err => {
        panel.innerHTML = `<div class="shell-error-banner">Failed to load subscriptions: ${err.message || err}</div>`;
      });
  }

  function renderSubscriptions(data) {
    const panel = container.querySelector('#tab-subscriptions');
    const items = data.items || [];
    const total = data.total || 0;

    panel.innerHTML = `
      <div class="shell-card">
        <div class="section-title-row">
          <span class="shell-section-title">All Subscriptions</span>
          <button class="btn-secondary" id="refresh-subs">Refresh</button>
        </div>
        <div class="sub-filter-row">
          <label style="color:var(--p-color-text-secondary);font-size:var(--p-font-size-300)">Status:</label>
          <select id="status-filter">
            <option value="">All</option>
            <option value="active" ${subTabStatus === 'active' ? 'selected' : ''}>Active</option>
            <option value="paused" ${subTabStatus === 'paused' ? 'selected' : ''}>Paused</option>
            <option value="notified" ${subTabStatus === 'notified' ? 'selected' : ''}>Notified</option>
          </select>
        </div>
        <div class="bulk-bar ${selectedSubIds.size === 0 ? 'hidden' : ''}" id="sub-bulk-bar">
          <span id="sub-bulk-count">${selectedSubIds.size} selected</span>
          <button class="btn-secondary" id="sub-bulk-pause">Pause</button>
          <button class="btn-secondary" id="sub-bulk-activate">Activate</button>
          <button class="btn-danger" id="sub-bulk-delete">Delete</button>
        </div>
        ${items.length === 0 ? '<div class="shell-empty">No subscriptions found.</div>' : `
        <div class="shell-table-wrap">
          <table class="shell-table">
            <thead>
              <tr>
                <th><input type="checkbox" id="sub-check-all"></th>
                <th>Email</th>
                <th>Product ID</th>
                <th>Variant ID</th>
                <th>Status</th>
                <th>Last Notified</th>
                <th>Subscribed</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(item => `
                <tr data-id="${item.id}">
                  <td><input type="checkbox" class="sub-row-check" data-id="${item.id}" ${selectedSubIds.has(item.id) ? 'checked' : ''}></td>
                  <td>${item.email}</td>
                  <td>${item.product_id}</td>
                  <td>${item.variant_id}</td>
                  <td>${statusBadge(item.status)}</td>
                  <td>${formatDate(item.last_notified_at)}</td>
                  <td>${formatDate(item.created_at)}</td>
                  <td>
                    <button class="test-btn sub-test-btn" data-id="${item.id}" data-email="${item.email}">Send Test</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="shell-pagination">
          <span class="pagination-info">Page ${subTabPage} · ${total} total</span>
          <div class="shell-pagination-btns">
            <button class="btn-secondary" id="sub-prev" ${subTabPage <= 1 ? 'disabled' : ''}>Previous</button>
            <button class="btn-secondary" id="sub-next" ${subTabPage * subTabPageSize >= total ? 'disabled' : ''}>Next</button>
          </div>
        </div>
        `}
      </div>
    `;

    panel.querySelector('#refresh-subs').addEventListener('click', () => { subTabPage = 1; selectedSubIds.clear(); loadSubscriptions(); });

    panel.querySelector('#status-filter').addEventListener('change', (e) => {
      subTabStatus = e.target.value || null;
      subTabPage = 1;
      selectedSubIds.clear();
      loadSubscriptions();
    });

    panel.querySelector('#sub-prev')?.addEventListener('click', () => { subTabPage--; loadSubscriptions(); });
    panel.querySelector('#sub-next')?.addEventListener('click', () => { subTabPage++; loadSubscriptions(); });

    const checkAll = panel.querySelector('#sub-check-all');
    if (checkAll) {
      checkAll.addEventListener('change', () => {
        panel.querySelectorAll('.sub-row-check').forEach(cb => {
          cb.checked = checkAll.checked;
          if (checkAll.checked) selectedSubIds.add(cb.dataset.id);
          else selectedSubIds.delete(cb.dataset.id);
        });
        updateSubBulkBar();
      });
    }

    panel.querySelectorAll('.sub-row-check').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) selectedSubIds.add(cb.dataset.id);
        else selectedSubIds.delete(cb.dataset.id);
        updateSubBulkBar();
      });
    });

    function updateSubBulkBar() {
      const bar = panel.querySelector('#sub-bulk-bar');
      const count = panel.querySelector('#sub-bulk-count');
      if (bar) bar.classList.toggle('hidden', selectedSubIds.size === 0);
      if (count) count.textContent = `${selectedSubIds.size} selected`;
    }

    panel.querySelector('#sub-bulk-pause')?.addEventListener('click', () => {
      showConfirm('Pause Subscriptions', `Pause ${selectedSubIds.size} subscription(s)?`, () => {
        bridge.call('/admin/subscriptions/bulk-update', { ids: Array.from(selectedSubIds), action: 'pause' })
          .then(r => {
            bridge.notify(`Paused ${r.affected} subscription(s)`, 'success');
            selectedSubIds.clear();
            loadSubscriptions();
          })
          .catch(err => bridge.notify(`Error: ${err.message || err}`, 'error'));
      });
    });

    panel.querySelector('#sub-bulk-activate')?.addEventListener('click', () => {
      showConfirm('Activate Subscriptions', `Activate ${selectedSubIds.size} subscription(s)?`, () => {
        bridge.call('/admin/subscriptions/bulk-update', { ids: Array.from(selectedSubIds), action: 'activate' })
          .then(r => {
            bridge.notify(`Activated ${r.affected} subscription(s)`, 'success');
            selectedSubIds.clear();
            loadSubscriptions();
          })
          .catch(err => bridge.notify(`Error: ${err.message || err}`, 'error'));
      });
    });

    panel.querySelector('#sub-bulk-delete')?.addEventListener('click', () => {
      showConfirm('Delete Subscriptions', `Permanently delete ${selectedSubIds.size} subscription(s)?`, () => {
        bridge.call('/admin/subscriptions/bulk-delete', { ids: Array.from(selectedSubIds) })
          .then(r => {
            bridge.notify(`Deleted ${r.deleted} subscription(s)`, 'success');
            selectedSubIds.clear();
            loadSubscriptions();
          })
          .catch(err => bridge.notify(`Error: ${err.message || err}`, 'error'));
      });
    });

    panel.querySelectorAll('.sub-test-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = 'Sending…';
        bridge.call('/admin/subscriptions/test-notification', { subscription_id: id })
          .then(r => {
            if (r.success) bridge.notify(`Test email sent to ${r.email_sent_to}`, 'success');
            else bridge.notify('Test notification failed', 'error');
            btn.disabled = false;
            btn.textContent = 'Send Test';
          })
          .catch(err => {
            bridge.notify(`Error: ${err.message || err}`, 'error');
            btn.disabled = false;
            btn.textContent = 'Send Test';
          });
      });
    });
  }

  // ─── NOTIFICATION LOG TAB ─────────────────────────────────────────────────

  let logPage = 1;
  const logPageSize = 50;

  function loadNotificationLog() {
    const panel = container.querySelector('#tab-log');
    panel.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;
    bridge.call('/admin/notification-log', { page: logPage, page_size: logPageSize, subscription_id: null })
      .then(data => renderNotificationLog(data))
      .catch(err => {
        panel.innerHTML = `<div class="shell-error-banner">Failed to load notification log: ${err.message || err}</div>`;
      });
  }

  function renderNotificationLog(data) {
    const panel = container.querySelector('#tab-log');
    const items = data.items || [];
    const total = data.total || 0;

    panel.innerHTML = `
      <div class="shell-card">
        <div class="section-title-row">
          <span class="shell-section-title">Notification Log</span>
          <button class="btn-secondary" id="refresh-log">Refresh</button>
        </div>
        ${items.length === 0 ? '<div class="shell-empty">No notification records found.</div>' : `
        <div class="shell-table-wrap">
          <table class="shell-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Product ID</th>
                <th>Variant ID</th>
                <th>Type</th>
                <th>Status</th>
                <th>Sent At</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(item => `
                <tr>
                  <td>${item.email}</td>
                  <td>${item.product_id}</td>
                  <td>${item.variant_id}</td>
                  <td><span class="badge badge-neutral">${item.notification_type}</span></td>
                  <td>${statusBadge(item.status)}</td>
                  <td>${formatDate(item.sent_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="shell-pagination">
          <span class="pagination-info">Page ${logPage} · ${total} total</span>
          <div class="shell-pagination-btns">
            <button class="btn-secondary" id="log-prev" ${logPage <= 1 ? 'disabled' : ''}>Previous</button>
            <button class="btn-secondary" id="log-next" ${logPage * logPageSize >= total ? 'disabled' : ''}>Next</button>
          </div>
        </div>
        `}
      </div>
    `;

    panel.querySelector('#refresh-log').addEventListener('click', () => { logPage = 1; loadNotificationLog(); });
    panel.querySelector('#log-prev')?.addEventListener('click', () => { logPage--; loadNotificationLog(); });
    panel.querySelector('#log-next')?.addEventListener('click', () => { logPage++; loadNotificationLog(); });
  }

  // ─── SETTINGS TAB ─────────────────────────────────────────────────────────

  function loadSettings() {
    const panel = container.querySelector('#tab-settings');
    panel.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;
    bridge.call('/admin/settings', {})
      .then(data => renderSettings(data))
      .catch(err => {
        panel.innerHTML = `<div class="shell-error-banner">Failed to load settings: ${err.message || err}</div>`;
      });
  }

  function renderSettings(data) {
    const panel = container.querySelector('#tab-settings');
    panel.innerHTML = `
      <div class="shell-card">
        <div class="section-title-row">
          <span class="shell-section-title">Settings</span>
        </div>
        <form class="settings-form" id="settings-form">
          <div class="settings-field">
            <label for="min-stock">Minimum Stock Threshold</label>
            <input type="number" id="min-stock" value="${data.minimum_stock_threshold}" min="1" max="10000">
            <div class="field-hint">Minimum inventory quantity before a restock notification is triggered (e.g., set to 5 to avoid notifying on a single item restock).</div>
          </div>
          <div class="settings-field">
            <label for="email-subject">Email Subject Template</label>
            <input type="text" id="email-subject" value="${data.email_subject_template || ''}">
            <div class="field-hint">Subject line for restock notification emails. You can use template variables like <code>{{product_title}}</code>.</div>
          </div>
          <div style="display:flex;gap:var(--p-space-300);align-items:center;">
            <button type="submit" class="btn-primary" id="save-settings">Save Settings</button>
            <span id="settings-status" style="font-size:var(--p-font-size-300);color:var(--p-color-text-success);"></span>
          </div>
        </form>
      </div>
      <div class="shell-card" style="margin-top:var(--p-space-400)">
        <span class="shell-section-title">Backend Notes</span>
        <ul style="color:var(--p-color-text-secondary);font-size:var(--p-font-size-350);margin:var(--p-space-300) 0 0 var(--p-space-400);line-height:1.7;">
          <li>Each subscriber receives an individual email when their subscribed product is restocked above the threshold.</li>
          <li>Unsubscribe links use a stateless token embedded at subscription time — no login required.</li>
          <li>Inventory webhook resolves inventory_item_id to variant/product via a maintained mapping table.</li>
          <li>Duplicate subscriptions are prevented — one subscription per email/product pair.</li>
        </ul>
      </div>
    `;

    const form = panel.querySelector('#settings-form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const threshold = parseInt(panel.querySelector('#min-stock').value);
      const subject = panel.querySelector('#email-subject').value;
      const saveBtn = panel.querySelector('#save-settings');
      const statusEl = panel.querySelector('#settings-status');

      if (!threshold || threshold < 1) {
        bridge.notify('Please enter a valid stock threshold (minimum 1)', 'error');
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      statusEl.textContent = '';

      bridge.call('/admin/settings/update', { minimum_stock_threshold: threshold, email_subject_template: subject })
        .then(r => {
          if (r.success) {
            bridge.notify('Settings saved successfully', 'success');
            statusEl.textContent = 'Saved!';
          } else {
            bridge.notify('Failed to save settings', 'error');
          }
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Settings';
        })
        .catch(err => {
          bridge.notify(`Error saving settings: ${err.message || err}`, 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Settings';
        });
    });
  }

  // ─── INITIAL LOAD ─────────────────────────────────────────────────────────
  loadProductsSummary();
}
```


## Explanation

Your customers can now subscribe to be notified by email when out-of-stock products come back in stock. When a product's inventory increases and reaches the stock level you've set, Shopify automatically sends notification emails to all customers who signed up for that product. Each email includes an unsubscribe link so customers can opt out anytime without needing to log in.

In your Shopify Admin, you'll see a dashboard showing all active subscriptions, how many customers are waiting for each product, and when the last notification was sent. You can set the minimum stock level that triggers a notification (for example, notify when at least 5 units are available), pause or delete subscriptions in bulk, and send yourself a test notification to make sure everything is working. If you delete a product, subscriptions for that product are automatically cleaned up.
