# Feature Generator — Run Result

**Date:** 2026-04-06 19:06:18  
**Status:** ✅ SUCCESS  
**Total:** 257730ms  
**Prompt:** Develop a Notify Me When Back In Stock Shopify app with admin interface for managing subscriptions and notifications.

## Pipeline

| Agent       | Status | Time       |
|-------------|--------|------------|
| Product     | ✓      | 1912ms     |
| Architect   | ✓      | 49149ms    |
| CodeSpec    | ✓      | 58059ms    |
| Handler     | ✓      | 60107ms    |
| Migration   | ✓      | 60107ms    |
| Widget JS   | ✓      | 60107ms    |
| Admin UI    | ✓      | 60107ms    |
| Validation  | ✓      | 27ms       |
| Explanation | ✓      | 5247ms     |

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: ['inventory_levels/update'],
  cronSchedule: '0 * * * *',
  npmPackages: ['uuid@9.0.1'],
  handler: async function(ctx) {
    const { v4: uuidv4 } = require('uuid');

    // ─── Helper ───────────────────────────────────────────────────────────────
    async function sendBackInStockEmail({ recipientEmail, productTitle, variantTitle, productHandle, variantId, featuredImageUrl }) {
      await ctx.services.email.send({
        to: recipientEmail,
        subject: productTitle + ' is back in stock',
        data: { productTitle, variantTitle, productHandle, variantId, featuredImageUrl }
      });
      ctx.logger.info({ tenantId: ctx.tenantId, variantId, productTitle, recipientEmail }, 'bisn_email_sent');
    }

    // ─── Widget ───────────────────────────────────────────────────────────────
    if (ctx.trigger === 'widget') {
      if (ctx.widgetPath === '/subscribe') {
        const { customerEmail, productId, variantId } = ctx.widgetBody;
        if (!customerEmail || !variantId || !productId) {
          return { success: false, alreadySubscribed: false };
        }
        let variant;
        try {
          const resp = await ctx.shopify.get(`/variants/${variantId}.json`);
          variant = resp.variant;
        } catch (err) {
          ctx.logger.error({ err: err.message, variantId }, 'widget /subscribe: variant fetch failed');
          return { success: false, alreadySubscribed: false };
        }
        if (!variant) {
          return { success: false, alreadySubscribed: false };
        }
        const inventoryItemId = variant.inventory_item_id;
        const customerId = ctx.widgetBody.customerId ?? null;
        let insertResult;
        try {
          insertResult = await ctx.db`
            INSERT INTO bisn_subscriptions
              (id, tenant_id, variant_id, product_id, inventory_item_id, customer_email, customer_id, status, created_at)
            VALUES
              (${uuidv4()}, ${ctx.tenantId}, ${variantId}, ${productId}, ${inventoryItemId}, ${customerEmail}, ${customerId}, 'pending', NOW())
            ON CONFLICT ON CONSTRAINT uq_bisn_subscriptions_tenant_variant_email
            DO NOTHING
            RETURNING id
          `;
        } catch (err) {
          ctx.logger.error({ err: err.message }, 'widget /subscribe: insert failed');
          return { success: false, alreadySubscribed: false };
        }
        if (insertResult.length === 0) {
          return { success: true, alreadySubscribed: true };
        }
        return { success: true, alreadySubscribed: false };
      }

      if (ctx.widgetPath === '/status') {
        const { variantId, customerId } = ctx.widgetBody;
        if (!variantId) {
          return { alreadySubscribed: false };
        }
        if (customerId === null || customerId === undefined) {
          return { alreadySubscribed: false };
        }
        let rows;
        try {
          rows = await ctx.db`
            SELECT id FROM bisn_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variantId}
              AND customer_id = ${customerId}
              AND status = 'pending'
            LIMIT 1
          `;
        } catch (err) {
          ctx.logger.error({ err: err.message }, 'widget /status: db query failed');
          return { alreadySubscribed: false };
        }
        return { alreadySubscribed: rows.length > 0 };
      }

      return { error: 'unknown path' };
    }

    // ─── Admin ────────────────────────────────────────────────────────────────
    if (ctx.trigger === 'admin') {
      ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

      if (ctx.adminPath === '/subscribers') {
        const { page, pageSize } = ctx.adminBody;
        const resolvedPage = page ?? 1;
        const resolvedPageSize = pageSize ?? 50;
        const offset = (resolvedPage - 1) * resolvedPageSize;

        let rows, countResult;
        try {
          rows = await ctx.db`
            SELECT id, variant_id, product_id, customer_email, customer_id, status, created_at, notified_at
            FROM bisn_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY created_at DESC
            LIMIT ${resolvedPageSize} OFFSET ${offset}
          `;
          countResult = await ctx.db`
            SELECT COUNT(*) as total FROM bisn_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
          `;
        } catch (err) {
          ctx.logger.error({ err: err.message }, 'admin /subscribers: db query failed');
          return { total: 0, rows: [], page: resolvedPage, pageSize: resolvedPageSize };
        }

        const productIds = [...new Set(rows.map(r => String(r.product_id)).filter(Boolean))];
        const productMap = {};
        const variantMap = {};

        if (productIds.length > 0) {
          try {
            const { products } = await ctx.shopify.get(
              `/products.json?ids=${productIds.join(',')}&fields=id,title,variants`
            );
            for (const p of (products || [])) {
              productMap[String(p.id)] = p;
              for (const v of (p.variants || [])) {
                variantMap[String(v.id)] = v;
              }
            }
          } catch (err) {
            ctx.logger.warn({ err: err.message }, 'admin /subscribers: product fetch failed');
          }
        }

        const enrichedRows = rows.map(row => ({
          id: row.id,
          variantId: Number(row.variant_id),
          productId: Number(row.product_id),
          productTitle: productMap[String(row.product_id)]?.title ?? '',
          variantTitle: variantMap[String(row.variant_id)]?.title ?? '',
          customerEmail: row.customer_email,
          customerId: row.customer_id ? Number(row.customer_id) : null,
          status: row.status,
          createdAt: row.created_at ? row.created_at.toISOString() : '',
          notifiedAt: row.notified_at ? row.notified_at.toISOString() : null
        }));

        return {
          total: Number(countResult[0].total),
          rows: enrichedRows,
          page: resolvedPage,
          pageSize: resolvedPageSize
        };
      }

      if (ctx.adminPath === '/notify') {
        const { variantId } = ctx.adminBody;
        if (!variantId) {
          return { notified: 0, variantId: null };
        }

        let gqlResult;
        try {
          gqlResult = await ctx.shopify.graphql(
            `query GetVariant($id: ID!) {
              productVariant(id: $id) {
                id
                title
                inventoryQuantity
                product {
                  id
                  title
                  handle
                  legacyResourceId
                  featuredImage { url }
                }
              }
            }`,
            { id: `gid://shopify/ProductVariant/${variantId}` }
          );
        } catch (err) {
          ctx.logger.error({ err: err.message, variantId }, 'admin /notify: graphql failed');
          return { notified: 0, variantId };
        }

        if (!gqlResult.productVariant) {
          return { notified: 0, variantId };
        }

        const productTitle = gqlResult.productVariant.product.title;
        const variantTitle = gqlResult.productVariant.title;
        const productHandle = gqlResult.productVariant.product.handle;
        const featuredImageUrl = gqlResult.productVariant.product.featuredImage?.url ?? null;

        let claimed;
        try {
          claimed = await ctx.db`
            UPDATE bisn_subscriptions
            SET notified_at = NOW(), status = 'notified'
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variantId}
              AND status = 'pending'
              AND notified_at IS NULL
            RETURNING id, customer_email
          `;
        } catch (err) {
          ctx.logger.error({ err: err.message, variantId }, 'admin /notify: update failed');
          return { notified: 0, variantId };
        }

        if (claimed.length === 0) {
          return { notified: 0, variantId };
        }

        for (const row of claimed) {
          try {
            await sendBackInStockEmail({
              recipientEmail: row.customer_email,
              productTitle,
              variantTitle,
              productHandle,
              variantId,
              featuredImageUrl
            });
          } catch (err) {
            ctx.logger.error({ err: err.message, recipientEmail: row.customer_email }, 'admin /notify: email failed');
          }
          ctx.logger.info({ tenantId: ctx.tenantId, variantId, productTitle, recipientEmail: row.customer_email }, 'bisn_admin_notification_sent');
        }

        return { notified: claimed.length, variantId };
      }

      if (ctx.adminPath === '/unsubscribe') {
        const { subscriptionId } = ctx.adminBody;
        if (!subscriptionId) {
          return { removed: false };
        }

        let deleteResult;
        try {
          deleteResult = await ctx.db`
            DELETE FROM bisn_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND id = ${subscriptionId}
            RETURNING id
          `;
        } catch (err) {
          ctx.logger.error({ err: err.message, subscriptionId }, 'admin /unsubscribe: delete failed');
          return { removed: false };
        }

        if (deleteResult.length === 0) {
          return { removed: false };
        }
        return { removed: true };
      }

      if (ctx.adminPath === '/stats') {
        let pendingResult, notifiedResult, topVariantRows;
        try {
          pendingResult = await ctx.db`
            SELECT COUNT(*) as totalPending FROM bisn_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND status = 'pending'
          `;
          notifiedResult = await ctx.db`
            SELECT COUNT(*) as totalNotified FROM bisn_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND status = 'notified'
          `;
          topVariantRows = await ctx.db`
            SELECT variant_id, product_id, COUNT(*) as subscriberCount
            FROM bisn_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND status = 'pending'
            GROUP BY variant_id, product_id
            ORDER BY subscriberCount DESC
            LIMIT 10
          `;
        } catch (err) {
          ctx.logger.error({ err: err.message }, 'admin /stats: db query failed');
          return { totalPending: 0, totalNotified: 0, topVariants: [] };
        }

        const productMap = {};
        const variantMap = {};

        if (topVariantRows.length > 0) {
          const productIds = [...new Set(topVariantRows.map(r => String(r.product_id)).filter(Boolean))];
          try {
            const { products } = await ctx.shopify.get(
              `/products.json?ids=${productIds.join(',')}&fields=id,title,variants`
            );
            for (const p of (products || [])) {
              productMap[String(p.id)] = p;
              for (const v of (p.variants || [])) {
                variantMap[String(v.id)] = v;
              }
            }
          } catch (err) {
            ctx.logger.warn({ err: err.message }, 'admin /stats: product fetch failed');
          }
        }

        const enrichedTopVariants = topVariantRows.map(row => ({
          variantId: Number(row.variant_id),
          productTitle: productMap[String(row.product_id)]?.title ?? '',
          variantTitle: variantMap[String(row.variant_id)]?.title ?? '',
          subscriberCount: Number(row.subscribercount ?? row.subscriberCount)
        }));

        return {
          totalPending: Number(pendingResult[0].totalpending ?? pendingResult[0].totalPending),
          totalNotified: Number(notifiedResult[0].totalnotified ?? notifiedResult[0].totalNotified),
          topVariants: enrichedTopVariants
        };
      }

      ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
      return { error: 'unknown path' };
    }

    // ─── Cron ─────────────────────────────────────────────────────────────────
    if (ctx.trigger === 'cron') {
      ctx.logger.info({ trigger: ctx.trigger }, 'bisn cron starting');

      let pendingRows;
      try {
        pendingRows = await ctx.db`
          SELECT DISTINCT variant_id, product_id, inventory_item_id
          FROM bisn_subscriptions
          WHERE tenant_id = ${ctx.tenantId}
            AND status = 'pending'
            AND notified_at IS NULL
        `;
      } catch (err) {
        ctx.logger.error({ err: err.message }, 'cron: pending query failed');
        return;
      }

      if (pendingRows.length === 0) {
        ctx.logger.info('cron: no pending subscriptions');
        return;
      }

      const distinctProductIds = [...new Set(pendingRows.map(r => String(r.product_id)))];
      const distinctInventoryItemIds = [...new Set(pendingRows.map(r => String(r.inventory_item_id)))];

      // Build product map
      const productMap = {};
      const PRODUCT_BATCH = 250;
      for (let i = 0; i < distinctProductIds.length; i += PRODUCT_BATCH) {
        const chunk = distinctProductIds.slice(i, i + PRODUCT_BATCH);
        try {
          const { products } = await ctx.shopify.get(
            `/products.json?ids=${chunk.join(',')}&fields=id,title,handle,images,variants`
          );
          if (!products || products.length === 0) continue;
          for (const product of products) {
            const variantsById = {};
            for (const variant of (product.variants || [])) {
              variantsById[String(variant.id)] = {
                variantTitle: variant.title,
                inventoryQuantity: variant.inventory_quantity
              };
            }
            productMap[String(product.id)] = {
              productTitle: product.title,
              productHandle: product.handle,
              featuredImageUrl: product.images?.[0]?.src ?? null,
              variantsById
            };
          }
        } catch (err) {
          ctx.logger.error({ err: err.message, chunk }, 'cron: product fetch failed');
        }
      }

      // Build inventory map
      const inventoryMap = new Map();
      const INV_BATCH = 50;
      for (let i = 0; i < distinctInventoryItemIds.length; i += INV_BATCH) {
        const chunk = distinctInventoryItemIds.slice(i, i + INV_BATCH);
        try {
          const { inventory_levels } = await ctx.shopify.get(
            `/inventory_levels.json?inventory_item_ids=${chunk.join(',')}&limit=250`
          );
          for (const level of (inventory_levels || [])) {
            const key = String(level.inventory_item_id);
            const prev = inventoryMap.get(key) || 0;
            inventoryMap.set(key, prev + Math.max(0, level.available || 0));
          }
        } catch (err) {
          ctx.logger.error({ err: err.message, chunk }, 'cron: inventory fetch failed');
        }
      }

      // Determine which variant_ids are in stock
      const inStockVariantIds = new Set();
      for (const row of pendingRows) {
        const total = inventoryMap.get(String(row.inventory_item_id)) || 0;
        if (total > 0) {
          inStockVariantIds.add(String(row.variant_id));
        }
      }

      if (inStockVariantIds.size === 0) {
        ctx.logger.info('cron: no variants back in stock');
        return;
      }

      for (const variantIdStr of inStockVariantIds) {
        const productRow = pendingRows.find(r => String(r.variant_id) === variantIdStr);
        if (!productRow) continue;

        const productData = productMap[String(productRow.product_id)];
        if (!productData) continue;

        const variantData = productData.variantsById[variantIdStr];
        if (!variantData) continue;

        let claimed;
        try {
          claimed = await ctx.db`
            UPDATE bisn_subscriptions
            SET notified_at = NOW(), status = 'notified'
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variantIdStr}
              AND status = 'pending'
              AND notified_at IS NULL
            RETURNING id, customer_email
          `;
        } catch (err) {
          ctx.logger.error({ err: err.message, variantId: variantIdStr }, 'cron: update failed');
          continue;
        }

        if (claimed.length === 0) continue;

        for (const row of claimed) {
          try {
            await sendBackInStockEmail({
              recipientEmail: row.customer_email,
              productTitle: productData.productTitle,
              variantTitle: variantData.variantTitle,
              productHandle: productData.productHandle,
              variantId: variantIdStr,
              featuredImageUrl: productData.featuredImageUrl
            });
          } catch (err) {
            ctx.logger.error({ err: err.message, recipientEmail: row.customer_email }, 'cron: email failed');
          }
          ctx.logger.info({ tenantId: ctx.tenantId, variantId: variantIdStr, productTitle: productData.productTitle, recipientEmail: row.customer_email }, 'bisn_cron_notification_sent');
        }
      }

      return;
    }

    // ─── Webhook: inventory_levels/update ────────────────────────────────────
    try {
      ctx.logger.info({ trigger: ctx.trigger, inventoryItemId: ctx.payload.inventory_item_id }, 'webhook: inventory_levels/update');

      if (!ctx.payload.inventory_item_id) {
        ctx.logger.warn('webhook: missing inventory_item_id');
        return;
      }

      const inventoryItemId = ctx.payload.inventory_item_id;
      let newAvailable = ctx.payload.available;
      if (newAvailable === null || newAvailable === undefined || newAvailable < 0) {
        newAvailable = 0;
      }

      // Read previous state
      const stateRows = await ctx.db`
        SELECT last_known_available FROM bisn_inventory_state
        WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventoryItemId}
      `;

      if (stateRows.length === 0) {
        // First observation — set baseline and exit
        await ctx.db`
          INSERT INTO bisn_inventory_state (tenant_id, inventory_item_id, last_known_available, updated_at)
          VALUES (${ctx.tenantId}, ${inventoryItemId}, ${newAvailable}, NOW())
          ON CONFLICT (tenant_id, inventory_item_id)
          DO UPDATE SET last_known_available = ${newAvailable}, updated_at = NOW()
        `;
        ctx.logger.info({ inventoryItemId, newAvailable }, 'webhook: first observation — baseline set');
        return;
      }

      const prevAvailable = stateRows[0].last_known_available;

      if (prevAvailable === null) {
        // Null sentinel — update state and exit
        await ctx.db`
          UPDATE bisn_inventory_state
          SET last_known_available = ${newAvailable}, updated_at = NOW()
          WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventoryItemId}
        `;
        ctx.logger.info({ inventoryItemId }, 'webhook: null sentinel — cannot confirm transition');
        return;
      }

      // Unconditional state update
      await ctx.db`
        UPDATE bisn_inventory_state
        SET last_known_available = ${newAvailable}, updated_at = NOW()
        WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventoryItemId}
      `;

      const prevNum = Number(prevAvailable);

      if (!(prevNum === 0 && newAvailable > 0)) {
        ctx.logger.info({ inventoryItemId, prevAvailable: prevNum, newAvailable }, 'webhook: no out-of-stock → in-stock transition');
        return;
      }

      ctx.logger.info({ inventoryItemId, prevAvailable: prevNum, newAvailable }, 'webhook: out-of-stock → in-stock transition detected');

      // Fetch variant and product via GraphQL
      let gqlResult;
      try {
        gqlResult = await ctx.shopify.graphql(
          `query GetInventoryItem($id: ID!) {
            inventoryItem(id: $id) {
              id
              variant {
                id
                title
                legacyResourceId
                product {
                  id
                  title
                  handle
                  legacyResourceId
                  featuredImage { url }
                }
              }
            }
          }`,
          { id: `gid://shopify/InventoryItem/${inventoryItemId}` }
        );
      } catch (err) {
        ctx.logger.error({ err: err.message, inventoryItemId }, 'webhook: graphql query failed');
        return;
      }

      if (!gqlResult.inventoryItem) {
        ctx.logger.warn({ inventoryItemId }, 'webhook: inventory item not found');
        return;
      }

      if (!gqlResult.inventoryItem.variant) {
        ctx.logger.warn({ inventoryItemId }, 'webhook: no variant linked to inventory item');
        return;
      }

      const variantId = gqlResult.inventoryItem.variant.legacyResourceId;
      const variantTitle = gqlResult.inventoryItem.variant.title;
      const productId = gqlResult.inventoryItem.variant.product.legacyResourceId;
      const productTitle = gqlResult.inventoryItem.variant.product.title;
      const productHandle = gqlResult.inventoryItem.variant.product.handle;
      const featuredImageUrl = gqlResult.inventoryItem.variant.product.featuredImage?.url ?? null;

      // Claim pending subscribers atomically
      let claimed;
      try {
        claimed = await ctx.db`
          UPDATE bisn_subscriptions
          SET notified_at = NOW(), status = 'notified'
          WHERE tenant_id = ${ctx.tenantId}
            AND variant_id = ${variantId}
            AND status = 'pending'
            AND notified_at IS NULL
          RETURNING id, customer_email
        `;
      } catch (err) {
        ctx.logger.error({ err: err.message, variantId }, 'webhook: update subscriptions failed');
        return;
      }

      if (claimed.length === 0) {
        ctx.logger.info({ variantId }, 'webhook: no pending subscribers or already claimed');
        return;
      }

      for (const row of claimed) {
        try {
          await sendBackInStockEmail({
            recipientEmail: row.customer_email,
            productTitle,
            variantTitle,
            productHandle,
            variantId,
            featuredImageUrl
          });
        } catch (err) {
          ctx.logger.error({ err: err.message, recipientEmail: row.customer_email }, 'webhook: email failed');
        }
        ctx.logger.info({ tenantId: ctx.tenantId, variantId, productTitle, recipientEmail: row.customer_email }, 'bisn_notification_sent');
      }

    } catch (err) {
      ctx.logger.error({ err: err.message }, 'webhook: unhandled error');
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE bisn_inventory_state (
  tenant_id             UUID    NOT NULL,
  inventory_item_id     BIGINT  NOT NULL,
  last_known_available  INTEGER,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, inventory_item_id)
);

ALTER TABLE bisn_inventory_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY bisn_inventory_state_tenant_isolation ON bisn_inventory_state
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE TABLE bisn_subscriptions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL,
  variant_id        BIGINT      NOT NULL,
  product_id        BIGINT      NOT NULL,
  inventory_item_id BIGINT      NOT NULL,
  customer_email    TEXT        NOT NULL,
  customer_id       BIGINT,
  status            TEXT        NOT NULL DEFAULT 'pending',
  notified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bisn_subscriptions_tenant_variant_email UNIQUE (tenant_id, variant_id, customer_email)
);

