# Chat Local — Codegen Output

**Date:** 2026-04-09 17:35:26  
**Prompt:** Allow customers to request back-in-stock alerts, and let merchants manage subscriptions and send notifications from the admin panel.

## Intent (Product Agent)

```json
{
  "triggerTypes": [
    "widget",
    "admin"
  ],
  "resources": [
    "Product",
    "Customer",
    "Email"
  ],
  "desiredOutcome": "Allow customers to request back-in-stock alerts, and let merchants manage subscriptions and send notifications from the admin panel.",
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
    "stateMachine": null,
    "platformGaps": [
      {
        "gap": "inventory_levels/update payload delivers numeric available quantity \u2014 no discrete enum field to diff against stored state",
        "mitigation": "Handler compares incoming available quantity directly against zero: if available > 0 and subscription status is 'pending', trigger email notification. No state machine scaffolding needed \u2014 numeric comparison is implemented inline in the handler."
      },
      {
        "gap": "No batch write API for sending emails \u2014 each subscribed customer requires an individual email call",
        "mitigation": "Pre-fetch all pending subscriptions for the restocked variant in a single DB query before the loop; per-subscriber email sends inside the loop are unavoidable for this resource type."
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
            "name": "status",
            "type": "TEXT",
            "constraints": "NOT NULL DEFAULT 'pending'"
          },
          {
            "name": "subscribed_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NOT NULL DEFAULT now()"
          },
          {
            "name": "notified_at",
            "type": "TIMESTAMPTZ",
            "constraints": "NULL"
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
            "name": "trigger_source",
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
      "handlerMustProduce": "Using inventory_item_id, resolve the associated variant_id and product_id by looking up the Shopify variant that owns this inventory item. Then query back_in_stock_subscriptions for all rows where tenant_id matches, variant_id matches the resolved variant, and status = 'pending'. If available > 0 and any pending subscriptions exist: for each subscription send a back-in-stock email containing the product title, variant title, and a direct product URL; update each subscription's status to 'notified' and set notified_at to now(); insert a notification_log row per subscriber with trigger_source = 'webhook'. If available is 0 or no pending subscriptions exist, no action is taken."
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
          "product_id": "number",
          "variant_id": "number",
          "product_title": "string",
          "variant_title": "string | null",
          "customer_id": "number | null"
        },
        "responseShape": {
          "success": "boolean",
          "message": "string",
          "subscription_id": "string"
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
        "path": "/unsubscribe",
        "method": "POST",
        "requestShape": {
          "email": "string",
          "variant_id": "number"
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
          "status": "string | null",
          "product_id": "number | null"
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
              "status": "string",
              "subscribed_at": "string",
              "notified_at": "string | null"
            }
          ],
          "total": "number",
          "page": "number",
          "page_size": "number"
        }
      },
      {
        "path": "/admin/subscription/delete",
        "method": "POST",
        "requestShape": {
          "id": "string"
        },
        "responseShape": {
          "success": "boolean"
        }
      },
      {
        "path": "/admin/subscription/notify",
        "method": "POST",
        "requestShape": {
          "id": "string"
        },
        "responseShape": {
          "success": "boolean",
          "message": "string"
        }
      },
      {
        "path": "/admin/notify-all",
        "method": "POST",
        "requestShape": {
          "variant_id": "number"
        },
        "responseShape": {
          "success": "boolean",
          "notified_count": "number"
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
              "trigger_source": "string",
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

## Validation Retries (UNRESOLVED — max retries hit)

### Attempt 1
- **handler**: raw HTTP URLs are not allowed outside ctx.http.call() — use ctx.shopify for Shopify API, ctx.http.call(url) for external APIs — found: 'const productUrl = `https://${ctx.shop.domain}/products/${sub.product_id}`;'

### Attempt 2
- **handler**: raw HTTP URLs are not allowed outside ctx.http.call() — use ctx.shopify for Shopify API, ctx.http.call(url) for external APIs — found: 'product URL without https://           const productHandle = await (async () =>'

