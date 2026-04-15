# Chat Local — Codegen Output

**Date:** 2026-04-09 17:41:04  
**Prompt:** Capture customer back-in-stock subscriptions via a storefront widget, store them in the database, allow merchants to review and manage subscriptions in the admin panel, and send emails when inventory is restored.

## Intent (Product Agent)

```json
{
  "triggerTypes": [
    "widget",
    "webhook",
    "admin"
  ],
  "resources": [
    "Product",
    "Inventory",
    "Customer",
    "Email"
  ],
  "desiredOutcome": "Capture customer back-in-stock subscriptions via a storefront widget, store them in the database, allow merchants to review and manage subscriptions in the admin panel, and send emails when inventory is restored.",
  "cronSchedule": null,
  "appCategory": "storefront_backend_admin"
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
    "stateMachine": {
      "entity": "inventory_level",
      "trackedField": "stock_status",
      "unknownSentinel": "null",
      "skipWhenUnknown": true,
      "transitions": [
        {
          "from": "out_of_stock",
          "to": "in_stock",
          "action": "send_back_in_stock_emails"
        }
      ]
    },
    "platformGaps": [
      {
        "gap": "Shopify inventory_levels/update payload does not include product_id or variant title \u2014 only inventory_item_id and location_id are provided.",
        "mitigation": "Handler must resolve inventory_item_id \u2192 variant_id \u2192 product_id via Shopify Admin REST/GraphQL before querying subscriptions. The resolved product_id and variant_id are stored in the DB so the widget can subscribe by variant_id."
      },
      {
        "gap": "No batch write API for sending emails \u2014 each subscriber requires an individual email dispatch call.",
        "mitigation": "Pre-fetch all active subscriptions for the restocked variant in a single DB query before the loop; per-subscriber email sends inside the loop are unavoidable for this resource type."
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
            "name": "notified_at",
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
          "status"
        ],
        "rls": true
      },
      {
        "table": "inventory_level_states",
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
            "inventory_item_id",
            "location_id"
          ]
        },
        "indexes": [
          "tenant_id",
          "variant_id",
          "inventory_item_id"
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
            "name": "variant_id",
            "type": "BIGINT",
            "constraints": "NOT NULL"
          },
          {
            "name": "email",
            "type": "TEXT",
            "constraints": "NOT NULL"
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
          "subscription_id"
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
      "handlerMustProduce": "Using inventory_item_id from the payload, resolve the associated variant_id and product_id via Shopify Admin API. Derive stock_status as 'in_stock' when available > 0, otherwise 'out_of_stock'. Look up the prior stock_status from inventory_level_states using (tenant_id, inventory_item_id, location_id). If the transition is from 'out_of_stock' to 'in_stock', fetch all active subscriptions for that variant_id and send a back-in-stock notification email to each subscriber, then mark each subscription as notified (set status='notified', notified_at=now()) and insert a row in notification_log. Upsert the new stock_status into inventory_level_states."
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
          "email": "string",
          "product_id": "string",
          "variant_id": "string",
          "customer_id": "string | null"
        },
        "responseShape": {
          "success": "boolean",
          "message": "string",
          "already_subscribed": "boolean"
        }
      },
      {
        "path": "/subscription/status",
        "method": "GET",
        "requestShape": {
          "email": "string",
          "variant_id": "string"
        },
        "responseShape": {
          "subscribed": "boolean",
          "status": "string | null"
        }
      }
    ],
    "adminApiCatalog": [
      {
        "path": "/subscriptions/list",
        "method": "GET",
        "requestShape": {
          "page": "number",
          "page_size": "number",
          "status": "string | null",
          "product_id": "string | null"
        },
        "responseShape": {
          "items": [
            {
              "id": "string",
              "email": "string",
              "customer_id": "string | null",
              "product_id": "string",
              "variant_id": "string",
              "status": "string",
              "notified_at": "string | null",
              "created_at": "string"
            }
          ],
          "total": "number",
          "page": "number",
          "page_size": "number"
        }
      },
      {
        "path": "/subscriptions/delete",
        "method": "POST",
        "requestShape": {
          "id": "string"
        },
        "responseShape": {
          "success": "boolean"
        }
      },
      {
        "path": "/subscriptions/update-status",
        "method": "POST",
        "requestShape": {
          "id": "string",
          "status": "string"
        },
        "responseShape": {
          "success": "boolean",
          "status": "string"
        }
      },
      {
        "path": "/notifications/list",
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
              "variant_id": "string",
              "email": "string",
              "sent_at": "string"
            }
          ],
          "total": "number",
          "page": "number",
          "page_size": "number"
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
  webhookTopics: ['inventory_levels/update'],
  cronSchedule: null,
  npmPackages: [],
  handler: async function(ctx) {
    try {
      if (ctx.trigger === 'widget') {
        if (ctx.widgetPath === '/subscribe') {
          const { email, product_id, variant_id, customer_id } = ctx.widgetBody;
          if (!email || !product_id || !variant_id) {
            return { success: false, message: 'Missing required fields', already_subscribed: false };
          }
          // Check for existing active subscription
          const existing = await ctx.db`
            SELECT id, status FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND email = ${email}
              AND variant_id = ${variant_id}
              AND status = 'active'
            LIMIT 1
          `;
          if (existing.length > 0) {
            return { success: true, message: 'Already subscribed', already_subscribed: true };
          }
          await ctx.db`
            INSERT INTO back_in_stock_subscriptions
              (tenant_id, customer_id, email, product_id, variant_id, status, created_at)
            VALUES
              (${ctx.tenantId}, ${customer_id || null}, ${email}, ${product_id}, ${variant_id}, 'active', NOW())
            ON CONFLICT (tenant_id, email, variant_id) DO UPDATE SET status = 'active', notified_at = NULL
          `;
          return { success: true, message: 'Subscribed successfully', already_subscribed: false };
        }

        if (ctx.widgetPath === '/subscription/status') {
          const { email, variant_id } = ctx.widgetBody;
          if (!email || !variant_id) {
            return { subscribed: false, status: null };
          }
          const rows = await ctx.db`
            SELECT status FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND email = ${email}
              AND variant_id = ${variant_id}
            ORDER BY created_at DESC
            LIMIT 1
          `;
          if (rows.length === 0) {
            return { subscribed: false, status: null };
          }
          return { subscribed: true, status: rows[0].status };
        }

        return { error: 'unknown path' };
      }

      if (ctx.trigger === 'admin') {
        ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

        if (ctx.adminPath === '/subscriptions/list') {
          const { page = 1, page_size = 20, status = null, product_id = null } = ctx.adminBody;
          const offset = (page - 1) * page_size;

          let items, countRows;
          if (status && product_id) {
            items = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, status, notified_at, created_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
                AND status = ${status}
                AND product_id = ${product_id}
              ORDER BY created_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) as total
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
                AND status = ${status}
                AND product_id = ${product_id}
            `;
          } else if (status) {
            items = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, status, notified_at, created_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
                AND status = ${status}
              ORDER BY created_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) as total
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
                AND status = ${status}
            `;
          } else if (product_id) {
            items = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, status, notified_at, created_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
                AND product_id = ${product_id}
              ORDER BY created_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) as total
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
                AND product_id = ${product_id}
            `;
          } else {
            items = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, status, notified_at, created_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
              ORDER BY created_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) as total
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
            `;
          }

          const total = parseInt(countRows[0].total, 10);
          return {
            items: items.map(r => ({
              id: String(r.id),
              email: r.email,
              customer_id: r.customer_id ? String(r.customer_id) : null,
              product_id: String(r.product_id),
              variant_id: String(r.variant_id),
              status: r.status,
              notified_at: r.notified_at ? r.notified_at.toISOString() : null,
              created_at: r.created_at ? r.created_at.toISOString() : String(r.created_at)
            })),
            total,
            page,
            page_size
          };
        }

        if (ctx.adminPath === '/subscriptions/delete') {
          const { id } = ctx.adminBody;
          if (!id) return { success: false };
          await ctx.db`
            DELETE FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
          `;
          ctx.logger.info({ id }, 'admin: subscription deleted');
          return { success: true };
        }

        if (ctx.adminPath === '/subscriptions/update-status') {
          const { id, status } = ctx.adminBody;
          if (!id || !status) return { success: false, status: null };
          const updated = await ctx.db`
            UPDATE back_in_stock_subscriptions
            SET status = ${status}
            WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
            RETURNING status
          `;
          if (updated.length === 0) return { success: false, status: null };
          ctx.logger.info({ id, status }, 'admin: subscription status updated');
          return { success: true, status: updated[0].status };
        }

        if (ctx.adminPath === '/notifications/list') {
          const { page = 1, page_size = 20, subscription_id = null } = ctx.adminBody;
          const offset = (page - 1) * page_size;

          let items, countRows;
          if (subscription_id) {
            items = await ctx.db`
              SELECT id, subscription_id, variant_id, email, sent_at
              FROM notification_log
              WHERE tenant_id = ${ctx.tenantId}
                AND subscription_id = ${subscription_id}
              ORDER BY sent_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) as total
              FROM notification_log
              WHERE tenant_id = ${ctx.tenantId}
                AND subscription_id = ${subscription_id}
            `;
          } else {
            items = await ctx.db`
              SELECT id, subscription_id, variant_id, email, sent_at
              FROM notification_log
              WHERE tenant_id = ${ctx.tenantId}
              ORDER BY sent_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) as total
              FROM notification_log
              WHERE tenant_id = ${ctx.tenantId}
            `;
          }

          const total = parseInt(countRows[0].total, 10);
          return {
            items: items.map(r => ({
              id: String(r.id),
              subscription_id: String(r.subscription_id),
              variant_id: String(r.variant_id),
              email: r.email,
              sent_at: r.sent_at ? r.sent_at.toISOString() : String(r.sent_at)
            })),
            total,
            page,
            page_size
          };
        }

        ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
        return { error: 'unknown path' };
      }

      // Webhook: inventory_levels/update
      const { inventory_item_id, location_id, available } = ctx.payload;
      ctx.logger.info({ trigger: ctx.trigger, inventory_item_id, location_id, available }, 'webhook received');

      const currentStatus = available > 0 ? 'in_stock' : 'out_of_stock';

      // Resolve variant and product from inventory_item_id
      const variantData = await ctx.shopify.get(
        `/variants.json?inventory_item_ids=${inventory_item_id}&fields=id,product_id,title,inventory_item_id`
      );
      const variants = variantData.variants;
      if (!variants || variants.length === 0) {
        ctx.logger.warn({ inventory_item_id }, 'No variant found for inventory_item_id — skipping');
        return;
      }
      const variant = variants[0];
      const variantId = variant.id;
      const productId = variant.product_id;

      // Look up prior state
      const priorRows = await ctx.db`
        SELECT stock_status FROM inventory_level_states
        WHERE tenant_id = ${ctx.tenantId}
          AND inventory_item_id = ${inventory_item_id}
          AND location_id = ${location_id}
        LIMIT 1
      `;
      const prevState = priorRows.length > 0 ? priorRows[0].stock_status : null;

      ctx.logger.info({ prevState, currentStatus, inventory_item_id, variantId }, 'state transition check');

      // Upsert inventory level state
      await ctx.db`
        INSERT INTO inventory_level_states
          (tenant_id, inventory_item_id, location_id, variant_id, product_id, stock_status, updated_at)
        VALUES
          (${ctx.tenantId}, ${inventory_item_id}, ${location_id}, ${variantId}, ${productId}, ${currentStatus}, NOW())
        ON CONFLICT (tenant_id, inventory_item_id, location_id)
        DO UPDATE SET stock_status = ${currentStatus}, variant_id = ${variantId}, product_id = ${productId}, updated_at = NOW()
      `;

      const isRestocked = prevState !== null && prevState === 'out_of_stock' && currentStatus === 'in_stock';
      if (!isRestocked) {
        ctx.logger.info({ prevState, currentStatus }, 'No out_of_stock→in_stock transition — done');
        return;
      }

      ctx.logger.info({ variantId, productId }, 'Restock detected — fetching active subscriptions');

      // Fetch all active subscriptions for this variant
      const subscriptions = await ctx.db`
        SELECT id, email, customer_id
        FROM back_in_stock_subscriptions
        WHERE tenant_id = ${ctx.tenantId}
          AND variant_id = ${String(variantId)}
          AND status = 'active'
      `;

      if (subscriptions.length === 0) {
        ctx.logger.info({ variantId }, 'No active subscriptions for restocked variant');
        return;
      }

      const subscriptionIds = subscriptions.map(s => s.id);

      // Atomically claim subscriptions for notification
      const claimed = await ctx.db`
        UPDATE back_in_stock_subscriptions
        SET status = 'notified', notified_at = NOW()
        WHERE tenant_id = ${ctx.tenantId}
          AND id = ANY(${subscriptionIds})
          AND status = 'active'
        RETURNING id, email, customer_id
      `;

      if (claimed.length === 0) {
        ctx.logger.info({ variantId }, 'No subscriptions claimed — already processed');
        return;
      }

      ctx.logger.info({ count: claimed.length, variantId }, 'Claimed subscriptions — sending notifications');

      // Fetch product title for email
      let productTitle = String(productId);
      let variantTitle = variant.title || '';
      try {
        const productData = await ctx.shopify.get(`/products/${productId}.json?fields=id,title`);
        if (productData && productData.product) {
          productTitle = productData.product.title;
        }
      } catch (err) {
        ctx.logger.warn({ productId, err: err.message }, 'Could not fetch product title');
      }

      // Send emails and insert notification log entries
      for (const sub of claimed) {
        try {
          await ctx.services.email.send({
            to: sub.email,
            subject: `${productTitle} is back in stock!`,
            data: {
              productTitle,
              variantTitle,
              productId: String(productId),
              variantId: String(variantId)
            }
          });
        } catch (err) {
          ctx.logger.error({ email: sub.email, err: err.message }, 'Failed to send back-in-stock email');
        }

        try {
          await ctx.db`
            INSERT INTO notification_log
              (tenant_id, subscription_id, variant_id, email, sent_at)
            VALUES
              (${ctx.tenantId}, ${sub.id}, ${String(variantId)}, ${sub.email}, NOW())
          `;
        } catch (err) {
          ctx.logger.error({ subscriptionId: sub.id, err: err.message }, 'Failed to insert notification_log');
        }
      }

      ctx.logger.info({ count: claimed.length, variantId }, 'Back-in-stock notifications sent');

    } catch (err) {
      ctx.logger.error({ err: err.message, stack: err.stack }, 'Handler error');
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE back_in_stock_subscriptions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL,
  customer_id BIGINT      NULL,
  email       TEXT        NOT NULL,
  product_id  BIGINT      NOT NULL,
  variant_id  BIGINT      NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'active',
  notified_at TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, email, variant_id)
);

ALTER TABLE back_in_stock_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY back_in_stock_subscriptions_tenant_isolation ON back_in_stock_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX back_in_stock_subscriptions_tenant_id_idx  ON back_in_stock_subscriptions (tenant_id);
CREATE INDEX back_in_stock_subscriptions_variant_id_idx ON back_in_stock_subscriptions (tenant_id, variant_id);
CREATE INDEX back_in_stock_subscriptions_status_idx     ON back_in_stock_subscriptions (tenant_id, status);

CREATE TABLE inventory_level_states (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL,
  inventory_item_id BIGINT      NOT NULL,
  location_id       BIGINT      NOT NULL,
  variant_id        BIGINT      NOT NULL,
  product_id        BIGINT      NOT NULL,
  stock_status      TEXT        NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, inventory_item_id, location_id)
);

ALTER TABLE inventory_level_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_level_states_tenant_isolation ON inventory_level_states
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX inventory_level_states_tenant_id_idx         ON inventory_level_states (tenant_id);
CREATE INDEX inventory_level_states_variant_id_idx        ON inventory_level_states (tenant_id, variant_id);
CREATE INDEX inventory_level_states_inventory_item_id_idx ON inventory_level_states (tenant_id, inventory_item_id);

CREATE TABLE notification_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
  subscription_id UUID        NOT NULL REFERENCES back_in_stock_subscriptions(id) ON DELETE CASCADE,
  variant_id      BIGINT      NOT NULL,
  email           TEXT        NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_log_tenant_isolation ON notification_log
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX notification_log_tenant_id_idx       ON notification_log (tenant_id);
CREATE INDEX notification_log_subscription_id_idx ON notification_log (tenant_id, subscription_id);
```