ALTER TABLE bisn_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY bisn_subscriptions_tenant_isolation ON bisn_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_bisn_subscriptions_tenant_variant_status
  ON bisn_subscriptions (tenant_id, variant_id, status);

CREATE INDEX idx_bisn_subscriptions_pending_notified
  ON bisn_subscriptions (tenant_id, status, notified_at)
  WHERE status = 'pending' AND notified_at IS NULL;
```

### widget.js

```javascript
export function mount(container, host) {
  const { customerId } = host.context;

  const style = document.createElement('style');
  style.textContent = `
    .bisn-widget {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 16px 0;
    }
    .bisn-widget__form {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 400px;
    }
    .bisn-widget__label {
      font-size: 14px;
      font-weight: 500;
      color: #333;
      margin-bottom: 2px;
    }
    .bisn-widget__input {
      padding: 10px 14px;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 14px;
      width: 100%;
      box-sizing: border-box;
      outline: none;
      transition: border-color 0.2s;
    }
    .bisn-widget__input:focus {
      border-color: #555;
    }
    .bisn-widget__btn {
      padding: 11px 20px;
      background: #222;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .bisn-widget__btn:hover:not(:disabled) {
      background: #444;
    }
    .bisn-widget__btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .bisn-widget__msg {
      font-size: 14px;
      padding: 10px 14px;
      border-radius: 4px;
      margin-top: 4px;
    }
    .bisn-widget__msg--success {
      background: #f0faf4;
      color: #1a7a3f;
      border: 1px solid #b2dfc4;
    }
    .bisn-widget__msg--info {
      background: #f0f4ff;
      color: #1a3a7a;
      border: 1px solid #b2c4df;
    }
    .bisn-widget__msg--error {
      background: #fff0f0;
      color: #7a1a1a;
      border: 1px solid #dfb2b2;
    }
    .bisn-widget__loader {
      font-size: 13px;
      color: #888;
      padding: 8px 0;
    }
  `;
  container.appendChild(style);

  const root = document.createElement('div');
  root.className = 'bisn-widget';
  container.appendChild(root);

  function render(html) {
    root.innerHTML = html;
  }

  function showLoader() {
    render('<div class="bisn-widget__loader">Loading&hellip;</div>');
  }

  function showMessage(text, type) {
    render(`<div class="bisn-widget__msg bisn-widget__msg--${type}">${text}</div>`);
  }

  function showForm(emailPrefill, alreadySubscribed) {
    if (alreadySubscribed) {
      showMessage('You are already signed up for this notification.', 'info');
      return;
    }
    root.innerHTML = `
      <form class="bisn-widget__form" id="bisn-form" novalidate>
        <label class="bisn-widget__label" for="bisn-email">Get notified when this is back in stock</label>
        <input
          class="bisn-widget__input"
          type="email"
          id="bisn-email"
          name="customerEmail"
          placeholder="Enter your email address"
          value="${emailPrefill || ''}"
          required
          autocomplete="email"
        />
        <button class="bisn-widget__btn" type="submit" id="bisn-btn">Notify Me</button>
        <div id="bisn-form-msg"></div>
      </form>
    `;

    const form = root.querySelector('#bisn-form');
    const btn = root.querySelector('#bisn-btn');
    const msgEl = root.querySelector('#bisn-form-msg');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = host.getFormData(form);
      const customerEmail = (data.customerEmail || '').trim();

      if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
        msgEl.innerHTML = '<div class="bisn-widget__msg bisn-widget__msg--error">Please enter a valid email address.</div>';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Submitting…';
      msgEl.innerHTML = '';

      try {
        const handle = location.pathname.match(/\/products\/([^/?#]+)/)?.[1];
        if (!handle) {
          throw new Error('No product handle found in URL.');
        }

        const variantId = new URLSearchParams(location.search).get('variant');
        if (!variantId) {
          throw new Error('No variant ID found in URL.');
        }

        const variantData = await host.storefront('/variants/' + variantId + '.js');
        const isOutOfStock = !variantData.available;

        if (!isOutOfStock) {
          showMessage('This product is now back in stock — no notification needed!', 'info');
          return;
        }

        const productId = String(variantData.product_id);

        const result = await host.call('/subscribe', {
          customerEmail,
          variantId,
          productId,
        });

        if (result.alreadySubscribed) {
          showMessage('You are already signed up for this notification.', 'info');
        } else if (result.success) {
          showMessage("You'll be notified when this is back in stock.", 'success');
        } else {
          throw new Error('Subscription failed. Please try again.');
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Notify Me';
        msgEl.innerHTML = `<div class="bisn-widget__msg bisn-widget__msg--error">${err.message || 'Something went wrong. Please try again.'}</div>`;
      }
    });
  }

  async function init() {
    showLoader();

    try {
      const variantId = new URLSearchParams(location.search).get('variant');

      if (!variantId) {
        root.innerHTML = '';
        return;
      }

      const variantData = await host.storefront('/variants/' + variantId + '.js');
      const isOutOfStock = !variantData.available;

      if (!isOutOfStock) {
        root.innerHTML = '';
        return;
      }

      let alreadySubscribed = false;

      try {
        const statusResult = await host.call('/status', {
          variantId,
          customerId: customerId || null,
        });
        alreadySubscribed = !!statusResult.alreadySubscribed;
      } catch (_) {
        alreadySubscribed = false;
      }

      showForm('', alreadySubscribed);
    } catch (err) {
      showMessage('Unable to load stock notification widget. Please refresh and try again.', 'error');
    }
  }

  init();
}
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  // ── Styles ──────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .bisn-tabs { display: flex; gap: var(--p-space-200); margin-bottom: var(--p-space-400); border-bottom: 1px solid var(--p-color-border); padding-bottom: 0; }
    .bisn-tab { background: none; border: none; border-bottom: 3px solid transparent; padding: var(--p-space-200) var(--p-space-400); font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text-secondary); cursor: pointer; margin-bottom: -1px; transition: color 0.15s, border-color 0.15s; }
    .bisn-tab.active { color: var(--p-color-text); border-bottom-color: #008060; }
    .bisn-tab:hover:not(.active) { color: var(--p-color-text); }
    .bisn-view { display: none; }
    .bisn-view.active { display: block; }
    .bisn-top-variants { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--p-space-300); margin-top: var(--p-space-300); }
    .bisn-variant-card { background: var(--p-color-bg-surface-secondary); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-200); padding: var(--p-space-300) var(--p-space-400); display: flex; flex-direction: column; gap: var(--p-space-100); }
    .bisn-variant-count { font-size: var(--p-font-size-500); font-weight: var(--p-font-weight-bold); color: var(--p-color-text); }
    .bisn-variant-title { font-size: var(--p-font-size-350); color: var(--p-color-text); font-weight: var(--p-font-weight-medium); }
    .bisn-variant-sub { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); }
    .bisn-notify-btn { font-size: var(--p-font-size-300); padding: var(--p-space-100) var(--p-space-200); margin-top: var(--p-space-100); }
    .bisn-toolbar-row { display: flex; align-items: center; gap: var(--p-space-200); margin-bottom: var(--p-space-300); flex-wrap: wrap; }
    .bisn-filter-select { background: var(--p-color-bg-surface); color: var(--p-color-text); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); padding: var(--p-space-200) var(--p-space-300); font-size: var(--p-font-size-350); cursor: pointer; }
    .bisn-email-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bisn-title-cell { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bisn-actions-cell { white-space: nowrap; display: flex; gap: var(--p-space-100); }
    .bisn-section-label { font-size: var(--p-font-size-300); font-weight: var(--p-font-weight-semibold); color: var(--p-color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--p-space-200); }
    .bisn-note { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-top: var(--p-space-200); }
  `;
  container.appendChild(style);

  // ── Root HTML ────────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.className = 'shell-root';
  root.innerHTML = `
    <div class="shell-header">
      <span class="shell-title">Back-in-Stock Notifications</span>
      <button class="btn-secondary" id="bisn-refresh">↻ Refresh</button>
    </div>

    <div class="bisn-tabs">
      <button class="bisn-tab active" data-tab="dashboard">Dashboard</button>
      <button class="bisn-tab" data-tab="subscribers">Subscribers</button>
    </div>

    <!-- DASHBOARD VIEW -->
    <div class="bisn-view active" id="bisn-view-dashboard">
      <div id="bisn-stats-area">
        <div class="shell-loading"><div class="shell-spinner"></div> Loading stats…</div>
      </div>
    </div>

    <!-- SUBSCRIBERS VIEW -->
    <div class="bisn-view" id="bisn-view-subscribers">
      <div class="bisn-toolbar-row">
        <input class="shell-search" id="bisn-search" placeholder="Search email or product…" style="flex:1;min-width:180px;" />
        <select class="bisn-filter-select" id="bisn-status-filter">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="notified">Notified</option>
        </select>
        <span id="bisn-record-count" style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);"></span>
      </div>
      <div id="bisn-subscribers-area">
        <div class="shell-loading"><div class="shell-spinner"></div> Loading subscribers…</div>
      </div>
      <div class="shell-pagination" id="bisn-pagination" style="display:none;">
        <span id="bisn-page-info" style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);"></span>
        <div class="shell-pagination-btns">
          <button class="btn-secondary" id="bisn-prev-page" disabled>← Prev</button>
          <button class="btn-secondary" id="bisn-next-page" disabled>Next →</button>
        </div>
      </div>
    </div>

    <!-- CONFIRM DIALOG -->
    <div class="shell-confirm-overlay" id="bisn-confirm-overlay" style="display:none;">
      <div class="shell-confirm-dialog">
        <div class="shell-confirm-title" id="bisn-confirm-title"></div>
        <div class="shell-confirm-body" id="bisn-confirm-body"></div>
        <div class="shell-confirm-actions">
          <button class="btn-secondary" id="bisn-confirm-cancel">Cancel</button>
          <button class="btn-primary" id="bisn-confirm-ok">Confirm</button>
        </div>
      </div>
    </div>
  `;
  container.appendChild(root);

  // ── State ────────────────────────────────────────────────────────────────────
  let currentTab = 'dashboard';
  let subscribersData = { rows: [], total: 0, page: 1, pageSize: 50 };
  let searchQuery = '';
  let statusFilter = '';
  let loadingSubscribers = false;
  let loadingStats = false;
  let confirmResolve = null;

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function qs(sel) { return container.querySelector(sel); }

  function showConfirm(title, body) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      qs('#bisn-confirm-title').textContent = title;
      qs('#bisn-confirm-body').textContent = body;
      qs('#bisn-confirm-overlay').style.display = 'flex';
    });
  }

  function hideConfirm() {
    qs('#bisn-confirm-overlay').style.display = 'none';
    confirmResolve = null;
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDate(str) {
    if (!str) return '—';
    try {
      return new Date(str).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return str; }
  }

  // ── Tab switching ────────────────────────────────────────────────────────────
  container.querySelectorAll('.bisn-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.bisn-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      container.querySelectorAll('.bisn-view').forEach(v => v.classList.remove('active'));
      qs(`#bisn-view-${currentTab}`).classList.add('active');
    });
  });

  // ── Confirm dialog events ────────────────────────────────────────────────────
  qs('#bisn-confirm-cancel').addEventListener('click', () => {
    if (confirmResolve) confirmResolve(false);
    hideConfirm();
  });
  qs('#bisn-confirm-ok').addEventListener('click', () => {
    if (confirmResolve) confirmResolve(true);
    hideConfirm();
  });

  // ── STATS ────────────────────────────────────────────────────────────────────
  async function loadStats() {
    if (loadingStats) return;
    loadingStats = true;
    const area = qs('#bisn-stats-area');
    area.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div> Loading stats…</div>';

    try {
      const stats = await bridge.call('/stats');
      renderStats(stats);
    } catch (err) {
      area.innerHTML = `<div class="shell-error-banner">Failed to load stats: ${escHtml(err?.message || String(err))}</div>`;
    } finally {
      loadingStats = false;
    }
  }

  function renderStats(stats) {
    const area = qs('#bisn-stats-area');
    const topVariantsHtml = (stats.topVariants && stats.topVariants.length > 0)
      ? stats.topVariants.map(v => `
          <div class="bisn-variant-card">
            <div class="bisn-variant-count">${escHtml(String(v.subscriberCount))}</div>
            <div class="bisn-variant-title">${escHtml(v.productTitle || 'Unknown Product')}</div>
            <div class="bisn-variant-sub">${escHtml(v.variantTitle || 'Default')}</div>
            <button class="btn-primary bisn-notify-btn" data-variant-id="${escHtml(String(v.variantId))}" data-product-title="${escHtml(v.productTitle || '')}" data-variant-title="${escHtml(v.variantTitle || '')}">
              Send Notifications
            </button>
          </div>
        `).join('')
      : '<p style="color:var(--p-color-text-secondary);font-size:var(--p-font-size-350);">No pending subscribers yet.</p>';

    area.innerHTML = `
      <div class="shell-stats-row">
        <div class="shell-stat-card">
          <div class="shell-stat-label">Pending Subscribers</div>
          <div class="shell-stat-value">${escHtml(String(stats.totalPending ?? 0))}</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Notified</div>
          <div class="shell-stat-value">${escHtml(String(stats.totalNotified ?? 0))}</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Total Subscriptions</div>
          <div class="shell-stat-value">${escHtml(String((stats.totalPending ?? 0) + (stats.totalNotified ?? 0)))}</div>
        </div>
      </div>

      <div class="shell-card" style="margin-top:var(--p-space-400);">
        <div class="bisn-section-label">Top Variants Awaiting Restock</div>
        <p style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);margin-bottom:var(--p-space-200);">
          Showing up to 10 variants with the most pending subscribers. Click "Send Notifications" when a product is back in stock.
        </p>
        <div class="bisn-top-variants">${topVariantsHtml}</div>
        <p class="bisn-note">⚠ Email delivery is fire-and-forget. Delivery confirmations are logged and available for external reconciliation in Phase 3.</p>
      </div>
    `;

    // Bind notify buttons
    area.querySelectorAll('.bisn-notify-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const variantId = parseInt(btn.dataset.variantId, 10);
        const productTitle = btn.dataset.productTitle;
        const variantTitle = btn.dataset.variantTitle;
        const confirmed = await showConfirm(
          'Send Notifications',
          `Send back-in-stock emails to all pending subscribers for "${productTitle}${variantTitle && variantTitle !== 'Default Title' ? ` — ${variantTitle}` : ''}"?`
        );
        if (!confirmed) return;
        await triggerNotify(variantId, btn);
      });
    });
  }

  async function triggerNotify(variantId, btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Sending…'; }
    try {
      const result = await bridge.call('/notify', { variantId });
      if (result.notified > 0) {
        bridge.notify(`✓ Sent ${result.notified} notification${result.notified !== 1 ? 's' : ''}`, 'success');
      } else {
        bridge.notify('No pending subscribers found for this variant.', 'info');
      }
      // Reload stats and subscribers
      await Promise.all([loadStats(), currentTab === 'subscribers' ? loadSubscribers() : Promise.resolve()]);
    } catch (err) {
      bridge.notify(`Failed to send notifications: ${err?.message || String(err)}`, 'error');
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Send Notifications'; }
    }
  }

  // ── SUBSCRIBERS ──────────────────────────────────────────────────────────────
  async function loadSubscribers(page = 1) {
    if (loadingSubscribers) return;
    loadingSubscribers = true;
    const area = qs('#bisn-subscribers-area');
    area.innerHTML = '<div class="shell-loading"><div class="shell-spinner"></div> Loading subscribers…</div>';
    qs('#bisn-pagination').style.display = 'none';

    try {
      const result = await bridge.call('/subscribers', { page, pageSize: 50 });
      subscribersData = result;
      renderSubscribers();
    } catch (err) {
      area.innerHTML = `<div class="shell-error-banner">Failed to load subscribers: ${escHtml(err?.message || String(err))}</div>`;
    } finally {
      loadingSubscribers = false;
    }
  }

  function getFilteredRows() {
    let rows = subscribersData.rows || [];
    if (statusFilter) {
      rows = rows.filter(r => r.status === statusFilter);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter(r =>
        (r.customerEmail || '').toLowerCase().includes(q) ||
        (r.productTitle || '').toLowerCase().includes(q) ||
        (r.variantTitle || '').toLowerCase().includes(q)
      );
    }
    return rows;
  }

  function renderSubscribers() {
    const area = qs('#bisn-subscribers-area');
    const rows = getFilteredRows();
    const total = subscribersData.total || 0;
    const page = subscribersData.page || 1;
    const pageSize = subscribersData.pageSize || 50;

    qs('#bisn-record-count').textContent = `${rows.length} of ${total} records`;

    if (rows.length === 0) {
      area.innerHTML = '<div class="shell-empty">No subscribers found.</div>';
      qs('#bisn-pagination').style.display = 'none';
      return;
    }

    const rowsHtml = rows.map(r => `
      <tr>
        <td class="bisn-email-cell" title="${escHtml(r.customerEmail)}">${escHtml(r.customerEmail || '—')}</td>
        <td class="bisn-title-cell" title="${escHtml(r.productTitle)}">${escHtml(r.productTitle || '—')}</td>
        <td class="bisn-title-cell" title="${escHtml(r.variantTitle)}">${escHtml(r.variantTitle || 'Default')}</td>
        <td>
          <span class="badge ${r.status === 'pending' ? 'badge-warning' : r.status === 'notified' ? 'badge-success' : 'badge-neutral'}">
            ${escHtml(r.status || '—')}
          </span>
        </td>
        <td style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);">${formatDate(r.createdAt)}</td>
        <td style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);">${r.notifiedAt ? formatDate(r.notifiedAt) : '—'}</td>
        <td>
          <div class="bisn-actions-cell">
            ${r.status === 'pending' ? `<button class="btn-primary bisn-notify-row-btn" style="font-size:var(--p-font-size-300);padding:var(--p-space-100) var(--p-space-200);" data-variant-id="${escHtml(String(r.variantId))}" data-product-title="${escHtml(r.productTitle||'')}" data-variant-title="${escHtml(r.variantTitle||'')}">Notify</button>` : ''}
            <button class="btn-danger bisn-remove-btn" style="font-size:var(--p-font-size-300);padding:var(--p-space-100) var(--p-space-200);" data-id="${escHtml(String(r.id))}" data-email="${escHtml(r.customerEmail||'')}">Remove</button>
          </div>
        </td>
      </tr>
    `).join('');

    area.innerHTML = `
      <div class="shell-table-wrap">
        <table class="shell-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Product</th>
              <th>Variant</th>
              <th>Status</th>
              <th>Subscribed</th>
              <th>Notified</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;

    // Pagination
    const totalPages = Math.ceil(total / pageSize);
    if (totalPages > 1) {
      qs('#bisn-pagination').style.display = 'flex';
      qs('#bisn-page-info').textContent = `Page ${page} of ${totalPages} (${total} total)`;
      qs('#bisn-prev-page').disabled = page <= 1;
      qs('#bisn-next-page').disabled = page >= totalPages;
    } else {
      qs('#bisn-pagination').style.display = 'none';
    }

    // Bind row notify buttons
    area.querySelectorAll('.bisn-notify-row-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const variantId = parseInt(btn.dataset.variantId, 10);
        const productTitle = btn.dataset.productTitle;
        const variantTitle = btn.dataset.variantTitle;
        const confirmed = await showConfirm(
          'Send Notifications',
          `Send back-in-stock emails to all pending subscribers for "${productTitle}${variantTitle && variantTitle !== 'Default Title' ? ` — ${variantTitle}` : ''}"?`
        );
        if (!confirmed) return;
        await triggerNotify(variantId, btn);
      });
    });

    // Bind remove buttons
    area.querySelectorAll('.bisn-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const subscriptionId = btn.dataset.id;
        const email = btn.dataset.email;
        const confirmed = await showConfirm(
          'Remove Subscriber',
          `Remove subscription for "${email}"? This cannot be undone.`
        );
        if (!confirmed) return;
        btn.disabled = true;
        btn.textContent = 'Removing…';
        try {
          const result = await bridge.call('/unsubscribe', { subscriptionId });
          if (result.removed) {
            bridge.notify('Subscriber removed.', 'success');
            await loadSubscribers(subscribersData.page);
          } else {
            bridge.notify('Subscription not found or already removed.', 'info');
            btn.disabled = false;
            btn.textContent = 'Remove';
          }
        } catch (err) {
          bridge.notify(`Failed to remove: ${err?.message || String(err)}`, 'error');
          btn.disabled = false;
          btn.textContent = 'Remove';
        }
      });
    });
  }

  // ── Search & filter (client-side on loaded page) ──────────────────────────
  let searchDebounce = null;
  qs('#bisn-search').addEventListener('input', (e) => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = e.target.value.trim();
      renderSubscribers();
    }, 300);
  });

  qs('#bisn-status-filter').addEventListener('change', (e) => {
    statusFilter = e.target.value;
    renderSubscribers();
  });

  // ── Pagination buttons ───────────────────────────────────────────────────────
  qs('#bisn-prev-page').addEventListener('click', () => {
    if (subscribersData.page > 1) loadSubscribers(subscribersData.page - 1);
  });
  qs('#bisn-next-page').addEventListener('click', () => {
    const totalPages = Math.ceil(subscribersData.total / subscribersData.pageSize);
    if (subscribersData.page < totalPages) loadSubscribers(subscribersData.page + 1);
  });

  // ── Refresh button ───────────────────────────────────────────────────────────
  qs('#bisn-refresh').addEventListener('click', () => {
    loadStats();
    if (currentTab === 'subscribers') loadSubscribers(subscribersData.page);
  });

  // ── Initial load ─────────────────────────────────────────────────────────────
  loadStats();

  // Load subscribers when tab is first activated
  container.querySelectorAll('.bisn-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'subscribers' && (!subscribersData.rows || subscribersData.rows.length === 0)) {
        loadSubscribers(1);
      }
    });
  });
}
```


## Explanation

Your back-in-stock notification app lets customers sign up for alerts right on your storefront when products sell out. When a customer clicks "Notify me" on an out-of-stock item, their email address is saved. The moment that product comes back in stock, your subscribers automatically receive an email letting them know it's available again — no manual work needed.

You control everything from your Shopify Admin dashboard. You can see a list of all customers waiting for notifications, organized by product. You can also manually send notifications to subscribers whenever you want — just visit the dashboard, find the product, and click "Send notification now." The app checks inventory every hour to catch restocks and trigger emails automatically. You'll see a summary of how many notifications were sent and can review subscriber lists at any time.