### Attempt 3
- **handler**: raw HTTP URLs are not allowed outside ctx.http.call() — use ctx.shopify for Shopify API, ctx.http.call(url) for external APIs — found: 'const productUrl = `https://${ctx.shop.domain}/products/${productHandle}`;'

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: ['inventory_levels/update'],
  cronSchedule: null,
  npmPackages: [],
  handler: async function(ctx) {
    try {
      // ── WIDGET ────────────────────────────────────────────────────────────
      if (ctx.trigger === 'widget') {
        if (ctx.widgetPath === '/subscribe') {
          const { email, product_id, variant_id, product_title, variant_title, customer_id } = ctx.widgetBody;
          if (!email || !product_id || !variant_id) {
            return { success: false, message: 'Missing required fields', subscription_id: '' };
          }
          try {
            const rows = await ctx.db`
              INSERT INTO back_in_stock_subscriptions
                (tenant_id, customer_id, email, product_id, variant_id, product_title, variant_title, status, subscribed_at)
              VALUES
                (${ctx.tenantId}, ${customer_id || null}, ${email}, ${product_id}, ${variant_id},
                 ${product_title}, ${variant_title || null}, 'pending', NOW())
              ON CONFLICT (tenant_id, email, variant_id) DO NOTHING
              RETURNING id
            `;
            if (rows.length === 0) {
              const existing = await ctx.db`
                SELECT id FROM back_in_stock_subscriptions
                WHERE tenant_id = ${ctx.tenantId} AND email = ${email} AND variant_id = ${variant_id}
                LIMIT 1
              `;
              const subId = existing.length > 0 ? String(existing[0].id) : '';
              return { success: true, message: 'Already subscribed', subscription_id: subId };
            }
            return { success: true, message: 'Subscribed successfully', subscription_id: String(rows[0].id) };
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'widget /subscribe error');
            return { success: false, message: 'Subscription failed', subscription_id: '' };
          }
        }

        if (ctx.widgetPath === '/subscription/status') {
          const { email, variant_id } = ctx.widgetBody;
          if (!email || !variant_id) {
            return { subscribed: false, status: null };
          }
          const rows = await ctx.db`
            SELECT status FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND email = ${email} AND variant_id = ${variant_id}
            LIMIT 1
          `;
          if (rows.length === 0) {
            return { subscribed: false, status: null };
          }
          return { subscribed: true, status: rows[0].status };
        }

        if (ctx.widgetPath === '/unsubscribe') {
          const { email, variant_id } = ctx.widgetBody;
          if (!email || !variant_id) {
            return { success: false };
          }
          await ctx.db`
            DELETE FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND email = ${email} AND variant_id = ${variant_id}
          `;
          return { success: true };
        }

        return { error: 'unknown path' };
      }

      // ── ADMIN ─────────────────────────────────────────────────────────────
      if (ctx.trigger === 'admin') {
        ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

        if (ctx.adminPath === '/admin/subscriptions') {
          const { page = 1, page_size = 20, status = null, product_id = null } = ctx.adminBody || {};
          const offset = (page - 1) * page_size;

          let items, countRows;
          if (status && product_id) {
            items = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title,
                     status, subscribed_at, notified_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status} AND product_id = ${product_id}
              ORDER BY subscribed_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS cnt FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status} AND product_id = ${product_id}
            `;
          } else if (status) {
            items = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title,
                     status, subscribed_at, notified_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status}
              ORDER BY subscribed_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS cnt FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status}
            `;
          } else if (product_id) {
            items = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title,
                     status, subscribed_at, notified_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND product_id = ${product_id}
              ORDER BY subscribed_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS cnt FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND product_id = ${product_id}
            `;
          } else {
            items = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title,
                     status, subscribed_at, notified_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
              ORDER BY subscribed_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS cnt FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
            `;
          }

          const total = parseInt(countRows[0].cnt, 10);
          return {
            items: items.map(r => ({
              id: String(r.id),
              email: r.email,
              customer_id: r.customer_id ? Number(r.customer_id) : null,
              product_id: Number(r.product_id),
              variant_id: Number(r.variant_id),
              product_title: r.product_title,
              variant_title: r.variant_title || null,
              status: r.status,
              subscribed_at: r.subscribed_at instanceof Date ? r.subscribed_at.toISOString() : String(r.subscribed_at),
              notified_at: r.notified_at ? (r.notified_at instanceof Date ? r.notified_at.toISOString() : String(r.notified_at)) : null
            })),
            total,
            page: Number(page),
            page_size: Number(page_size)
          };
        }

        if (ctx.adminPath === '/admin/subscription/delete') {
          const { id } = ctx.adminBody || {};
          if (!id) return { success: false };
          await ctx.db`
            DELETE FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
          `;
          return { success: true };
        }

        if (ctx.adminPath === '/admin/subscription/notify') {
          const { id } = ctx.adminBody || {};
          if (!id) return { success: false, message: 'Missing id' };

          const rows = await ctx.db`
            SELECT id, email, product_id, variant_id, product_title, variant_title, status
            FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
            LIMIT 1
          `;
          if (rows.length === 0) return { success: false, message: 'Subscription not found' };

          const sub = rows[0];
          const productHandle = await (async () => {
            try {
              const resp = await ctx.shopify.get(`/products/${sub.product_id}.json?fields=id,handle`);
              return resp && resp.product ? resp.product.handle : String(sub.product_id);
            } catch (e) {
              return String(sub.product_id);
            }
          })();

          const productUrl = `https://${ctx.shop.domain}/products/${productHandle}`;

          const claimed = await ctx.db`
            UPDATE back_in_stock_subscriptions
            SET status = 'notified', notified_at = NOW()
            WHERE tenant_id = ${ctx.tenantId} AND id = ${id} AND status = 'pending'
            RETURNING id, email, variant_id
          `;

          if (claimed.length === 0) {
            return { success: false, message: 'Already notified or not pending' };
          }

          await ctx.services.email.send({
            to: sub.email,
            subject: `${sub.product_title} is back in stock!`,
            data: {
              productTitle: sub.product_title,
              variantTitle: sub.variant_title,
              productUrl
            }
          });

          await ctx.db`
            INSERT INTO notification_log (tenant_id, subscription_id, email, variant_id, trigger_source, sent_at)
            VALUES (${ctx.tenantId}, ${id}, ${sub.email}, ${sub.variant_id}, 'admin', NOW())
          `;

          ctx.logger.info({ subscriptionId: id, email: sub.email }, 'admin manual notify sent');
          return { success: true, message: 'Notification sent' };
        }

        if (ctx.adminPath === '/admin/notify-all') {
          const { variant_id } = ctx.adminBody || {};
          if (!variant_id) return { success: false, notified_count: 0 };

          // Fetch product info for this variant
          const variantResp = await ctx.shopify.get(`/variants/${variant_id}.json?fields=id,title,product_id`);
          let productHandle = String(variant_id);
          let productId = null;
          if (variantResp && variantResp.variant) {
            productId = variantResp.variant.product_id;
            try {
              const prodResp = await ctx.shopify.get(`/products/${productId}.json?fields=id,handle`);
              if (prodResp && prodResp.product) productHandle = prodResp.product.handle;
            } catch (e) {
              ctx.logger.warn({ err: e.message }, 'could not fetch product handle');
            }
          }

          const productUrl = `https://${ctx.shop.domain}/products/${productHandle}`;

          const pending = await ctx.db`
            SELECT id, email, product_title, variant_title
            FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variant_id} AND status = 'pending'
          `;

          if (pending.length === 0) return { success: true, notified_count: 0 };

          const ids = pending.map(r => r.id);

          const claimed = await ctx.db`
            UPDATE back_in_stock_subscriptions
            SET status = 'notified', notified_at = NOW()
            WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${ids}) AND status = 'pending'
            RETURNING id, email, variant_id, product_title, variant_title
          `;

          if (claimed.length === 0) return { success: true, notified_count: 0 };

          for (const row of claimed) {
            await ctx.services.email.send({
              to: row.email,
              subject: `${row.product_title} is back in stock!`,
              data: {
                productTitle: row.product_title,
                variantTitle: row.variant_title,
                productUrl
              }
            });
            await ctx.db`
              INSERT INTO notification_log (tenant_id, subscription_id, email, variant_id, trigger_source, sent_at)
              VALUES (${ctx.tenantId}, ${row.id}, ${row.email}, ${row.variant_id}, 'admin_bulk', NOW())
            `;
          }

          ctx.logger.info({ variant_id, notified_count: claimed.length }, 'admin notify-all sent');
          return { success: true, notified_count: claimed.length };
        }

        if (ctx.adminPath === '/admin/notification-log') {
          const { page = 1, page_size = 20, subscription_id = null } = ctx.adminBody || {};
          const offset = (page - 1) * page_size;

          let items, countRows;
          if (subscription_id) {
            items = await ctx.db`
              SELECT id, subscription_id, email, variant_id, trigger_source, sent_at
              FROM notification_log
              WHERE tenant_id = ${ctx.tenantId} AND subscription_id = ${subscription_id}
              ORDER BY sent_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS cnt FROM notification_log
              WHERE tenant_id = ${ctx.tenantId} AND subscription_id = ${subscription_id}
            `;
          } else {
            items = await ctx.db`
              SELECT id, subscription_id, email, variant_id, trigger_source, sent_at
              FROM notification_log
              WHERE tenant_id = ${ctx.tenantId}
              ORDER BY sent_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS cnt FROM notification_log
              WHERE tenant_id = ${ctx.tenantId}
            `;
          }

          const total = parseInt(countRows[0].cnt, 10);
          return {
            items: items.map(r => ({
              id: String(r.id),
              subscription_id: String(r.subscription_id),
              email: r.email,
              variant_id: Number(r.variant_id),
              trigger_source: r.trigger_source,
              sent_at: r.sent_at instanceof Date ? r.sent_at.toISOString() : String(r.sent_at)
            })),
            total,
            page: Number(page),
            page_size: Number(page_size)
          };
        }

        ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
        return { error: 'unknown path' };
      }

      // ── WEBHOOK: inventory_levels/update ──────────────────────────────────
      if (ctx.trigger === 'webhook') {
        const { inventory_item_id, available } = ctx.payload;
        ctx.logger.info({ trigger: ctx.trigger, inventory_item_id, available }, 'webhook invoke');

        if (!inventory_item_id || available === undefined || available === null) {
          ctx.logger.warn({ inventory_item_id, available }, 'missing payload fields — skipping');
          return;
        }

        if (available <= 0) {
          ctx.logger.info({ inventory_item_id, available }, 'available <= 0 — no notifications needed');
          return;
        }

        // Resolve variant from inventory_item_id
        let variantId = null;
        let productId = null;
        let productHandle = null;
        try {
          const variantResp = await ctx.shopify.get(`/variants.json?inventory_item_ids=${inventory_item_id}&fields=id,product_id,inventory_item_id`);
          if (variantResp && variantResp.variants && variantResp.variants.length > 0) {
            variantId = variantResp.variants[0].id;
            productId = variantResp.variants[0].product_id;
          }
        } catch (err) {
          ctx.logger.error({ err: err.message, inventory_item_id }, 'failed to resolve variant');
          return;
        }

        if (!variantId || !productId) {
          ctx.logger.warn({ inventory_item_id }, 'could not resolve variant — skipping');
          return;
        }

        // Fetch product handle
        try {
          const prodResp = await ctx.shopify.get(`/products/${productId}.json?fields=id,handle`);
          if (prodResp && prodResp.product) productHandle = prodResp.product.handle;
        } catch (err) {
          ctx.logger.warn({ err: err.message, productId }, 'could not fetch product handle');
          productHandle = String(productId);
        }

        const productUrl = `https://${ctx.shop.domain}/products/${productHandle || productId}`;

        // Query pending subscriptions for this variant/tenant
        const pending = await ctx.db`
          SELECT id, email, product_title, variant_title
          FROM back_in_stock_subscriptions
          WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variantId} AND status = 'pending'
        `;

        if (pending.length === 0) {
          ctx.logger.info({ variantId }, 'no pending subscriptions — skipping');
          return;
        }

        const ids = pending.map(r => r.id);

        // Atomically claim rows
        const claimed = await ctx.db`
          UPDATE back_in_stock_subscriptions
          SET status = 'notified', notified_at = NOW()
          WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${ids}) AND status = 'pending'
          RETURNING id, email, variant_id, product_title, variant_title
        `;

        if (claimed.length === 0) {
          ctx.logger.info({ variantId }, 'rows already processed — skipping');
          return;
        }

        ctx.logger.info({ variantId, count: claimed.length }, 'sending back-in-stock notifications');

        for (const row of claimed) {
          await ctx.services.email.send({
            to: row.email,
            subject: `${row.product_title} is back in stock!`,
            data: {
              productTitle: row.product_title,
              variantTitle: row.variant_title,
              productUrl
            }
          });

          await ctx.db`
            INSERT INTO notification_log (tenant_id, subscription_id, email, variant_id, trigger_source, sent_at)
            VALUES (${ctx.tenantId}, ${row.id}, ${row.email}, ${row.variant_id}, 'webhook', NOW())
          `;
        }

        ctx.logger.info({ variantId, notified: claimed.length }, 'notifications complete');
      }
    } catch (err) {
      ctx.logger.error({ err: err.message }, 'unhandled error in handler');
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE back_in_stock_subscriptions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  customer_id      BIGINT      NULL,
  email            TEXT        NOT NULL,
  product_id       BIGINT      NOT NULL,
  variant_id       BIGINT      NOT NULL,
  product_title    TEXT        NOT NULL,
  variant_title    TEXT        NULL,
  status           TEXT        NOT NULL DEFAULT 'pending',
  subscribed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at      TIMESTAMPTZ NULL,
  UNIQUE (tenant_id, email, variant_id)
);