### widget.js

```javascript
export function mount(container, host) {
  const styles = `
    .bis-widget {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
      max-width: 480px;
      margin: 0 auto;
      padding: 16px;
      box-sizing: border-box;
    }
    .bis-widget * {
      box-sizing: border-box;
    }
    .bis-title {
      font-size: 15px;
      font-weight: 600;
      color: #1a1a1a;
      margin: 0 0 8px 0;
    }
    .bis-description {
      font-size: 13px;
      color: #555;
      margin: 0 0 12px 0;
    }
    .bis-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .bis-input {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid #ccc;
      border-radius: 6px;
      font-size: 14px;
      color: #1a1a1a;
      background: #fff;
      outline: none;
      transition: border-color 0.2s;
    }
    .bis-input:focus {
      border-color: #5c6ac4;
    }
    .bis-input.error {
      border-color: #d9534f;
    }
    .bis-button {
      width: 100%;
      padding: 11px 16px;
      background: #5c6ac4;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, opacity 0.2s;
    }
    .bis-button:hover:not(:disabled) {
      background: #4959bd;
    }
    .bis-button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .bis-message {
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 13px;
      line-height: 1.5;
    }
    .bis-message.success {
      background: #e6f4ea;
      color: #256029;
      border: 1px solid #b7dfbd;
    }
    .bis-message.error {
      background: #fdf2f2;
      color: #9b2c2c;
      border: 1px solid #f5c6c6;
    }
    .bis-message.info {
      background: #edf2ff;
      color: #2d3a8c;
      border: 1px solid #c5cfff;
    }
    .bis-loader {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #777;
      padding: 8px 0;
    }
    .bis-spinner {
      width: 16px;
      height: 16px;
      border: 2px solid #ccc;
      border-top-color: #5c6ac4;
      border-radius: 50%;
      animation: bis-spin 0.7s linear infinite;
    }
    @keyframes bis-spin {
      to { transform: rotate(360deg); }
    }
    .bis-already {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #256029;
    }
    .bis-checkmark {
      display: inline-block;
      width: 18px;
      height: 18px;
      background: #256029;
      border-radius: 50%;
      position: relative;
      flex-shrink: 0;
    }
    .bis-checkmark::after {
      content: '';
      position: absolute;
      left: 4px;
      top: 2px;
      width: 5px;
      height: 9px;
      border: 2px solid #fff;
      border-top: none;
      border-left: none;
      transform: rotate(45deg);
    }
    .bis-variant-select {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid #ccc;
      border-radius: 6px;
      font-size: 14px;
      color: #1a1a1a;
      background: #fff;
      outline: none;
      cursor: pointer;
    }
    .bis-variant-info {
      font-size: 12px;
      color: #777;
      margin-top: 2px;
    }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = styles;
  container.appendChild(styleEl);

  const root = document.createElement('div');
  root.className = 'bis-widget';
  container.appendChild(root);

  let state = {
    loading: true,
    product: null,
    selectedVariant: null,
    unavailableVariants: [],
    subscriptionStatus: null,
    submitting: false,
    submitted: false,
    error: null,
    emailValue: '',
    alreadySubscribed: false,
  };

  function render() {
    root.innerHTML = '';

    if (state.loading) {
      const loader = document.createElement('div');
      loader.className = 'bis-loader';
      loader.innerHTML = '<div class="bis-spinner"></div><span>Loading...</span>';
      root.appendChild(loader);
      return;
    }

    if (!state.product) {
      return;
    }

    const { unavailableVariants, selectedVariant } = state;

    if (!unavailableVariants || unavailableVariants.length === 0) {
      return;
    }

    const currentVariantUnavailable = selectedVariant && unavailableVariants.find(v => v.id === selectedVariant.id);
    if (!currentVariantUnavailable) {
      return;
    }

    const title = document.createElement('p');
    title.className = 'bis-title';
    title.textContent = 'Notify me when available';
    root.appendChild(title);

    const desc = document.createElement('p');
    desc.className = 'bis-description';
    desc.textContent = 'This item is currently out of stock. Enter your email to be notified when it becomes available.';
    root.appendChild(desc);

    if (unavailableVariants.length > 1) {
      const variantLabel = document.createElement('label');
      variantLabel.setAttribute('for', 'bis-variant-select');
      variantLabel.style.cssText = 'font-size:13px;font-weight:500;color:#333;margin-bottom:2px;display:block;';
      variantLabel.textContent = 'Variant:';
      root.appendChild(variantLabel);

      const select = document.createElement('select');
      select.className = 'bis-variant-select';
      select.id = 'bis-variant-select';

      unavailableVariants.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.title;
        if (selectedVariant && v.id === selectedVariant.id) {
          opt.selected = true;
        }
        select.appendChild(opt);
      });

      select.addEventListener('change', () => {
        const chosen = unavailableVariants.find(v => String(v.id) === String(select.value));
        state.selectedVariant = chosen || null;
        state.subscriptionStatus = null;
        state.submitted = false;
        state.alreadySubscribed = false;
        state.error = null;
        if (state.emailValue) {
          checkSubscriptionStatus(state.emailValue, chosen);
        } else {
          render();
        }
      });

      root.appendChild(select);

      const variantHint = document.createElement('p');
      variantHint.className = 'bis-variant-info';
      variantHint.textContent = 'Only out-of-stock variants are shown.';
      root.appendChild(variantHint);
    }

    if (state.alreadySubscribed || (state.subscriptionStatus && state.subscriptionStatus.subscribed)) {
      const alreadyEl = document.createElement('div');
      alreadyEl.className = 'bis-message info';
      alreadyEl.innerHTML = '<span>&#10003; You\'re already subscribed for this variant. We\'ll notify you when it\'s back!</span>';
      root.appendChild(alreadyEl);
      return;
    }

    if (state.submitted) {
      const successEl = document.createElement('div');
      successEl.className = 'bis-message success';
      successEl.textContent = "You're on the list! We'll email you when this item is back in stock.";
      root.appendChild(successEl);
      return;
    }

    const form = document.createElement('form');
    form.className = 'bis-form';
    form.id = 'bis-form';

    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.name = 'email';
    emailInput.className = 'bis-input' + (state.error ? ' error' : '');
    emailInput.placeholder = 'Enter your email address';
    emailInput.value = state.emailValue || '';
    emailInput.required = true;
    emailInput.setAttribute('autocomplete', 'email');

    emailInput.addEventListener('input', () => {
      state.emailValue = emailInput.value;
    });

    emailInput.addEventListener('blur', () => {
      const email = emailInput.value.trim();
      if (email && isValidEmail(email) && state.selectedVariant) {
        checkSubscriptionStatus(email, state.selectedVariant);
      }
    });

    form.appendChild(emailInput);

    if (state.error) {
      const errEl = document.createElement('div');
      errEl.className = 'bis-message error';
      errEl.textContent = state.error;
      form.appendChild(errEl);
    }

    const button = document.createElement('button');
    button.type = 'submit';
    button.className = 'bis-button';
    button.disabled = state.submitting;
    button.textContent = state.submitting ? 'Subscribing...' : 'Notify Me';
    form.appendChild(button);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = host.getFormData(form);
      const email = (formData.email || '').trim();

      if (!isValidEmail(email)) {
        state.error = 'Please enter a valid email address.';
        render();
        return;
      }

      if (!state.selectedVariant) {
        state.error = 'No variant selected.';
        render();
        return;
      }

      state.submitting = true;
      state.error = null;
      state.emailValue = email;
      render();

      try {
        const result = await host.call('/subscribe', {
          email: email,
          product_id: String(state.product.id),
          variant_id: String(state.selectedVariant.id),
          customer_id: host.context.customerId || null,
        });

        if (result.already_subscribed) {
          state.alreadySubscribed = true;
          state.submitting = false;
          render();
        } else if (result.success) {
          state.submitted = true;
          state.submitting = false;
          render();
        } else {
          state.error = result.message || 'Something went wrong. Please try again.';
          state.submitting = false;
          render();
        }
      } catch (err) {
        state.error = 'Unable to subscribe at this time. Please try again later.';
        state.submitting = false;
        render();
      }
    });

    root.appendChild(form);
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  async function checkSubscriptionStatus(email, variant) {
    if (!email || !variant) return;
    try {
      const status = await host.call('/subscription/status', {
        email: email,
        variant_id: String(variant.id),
      });
      state.subscriptionStatus = status;
      render();
    } catch (e) {
      // silently ignore status check errors
    }
  }

  async function init() {
    const pathname = location.pathname;
    const search = location.search;

    const productMatch = pathname.match(/\/products\/([^/?#]+)/);
    if (!productMatch) {
      state.loading = false;
      render();
      return;
    }

    const handle = productMatch[1];

    let variantIdFromUrl = null;
    if (search) {
      const params = new URLSearchParams(search);
      variantIdFromUrl = params.get('variant');
    }

    try {
      const product = await host.storefront('/products/' + handle + '.js');
      state.product = product;

      const variants = product.variants || [];
      const unavailable = variants.filter(v => !v.available);
      state.unavailableVariants = unavailable;

      if (unavailable.length === 0) {
        state.loading = false;
        render();
        return;
      }

      if (variantIdFromUrl) {
        const matched = unavailable.find(v => String(v.id) === String(variantIdFromUrl));
        state.selectedVariant = matched || unavailable[0];
      } else {
        const allVariants = variants;
        const currentUnavailable = allVariants.find(v => !v.available);
        state.selectedVariant = currentUnavailable || unavailable[0];
      }

      if (host.context.customerId) {
        // prefill could be attempted here, but we don't have email from context
      }

      state.loading = false;
      render();
    } catch (err) {
      state.loading = false;
      render();
    }
  }

  init();
}
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  const style = document.createElement('style');
  style.textContent = `
    .tabs {
      display: flex;
      gap: var(--p-space-200);
      border-bottom: 1px solid var(--p-color-border);
      margin-bottom: var(--p-space-400);
    }
    .tab-btn {
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      padding: var(--p-space-200) var(--p-space-400);
      font-size: var(--p-font-size-350);
      font-weight: var(--p-font-weight-medium);
      color: var(--p-color-text-secondary);
      cursor: pointer;
      margin-bottom: -1px;
    }
    .tab-btn.active {
      color: var(--p-color-text);
      border-bottom-color: #008060;
    }
    .tab-btn:hover:not(.active) {
      color: var(--p-color-text);
      background: var(--p-color-bg-fill);
      border-radius: var(--p-border-radius-100) var(--p-border-radius-100) 0 0;
    }
    .filter-row {
      display: flex;
      gap: var(--p-space-200);
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: var(--p-space-400);
    }
    .filter-row select, .filter-row input {
      background: var(--p-color-bg-surface);
      color: var(--p-color-text);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      padding: var(--p-space-200) var(--p-space-300);
      font-size: var(--p-font-size-350);
      min-width: 160px;
    }
    .filter-row select:focus, .filter-row input:focus {
      outline: 2px solid #008060;
      outline-offset: 1px;
    }
    .stats-note {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      margin-left: auto;
    }
    .action-cell {
      display: flex;
      gap: var(--p-space-100);
      align-items: center;
    }
    .btn-xs {
      background: var(--p-color-bg-surface);
      color: var(--p-color-text);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      padding: 2px var(--p-space-200);
      font-size: var(--p-font-size-300);
      cursor: pointer;
      white-space: nowrap;
    }
    .btn-xs:hover {
      background: var(--p-color-bg-fill);
    }
    .btn-xs-danger {
      color: var(--p-color-text-critical);
      border-color: var(--p-color-text-critical);
    }
    .btn-xs-danger:hover {
      background: var(--p-color-bg-fill-critical);
    }
    .limitation-banner {
      background: var(--p-color-bg-fill-warning);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-200);
      padding: var(--p-space-300) var(--p-space-400);
      font-size: var(--p-font-size-300);
      color: var(--p-color-text);
      margin-bottom: var(--p-space-400);
    }
    .limitation-banner strong {
      font-weight: var(--p-font-weight-semibold);
    }
    .limitation-banner ul {
      margin: var(--p-space-100) 0 0 var(--p-space-400);
      padding: 0;
    }
    .limitation-banner li {
      margin-bottom: var(--p-space-100);
    }
    .truncate {
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: inline-block;
      vertical-align: middle;
    }
    .id-chip {
      font-family: monospace;
      font-size: var(--p-font-size-300);
      background: var(--p-color-bg-surface-secondary);
      border-radius: var(--p-border-radius-100);
      padding: 1px var(--p-space-100);
    }
    .notif-email {
      font-size: var(--p-font-size-350);
      color: var(--p-color-text);
    }
  `;

  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Back-in-Stock Subscriptions</span>
        <button class="btn-secondary" id="refresh-btn" style="margin-left:auto">Refresh</button>
      </div>

      <div class="limitation-banner">
        <strong>ℹ️ System Notes:</strong>
        <ul>
          <li>Inventory webhooks do not include product/variant info — the backend resolves inventory_item_id → variant_id → product_id automatically before notifying subscribers.</li>
          <li>Email notifications are sent individually per subscriber (no batch API available). Large restock events may take a moment to process.</li>
        </ul>
      </div>

      <div class="shell-stats-row" id="stats-row">
        <div class="shell-stat-card"><div class="shell-stat-label">Total Subscriptions</div><div class="shell-stat-value" id="stat-total">—</div></div>
        <div class="shell-stat-card"><div class="shell-stat-label">Active</div><div class="shell-stat-value" id="stat-active">—</div></div>
        <div class="shell-stat-card"><div class="shell-stat-label">Notified</div><div class="shell-stat-value" id="stat-notified">—</div></div>
        <div class="shell-stat-card"><div class="shell-stat-label">Total Notifications Sent</div><div class="shell-stat-value" id="stat-notifications">—</div></div>
      </div>

      <div class="shell-card" style="margin-top: var(--p-space-400)">
        <div class="tabs">
          <button class="tab-btn active" data-tab="subscriptions">Subscriptions</button>
          <button class="tab-btn" data-tab="notifications">Notification Log</button>
        </div>

        <div id="tab-subscriptions">
          <div class="filter-row">
            <select id="filter-status">
              <option value="">All Statuses</option>
              <option value="active">Active</option>
              <option value="notified">Notified</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <input type="text" id="filter-product" placeholder="Filter by Product ID" />
            <button class="btn-secondary" id="apply-filter-btn">Apply</button>
            <span class="stats-note" id="sub-count-note"></span>
          </div>
          <div id="sub-loading" class="shell-loading" style="display:none"><div class="shell-spinner"></div></div>
          <div id="sub-error" class="shell-error-banner" style="display:none"></div>
          <div id="sub-empty" class="shell-empty" style="display:none">No subscriptions found.</div>
          <div class="shell-table-wrap" id="sub-table-wrap" style="display:none">
            <table class="shell-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Product ID</th>
                  <th>Variant ID</th>
                  <th>Status</th>
                  <th>Notified At</th>
                  <th>Created At</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="sub-tbody"></tbody>
            </table>
          </div>
          <div class="shell-pagination" id="sub-pagination" style="display:none">
            <span id="sub-page-info" style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary)"></span>
            <div class="shell-pagination-btns">
              <button class="btn-secondary" id="sub-prev-btn">Previous</button>
              <button class="btn-secondary" id="sub-next-btn">Next</button>
            </div>
          </div>
        </div>

        <div id="tab-notifications" style="display:none">
          <div class="filter-row">
            <span class="stats-note" id="notif-count-note"></span>
          </div>
          <div id="notif-loading" class="shell-loading" style="display:none"><div class="shell-spinner"></div></div>
          <div id="notif-error" class="shell-error-banner" style="display:none"></div>
          <div id="notif-empty" class="shell-empty" style="display:none">No notifications sent yet.</div>
          <div class="shell-table-wrap" id="notif-table-wrap" style="display:none">
            <table class="shell-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Variant ID</th>
                  <th>Subscription ID</th>
                  <th>Sent At</th>
                </tr>
              </thead>
              <tbody id="notif-tbody"></tbody>
            </table>
          </div>
          <div class="shell-pagination" id="notif-pagination" style="display:none">
            <span id="notif-page-info" style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary)"></span>
            <div class="shell-pagination-btns">
              <button class="btn-secondary" id="notif-prev-btn">Previous</button>
              <button class="btn-secondary" id="notif-next-btn">Next</button>
            </div>
          </div>
        </div>
      </div>

      <div class="shell-confirm-overlay" id="confirm-overlay" style="display:none">
        <div class="shell-confirm-dialog">
          <div class="shell-confirm-title" id="confirm-title">Confirm Action</div>
          <div class="shell-confirm-body" id="confirm-body"></div>
          <div class="shell-confirm-actions">
            <button class="btn-secondary" id="confirm-cancel">Cancel</button>
            <button class="btn-danger" id="confirm-ok">Confirm</button>
          </div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(style);

  const PAGE_SIZE = 20;

  let subState = { page: 1, total: 0, status: null, productId: null, loading: false };
  let notifState = { page: 1, total: 0, loading: false };
  let activeTab = 'subscriptions';

  let confirmResolve = null;

  function showConfirm(title, body) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      container.querySelector('#confirm-title').textContent = title;
      container.querySelector('#confirm-body').textContent = body;
      container.querySelector('#confirm-overlay').style.display = 'flex';
    });
  }

  container.querySelector('#confirm-cancel').addEventListener('click', () => {
    container.querySelector('#confirm-overlay').style.display = 'none';
    if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
  });

  container.querySelector('#confirm-ok').addEventListener('click', () => {
    container.querySelector('#confirm-overlay').style.display = 'none';
    if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
  });

  function formatDate(str) {
    if (!str) return '—';
    try {
      return new Date(str).toLocaleString();
    } catch(e) { return str; }
  }

  function statusBadge(status) {
    const map = {
      active: 'badge-success',
      notified: 'badge-neutral',
      cancelled: 'badge-warning',
    };
    const cls = map[status] || 'badge-neutral';
    return `<span class="badge ${cls}">${status}</span>`;
  }

  async function loadStats() {
    try {
      const [subRes, notifRes] = await Promise.all([
        bridge.call('/subscriptions/list', { page: 1, page_size: 1, status: null, product_id: null }),
        bridge.call('/notifications/list', { page: 1, page_size: 1, subscription_id: null }),
      ]);
      const [activeRes, notifiedRes] = await Promise.all([
        bridge.call('/subscriptions/list', { page: 1, page_size: 1, status: 'active', product_id: null }),
        bridge.call('/subscriptions/list', { page: 1, page_size: 1, status: 'notified', product_id: null }),
      ]);
      container.querySelector('#stat-total').textContent = subRes.total;
      container.querySelector('#stat-active').textContent = activeRes.total;
      container.querySelector('#stat-notified').textContent = notifiedRes.total;
      container.querySelector('#stat-notifications').textContent = notifRes.total;
    } catch(e) {
      // stats failure is non-critical
    }
  }

  async function loadSubscriptions() {
    if (subState.loading) return;
    subState.loading = true;

    const loading = container.querySelector('#sub-loading');
    const error = container.querySelector('#sub-error');
    const empty = container.querySelector('#sub-empty');
    const tableWrap = container.querySelector('#sub-table-wrap');
    const pagination = container.querySelector('#sub-pagination');

    loading.style.display = 'flex';
    error.style.display = 'none';
    empty.style.display = 'none';
    tableWrap.style.display = 'none';
    pagination.style.display = 'none';

    try {
      const res = await bridge.call('/subscriptions/list', {
        page: subState.page,
        page_size: PAGE_SIZE,
        status: subState.status || null,
        product_id: subState.productId || null,
      });

      subState.total = res.total;
      loading.style.display = 'none';

      const note = container.querySelector('#sub-count-note');
      note.textContent = `${res.total} subscription${res.total !== 1 ? 's' : ''} found`;

      if (!res.items || res.items.length === 0) {
        empty.style.display = 'block';
      } else {
        const tbody = container.querySelector('#sub-tbody');
        tbody.innerHTML = '';
        res.items.forEach(item => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><span class="truncate" title="${item.email}">${item.email}</span></td>
            <td><span class="id-chip truncate" title="${item.product_id}">${item.product_id}</span></td>
            <td><span class="id-chip truncate" title="${item.variant_id}">${item.variant_id}</span></td>
            <td>${statusBadge(item.status)}</td>
            <td>${formatDate(item.notified_at)}</td>
            <td>${formatDate(item.created_at)}</td>
            <td>
              <div class="action-cell" id="actions-${item.id}"></div>
            </td>
          `;
          tbody.appendChild(tr);

          const actionsCell = tbody.querySelector(`#actions-${item.id}`);

          if (item.status !== 'active') {
            const activateBtn = document.createElement('button');
            activateBtn.className = 'btn-xs';
            activateBtn.textContent = 'Set Active';
            activateBtn.addEventListener('click', () => updateStatus(item.id, 'active'));
            actionsCell.appendChild(activateBtn);
          }
          if (item.status !== 'cancelled') {
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn-xs';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', () => updateStatus(item.id, 'cancelled'));
            actionsCell.appendChild(cancelBtn);
          }

          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'btn-xs btn-xs-danger';
          deleteBtn.textContent = 'Delete';
          deleteBtn.addEventListener('click', () => deleteSubscription(item.id, item.email));
          actionsCell.appendChild(deleteBtn);
        });

        tableWrap.style.display = 'block';

        const totalPages = Math.ceil(res.total / PAGE_SIZE);
        if (totalPages > 1) {
          pagination.style.display = 'flex';
          container.querySelector('#sub-page-info').textContent =
            `Page ${subState.page} of ${totalPages} (${res.total} total)`;
          container.querySelector('#sub-prev-btn').disabled = subState.page <= 1;
          container.querySelector('#sub-next-btn').disabled = subState.page >= totalPages;
        }
      }
    } catch(e) {
      loading.style.display = 'none';
      error.style.display = 'block';
      error.textContent = `Failed to load subscriptions: ${e.message || e}`;
    } finally {
      subState.loading = false;
    }
  }

  async function updateStatus(id, status) {
    try {
      const res = await bridge.call('/subscriptions/update-status', { id, status });
      if (res.success) {
        bridge.notify(`Subscription status updated to "${status}"`, 'success');
        loadSubscriptions();
        loadStats();
      } else {
        bridge.notify('Failed to update status', 'error');
      }
    } catch(e) {
      bridge.notify(`Error: ${e.message || e}`, 'error');
    }
  }

  async function deleteSubscription(id, email) {
    const confirmed = await showConfirm(
      'Delete Subscription',
      `Are you sure you want to delete the subscription for ${email}? This cannot be undone.`
    );
    if (!confirmed) return;
    try {
      const res = await bridge.call('/subscriptions/delete', { id });
      if (res.success) {
        bridge.notify('Subscription deleted', 'success');
        if (subState.page > 1 && subState.total % PAGE_SIZE === 1) {
          subState.page--;
        }
        loadSubscriptions();
        loadStats();
      } else {
        bridge.notify('Failed to delete subscription', 'error');
      }
    } catch(e) {
      bridge.notify(`Error: ${e.message || e}`, 'error');
    }
  }

  async function loadNotifications() {
    if (notifState.loading) return;
    notifState.loading = true;

    const loading = container.querySelector('#notif-loading');
    const error = container.querySelector('#notif-error');
    const empty = container.querySelector('#notif-empty');
    const tableWrap = container.querySelector('#notif-table-wrap');
    const pagination = container.querySelector('#notif-pagination');

    loading.style.display = 'flex';
    error.style.display = 'none';
    empty.style.display = 'none';
    tableWrap.style.display = 'none';
    pagination.style.display = 'none';

    try {
      const res = await bridge.call('/notifications/list', {
        page: notifState.page,
        page_size: PAGE_SIZE,
        subscription_id: null,
      });

      notifState.total = res.total;
      loading.style.display = 'none';

      const note = container.querySelector('#notif-count-note');
      note.textContent = `${res.total} notification${res.total !== 1 ? 's' : ''} sent`;

      if (!res.items || res.items.length === 0) {
        empty.style.display = 'block';
      } else {
        const tbody = container.querySelector('#notif-tbody');
        tbody.innerHTML = '';
        res.items.forEach(item => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td class="notif-email"><span class="truncate" title="${item.email}">${item.email}</span></td>
            <td><span class="id-chip truncate" title="${item.variant_id}">${item.variant_id}</span></td>
            <td><span class="id-chip truncate" title="${item.subscription_id}">${item.subscription_id}</span></td>
            <td>${formatDate(item.sent_at)}</td>
          `;
          tbody.appendChild(tr);
        });

        tableWrap.style.display = 'block';

        const totalPages = Math.ceil(res.total / PAGE_SIZE);
        if (totalPages > 1) {
          pagination.style.display = 'flex';
          container.querySelector('#notif-page-info').textContent =
            `Page ${notifState.page} of ${totalPages} (${res.total} total)`;
          container.querySelector('#notif-prev-btn').disabled = notifState.page <= 1;
          container.querySelector('#notif-next-btn').disabled = notifState.page >= totalPages;
        }
      }
    } catch(e) {
      loading.style.display = 'none';
      error.style.display = 'block';
      error.textContent = `Failed to load notifications: ${e.message || e}`;
    } finally {
      notifState.loading = false;
    }
  }

  function switchTab(tab) {
    activeTab = tab;
    container.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    container.querySelector('#tab-subscriptions').style.display = tab === 'subscriptions' ? 'block' : 'none';
    container.querySelector('#tab-notifications').style.display = tab === 'notifications' ? 'block' : 'none';

    if (tab === 'notifications') {
      loadNotifications();
    }
  }

  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  container.querySelector('#apply-filter-btn').addEventListener('click', () => {
    subState.page = 1;
    subState.status = container.querySelector('#filter-status').value || null;
    subState.productId = container.querySelector('#filter-product').value.trim() || null;
    loadSubscriptions();
  });

  container.querySelector('#filter-product').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      subState.page = 1;
      subState.status = container.querySelector('#filter-status').value || null;
      subState.productId = container.querySelector('#filter-product').value.trim() || null;
      loadSubscriptions();
    }
  });

  container.querySelector('#sub-prev-btn').addEventListener('click', () => {
    if (subState.page > 1) { subState.page--; loadSubscriptions(); }
  });
  container.querySelector('#sub-next-btn').addEventListener('click', () => {
    const totalPages = Math.ceil(subState.total / PAGE_SIZE);
    if (subState.page < totalPages) { subState.page++; loadSubscriptions(); }
  });

  container.querySelector('#notif-prev-btn').addEventListener('click', () => {
    if (notifState.page > 1) { notifState.page--; loadNotifications(); }
  });
  container.querySelector('#notif-next-btn').addEventListener('click', () => {
    const totalPages = Math.ceil(notifState.total / PAGE_SIZE);
    if (notifState.page < totalPages) { notifState.page++; loadNotifications(); }
  });

  container.querySelector('#refresh-btn').addEventListener('click', () => {
    loadStats();
    if (activeTab === 'subscriptions') {
      loadSubscriptions();
    } else {
      loadNotifications();
    }
    bridge.notify('Refreshed', 'info');
  });

  loadStats();
  loadSubscriptions();
}
```