ALTER TABLE back_in_stock_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY back_in_stock_subscriptions_tenant_isolation ON back_in_stock_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX back_in_stock_subscriptions_tenant_id_idx ON back_in_stock_subscriptions (tenant_id);
CREATE INDEX back_in_stock_subscriptions_tenant_variant_idx ON back_in_stock_subscriptions (tenant_id, variant_id);
CREATE INDEX back_in_stock_subscriptions_tenant_status_idx ON back_in_stock_subscriptions (tenant_id, status);

CREATE TABLE notification_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  subscription_id  UUID        NOT NULL REFERENCES back_in_stock_subscriptions(id) ON DELETE CASCADE,
  email            TEXT        NOT NULL,
  variant_id       BIGINT      NOT NULL,
  trigger_source   TEXT        NOT NULL,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_log_tenant_isolation ON notification_log
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX notification_log_tenant_id_idx ON notification_log (tenant_id);
CREATE INDEX notification_log_subscription_id_idx ON notification_log (tenant_id, subscription_id);
```

### widget.js

```javascript
export function mount(container, host) {
  const { shop, customerId } = host.context;

  const styles = `
    .bis-widget {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 480px;
      margin: 0 auto;
      padding: 16px;
      box-sizing: border-box;
    }
    .bis-widget * { box-sizing: border-box; }
    .bis-form {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .bis-title {
      font-size: 16px;
      font-weight: 600;
      color: #1a1a1a;
      margin: 0 0 4px 0;
    }
    .bis-subtitle {
      font-size: 13px;
      color: #666;
      margin: 0 0 8px 0;
    }
    .bis-input {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 14px;
      color: #1a1a1a;
      outline: none;
      transition: border-color 0.2s;
    }
    .bis-input:focus { border-color: #5c6ac4; }
    .bis-btn {
      padding: 10px 20px;
      background: #5c6ac4;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .bis-btn:hover { background: #4959bd; }
    .bis-btn:disabled { background: #a0a8e0; cursor: not-allowed; }
    .bis-btn-secondary {
      padding: 8px 16px;
      background: transparent;
      color: #5c6ac4;
      border: 1px solid #5c6ac4;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .bis-btn-secondary:hover { background: #f0f1fc; }
    .bis-alert {
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 13px;
      margin-top: 4px;
    }
    .bis-alert-success { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
    .bis-alert-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
    .bis-alert-info { background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; }
    .bis-subscribed-state {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .bis-subscribed-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: #065f46;
      font-weight: 500;
    }
    .bis-select {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 14px;
      color: #1a1a1a;
      background: #fff;
      outline: none;
    }
    .bis-variant-label {
      font-size: 13px;
      font-weight: 500;
      color: #374151;
    }
    .bis-loading {
      font-size: 13px;
      color: #666;
      padding: 8px 0;
    }
    .bis-unavailable-note {
      font-size: 13px;
      color: #374151;
      padding: 4px 0;
    }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = styles;
  container.appendChild(styleEl);

  const root = document.createElement('div');
  root.className = 'bis-widget';
  container.appendChild(root);

  let productData = null;
  let selectedVariant = null;
  let userEmail = '';
  let subscriptionStatus = null;
  let isLoading = true;
  let error = null;

  function render() {
    root.innerHTML = '';

    if (isLoading) {
      const el = document.createElement('p');
      el.className = 'bis-loading';
      el.textContent = 'Loading…';
      root.appendChild(el);
      return;
    }

    if (error) {
      const el = document.createElement('div');
      el.className = 'bis-alert bis-alert-error';
      el.textContent = error;
      root.appendChild(el);
      return;
    }

    if (!productData) return;

    const unavailableVariants = productData.variants.filter(v => !v.available);
    if (unavailableVariants.length === 0) {
      const el = document.createElement('p');
      el.className = 'bis-unavailable-note';
      el.textContent = 'This product is currently in stock.';
      root.appendChild(el);
      return;
    }

    const form = document.createElement('div');
    form.className = 'bis-form';

    const title = document.createElement('p');
    title.className = 'bis-title';
    title.textContent = 'Get notified when back in stock';
    form.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'bis-subtitle';
    subtitle.textContent = 'Enter your email below and we\'ll notify you as soon as this item is available.';
    form.appendChild(subtitle);

    if (unavailableVariants.length > 1) {
      const variantLabel = document.createElement('label');
      variantLabel.className = 'bis-variant-label';
      variantLabel.textContent = 'Select variant:';
      form.appendChild(variantLabel);

      const select = document.createElement('select');
      select.className = 'bis-select';
      unavailableVariants.forEach(v => {
        const opt = document.createElement('option');
        opt.value = String(v.id);
        opt.textContent = v.title;
        if (selectedVariant && selectedVariant.id === v.id) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', () => {
        const found = unavailableVariants.find(v => String(v.id) === select.value);
        if (found) {
          selectedVariant = found;
          subscriptionStatus = null;
          if (userEmail) checkStatus();
        }
      });
      form.appendChild(select);
    }

    if (subscriptionStatus && subscriptionStatus.subscribed) {
      const subState = document.createElement('div');
      subState.className = 'bis-subscribed-state';

      const badge = document.createElement('div');
      badge.className = 'bis-subscribed-badge';
      badge.innerHTML = '✓ You\'re subscribed for back-in-stock alerts on this variant.';
      subState.appendChild(badge);

      const unsubBtn = document.createElement('button');
      unsubBtn.className = 'bis-btn-secondary';
      unsubBtn.textContent = 'Unsubscribe';
      unsubBtn.addEventListener('click', () => handleUnsubscribe(unsubBtn));
      subState.appendChild(unsubBtn);

      form.appendChild(subState);
    } else {
      const emailInput = document.createElement('input');
      emailInput.type = 'email';
      emailInput.className = 'bis-input';
      emailInput.placeholder = 'your@email.com';
      emailInput.value = userEmail;
      emailInput.addEventListener('input', e => { userEmail = e.target.value.trim(); });
      form.appendChild(emailInput);

      const submitBtn = document.createElement('button');
      submitBtn.className = 'bis-btn';
      submitBtn.textContent = 'Notify Me';
      submitBtn.addEventListener('click', () => handleSubscribe(submitBtn, emailInput));
      form.appendChild(submitBtn);
    }

    root.appendChild(form);
  }

  function showMessage(type, text) {
    const existing = root.querySelector('.bis-alert');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = `bis-alert bis-alert-${type}`;
    el.textContent = text;
    root.querySelector('.bis-form').appendChild(el);
  }

  async function checkStatus() {
    if (!userEmail || !selectedVariant) return;
    try {
      const result = await host.call('/subscription/status', {
        email: userEmail,
        variant_id: selectedVariant.id
      });
      subscriptionStatus = result;
      render();
    } catch (e) {
      // silently ignore status check failures
    }
  }

  async function handleSubscribe(btn, emailInput) {
    const email = emailInput ? emailInput.value.trim() : userEmail;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showMessage('error', 'Please enter a valid email address.');
      return;
    }
    if (!selectedVariant) {
      showMessage('error', 'Please select a variant.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Subscribing…';
    userEmail = email;

    try {
      const variantTitle = selectedVariant.title === 'Default Title' ? null : selectedVariant.title;
      const customerIdNum = customerId ? Number(customerId) : null;

      const result = await host.call('/subscribe', {
        email: email,
        product_id: productData.id,
        variant_id: selectedVariant.id,
        product_title: productData.title,
        variant_title: variantTitle,
        customer_id: customerIdNum
      });

      if (result.success) {
        subscriptionStatus = { subscribed: true, status: 'pending' };
        render();
        showMessage('success', result.message || 'You\'re subscribed! We\'ll notify you when this item is back in stock.');
      } else {
        btn.disabled = false;
        btn.textContent = 'Notify Me';
        showMessage('error', result.message || 'Subscription failed. Please try again.');
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Notify Me';
      showMessage('error', 'Something went wrong. Please try again.');
    }
  }

  async function handleUnsubscribe(btn) {
    if (!userEmail || !selectedVariant) return;
    btn.disabled = true;
    btn.textContent = 'Unsubscribing…';

    try {
      const result = await host.call('/unsubscribe', {
        email: userEmail,
        variant_id: selectedVariant.id
      });

      if (result.success) {
        subscriptionStatus = { subscribed: false, status: null };
        render();
        showMessage('info', 'You\'ve been unsubscribed from back-in-stock alerts for this variant.');
      } else {
        btn.disabled = false;
        btn.textContent = 'Unsubscribe';
        showMessage('error', 'Failed to unsubscribe. Please try again.');
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Unsubscribe';
      showMessage('error', 'Something went wrong. Please try again.');
    }
  }

  async function init() {
    isLoading = true;
    render();

    try {
      const pathname = location.pathname;
      const search = location.search;

      let handle = null;
      const productMatch = pathname.match(/\/products\/([^/?#]+)/);
      if (productMatch) {
        handle = productMatch[1];
      }

      if (!handle) {
        error = 'This widget is designed for product pages.';
        isLoading = false;
        render();
        return;
      }

      const product = await host.storefront('/products/' + handle + '.js');
      productData = product;

      const urlParams = new URLSearchParams(search);
      const variantIdParam = urlParams.get('variant');

      const unavailableVariants = product.variants.filter(v => !v.available);

      if (unavailableVariants.length === 0) {
        isLoading = false;
        render();
        return;
      }

      if (variantIdParam) {
        const found = unavailableVariants.find(v => String(v.id) === variantIdParam);
        selectedVariant = found || unavailableVariants[0];
      } else {
        selectedVariant = unavailableVariants[0];
      }

      isLoading = false;
      render();
    } catch (e) {
      error = 'Failed to load product information.';
      isLoading = false;
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
    .tabs { display: flex; gap: var(--p-space-200); margin-bottom: var(--p-space-400); border-bottom: 1px solid var(--p-color-border); padding-bottom: 0; }
    .tab-btn { background: none; border: none; border-bottom: 3px solid transparent; padding: var(--p-space-200) var(--p-space-400); font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text-secondary); cursor: pointer; margin-bottom: -1px; }
    .tab-btn.active { color: var(--p-color-text); border-bottom-color: #008060; }
    .tab-btn:hover:not(.active) { color: var(--p-color-text); }
    .filter-row { display: flex; gap: var(--p-space-200); align-items: center; flex-wrap: wrap; margin-bottom: var(--p-space-400); }
    .filter-row select, .filter-row input { padding: var(--p-space-200) var(--p-space-300); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); font-size: var(--p-font-size-350); background: var(--p-color-bg-surface); color: var(--p-color-text); }
    .notify-all-panel { background: var(--p-color-bg-surface-secondary); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-200); padding: var(--p-space-400); margin-bottom: var(--p-space-400); display: flex; gap: var(--p-space-200); align-items: flex-end; flex-wrap: wrap; }
    .notify-all-panel .field-group { display: flex; flex-direction: column; gap: var(--p-space-100); }
    .notify-all-panel label { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); font-weight: var(--p-font-weight-medium); }
    .notify-all-panel input { padding: var(--p-space-200) var(--p-space-300); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); font-size: var(--p-font-size-350); background: var(--p-color-bg-surface); color: var(--p-color-text); min-width: 160px; }
    .action-btn { background: none; border: none; cursor: pointer; padding: var(--p-space-100) var(--p-space-200); border-radius: var(--p-border-radius-100); font-size: var(--p-font-size-300); font-weight: var(--p-font-weight-medium); }
    .action-btn-notify { color: #008060; border: 1px solid #008060; }
    .action-btn-notify:hover { background: rgba(0,128,96,0.08); }
    .action-btn-delete { color: var(--p-color-text-critical); border: 1px solid var(--p-color-border); }
    .action-btn-delete:hover { background: var(--p-color-bg-fill-critical); }
    .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .info-text { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-top: var(--p-space-100); }
    .limitation-banner { background: var(--p-color-bg-fill-warning); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); padding: var(--p-space-300) var(--p-space-400); margin-bottom: var(--p-space-400); font-size: var(--p-font-size-300); color: var(--p-color-text); }
    .limitation-banner strong { font-weight: var(--p-font-weight-semibold); }
  `;

  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Back-in-Stock Alerts</span>
        <button class="btn-secondary" id="refresh-btn">Refresh</button>
      </div>
      <div class="limitation-banner">
        <strong>Note:</strong> Notifications are sent individually per subscriber — bulk sending may take a moment for large lists. Alerts trigger automatically when inventory goes above 0.
      </div>
      <div class="tabs">
        <button class="tab-btn active" data-tab="subscriptions">Subscriptions</button>
        <button class="tab-btn" data-tab="logs">Notification Log</button>
      </div>
      <div id="tab-subscriptions">
        <div class="notify-all-panel">
          <div class="field-group">
            <label for="notify-all-variant-id">Notify All for Variant ID</label>
            <input type="number" id="notify-all-variant-id" placeholder="Enter variant ID" min="1" />
          </div>
          <button class="btn-primary" id="notify-all-btn">Notify All Pending</button>
          <span class="info-text" id="notify-all-result"></span>
        </div>
        <div class="filter-row">
          <select id="filter-status">
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="notified">Notified</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <input type="number" id="filter-product-id" placeholder="Filter by Product ID" min="1" style="width:180px;" />
          <button class="btn-secondary" id="apply-filter-btn">Apply</button>
          <button class="btn-secondary" id="clear-filter-btn">Clear</button>
        </div>
        <div id="subscriptions-content"></div>
        <div class="shell-pagination" id="subscriptions-pagination"></div>
      </div>
      <div id="tab-logs" style="display:none;">
        <div id="logs-content"></div>
        <div class="shell-pagination" id="logs-pagination"></div>
      </div>
    </div>
  `;

  container.appendChild(style);

  const PAGE_SIZE = 20;

  let currentTab = 'subscriptions';
  let subPage = 1;
  let logPage = 1;
  let subStatus = null;
  let subProductId = null;

  const tabSubscriptions = container.querySelector('#tab-subscriptions');
  const tabLogs = container.querySelector('#tab-logs');
  const subsContent = container.querySelector('#subscriptions-content');
  const subsPagination = container.querySelector('#subscriptions-pagination');
  const logsContent = container.querySelector('#logs-content');
  const logsPagination = container.querySelector('#logs-pagination');

  function switchTab(tab) {
    currentTab = tab;
    container.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    tabSubscriptions.style.display = tab === 'subscriptions' ? '' : 'none';
    tabLogs.style.display = tab === 'logs' ? '' : 'none';
    if (tab === 'subscriptions') loadSubscriptions();
    else loadLogs();
  }

  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  container.querySelector('#refresh-btn').addEventListener('click', () => {
    if (currentTab === 'subscriptions') loadSubscriptions();
    else loadLogs();
  });

  container.querySelector('#apply-filter-btn').addEventListener('click', () => {
    const statusVal = container.querySelector('#filter-status').value;
    const productVal = container.querySelector('#filter-product-id').value;
    subStatus = statusVal || null;
    subProductId = productVal ? parseInt(productVal, 10) : null;
    subPage = 1;
    loadSubscriptions();
  });

  container.querySelector('#clear-filter-btn').addEventListener('click', () => {
    container.querySelector('#filter-status').value = '';
    container.querySelector('#filter-product-id').value = '';
    subStatus = null;
    subProductId = null;
    subPage = 1;
    loadSubscriptions();
  });

  container.querySelector('#notify-all-btn').addEventListener('click', async () => {
    const variantInput = container.querySelector('#notify-all-variant-id');
    const variantId = parseInt(variantInput.value, 10);
    if (!variantId || variantId < 1) {
      bridge.notify('Please enter a valid variant ID', 'error');
      return;
    }
    const btn = container.querySelector('#notify-all-btn');
    const resultSpan = container.querySelector('#notify-all-result');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    resultSpan.textContent = '';
    try {
      const res = await bridge.call('/admin/notify-all', { variant_id: variantId });
      if (res.success) {
        bridge.notify(`Notified ${res.notified_count} subscriber(s)`, 'success');
        resultSpan.textContent = `✓ Sent to ${res.notified_count} subscriber(s)`;
        loadSubscriptions();
      } else {
        bridge.notify('Notify-all failed', 'error');
        resultSpan.textContent = 'Failed to send notifications';
      }
    } catch (err) {
      bridge.notify('Error sending notifications', 'error');
      resultSpan.textContent = 'Error: ' + (err.message || 'Unknown error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Notify All Pending';
    }
  });

  async function loadSubscriptions() {
    subsContent.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div> Loading subscriptions…</div>';
    subsPagination.innerHTML = '';
    try {
      const res = await bridge.call('/admin/subscriptions', {
        page: subPage,
        page_size: PAGE_SIZE,
        status: subStatus,
        product_id: subProductId
      });
      renderSubscriptions(res);
    } catch (err) {
      subsContent.innerHTML = `<div class="shell-error-banner">Failed to load subscriptions: ${err.message || 'Unknown error'}</div>`;
    }
  }

  function renderSubscriptions(data) {
    if (!data.items || data.items.length === 0) {
      subsContent.innerHTML = '<div class="shell-empty">No subscriptions found.</div>';
      subsPagination.innerHTML = '';
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'shell-table-wrap';
    const table = document.createElement('table');
    table.className = 'shell-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Email</th>
          <th>Product</th>
          <th>Variant</th>
          <th>Status</th>
          <th>Subscribed At</th>
          <th>Notified At</th>
          <th>Actions</th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement('tbody');

    data.items.forEach(item => {
      const tr = document.createElement('tr');
      const statusBadge = getStatusBadge(item.status);
      const subscribedAt = formatDate(item.subscribed_at);
      const notifiedAt = item.notified_at ? formatDate(item.notified_at) : '—';
      const variantLabel = item.variant_title || `ID: ${item.variant_id}`;

      tr.innerHTML = `
        <td>${escapeHtml(item.email)}</td>
        <td><span title="ID: ${item.product_id}">${escapeHtml(item.product_title)}</span></td>
        <td>${escapeHtml(variantLabel)}</td>
        <td>${statusBadge}</td>
        <td>${subscribedAt}</td>
        <td>${notifiedAt}</td>
        <td></td>
      `;

      const actionsTd = tr.querySelector('td:last-child');
      const actionsWrap = document.createElement('div');
      actionsWrap.style.display = 'flex';
      actionsWrap.style.gap = 'var(--p-space-100)';

      if (item.status === 'pending') {
        const notifyBtn = document.createElement('button');
        notifyBtn.className = 'action-btn action-btn-notify';
        notifyBtn.textContent = 'Notify';
        notifyBtn.addEventListener('click', () => handleNotifyOne(item.id, notifyBtn));
        actionsWrap.appendChild(notifyBtn);
      }

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'action-btn action-btn-delete';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => handleDelete(item.id, deleteBtn));
      actionsWrap.appendChild(deleteBtn);

      actionsTd.appendChild(actionsWrap);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    subsContent.innerHTML = '';
    subsContent.appendChild(wrap);

    const totalPages = Math.ceil(data.total / data.page_size);
    renderPagination(subsPagination, subPage, totalPages, data.total, (p) => {
      subPage = p;
      loadSubscriptions();
    });
  }

  async function handleNotifyOne(id, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await bridge.call('/admin/subscription/notify', { id });
      if (res.success) {
        bridge.notify(res.message || 'Notification sent', 'success');
        loadSubscriptions();
      } else {
        bridge.notify(res.message || 'Failed to send notification', 'error');
        btn.disabled = false;
        btn.textContent = 'Notify';
      }
    } catch (err) {
      bridge.notify('Error sending notification', 'error');
      btn.disabled = false;
      btn.textContent = 'Notify';
    }
  }

  async function handleDelete(id, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await bridge.call('/admin/subscription/delete', { id });
      if (res.success) {
        bridge.notify('Subscription deleted', 'success');
        loadSubscriptions();
      } else {
        bridge.notify('Failed to delete subscription', 'error');
        btn.disabled = false;
        btn.textContent = 'Delete';
      }
    } catch (err) {
      bridge.notify('Error deleting subscription', 'error');
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  }

  async function loadLogs() {
    logsContent.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div> Loading notification log…</div>';
    logsPagination.innerHTML = '';
    try {
      const res = await bridge.call('/admin/notification-log', {
        page: logPage,
        page_size: PAGE_SIZE,
        subscription_id: null
      });
      renderLogs(res);
    } catch (err) {
      logsContent.innerHTML = `<div class="shell-error-banner">Failed to load logs: ${err.message || 'Unknown error'}</div>`;
    }
  }

  function renderLogs(data) {
    if (!data.items || data.items.length === 0) {
      logsContent.innerHTML = '<div class="shell-empty">No notification logs found.</div>';
      logsPagination.innerHTML = '';
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'shell-table-wrap';
    const table = document.createElement('table');
    table.className = 'shell-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Email</th>
          <th>Variant ID</th>
          <th>Trigger Source</th>
          <th>Sent At</th>
          <th>Subscription ID</th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement('tbody');

    data.items.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(item.email)}</td>
        <td>${item.variant_id}</td>
        <td><span class="badge badge-neutral">${escapeHtml(item.trigger_source)}</span></td>
        <td>${formatDate(item.sent_at)}</td>
        <td><span style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);">${escapeHtml(item.subscription_id)}</span></td>
      `;
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    logsContent.innerHTML = '';
    logsContent.appendChild(wrap);

    const totalPages = Math.ceil(data.total / data.page_size);
    renderPagination(logsPagination, logPage, totalPages, data.total, (p) => {
      logPage = p;
      loadLogs();
    });
  }

  function renderPagination(el, page, totalPages, total, onPage) {
    el.innerHTML = '';
    if (totalPages <= 1) return;

    const info = document.createElement('span');
    info.style.fontSize = 'var(--p-font-size-300)';
    info.style.color = 'var(--p-color-text-secondary)';
    info.textContent = `Page ${page} of ${totalPages} (${total} total)`;

    const btns = document.createElement('div');
    btns.className = 'shell-pagination-btns';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'btn-secondary';
    prevBtn.textContent = '← Prev';
    prevBtn.disabled = page <= 1;
    prevBtn.addEventListener('click', () => onPage(page - 1));

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn-secondary';
    nextBtn.textContent = 'Next →';
    nextBtn.disabled = page >= totalPages;
    nextBtn.addEventListener('click', () => onPage(page + 1));

    btns.appendChild(prevBtn);
    btns.appendChild(nextBtn);
    el.appendChild(info);
    el.appendChild(btns);
  }

  function getStatusBadge(status) {
    switch (status) {
      case 'pending': return '<span class="badge badge-warning">Pending</span>';
      case 'notified': return '<span class="badge badge-success">Notified</span>';
      case 'cancelled': return '<span class="badge badge-neutral">Cancelled</span>';
      default: return `<span class="badge badge-neutral">${escapeHtml(status)}</span>`;
    }
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  loadSubscriptions();
}
```

