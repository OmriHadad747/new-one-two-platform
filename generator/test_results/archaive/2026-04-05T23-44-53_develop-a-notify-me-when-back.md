# Feature Generator — Run Result

**Date:** 2026-04-05 23:44:53  
**Status:** ✅ SUCCESS  
**Total:** 230947ms  
**Prompt:** Develop a Notify Me When Back In Stock Shopify app with admin interface for managing subscriptions and notifications.

## Pipeline

| Agent       | Status | Time       |
|-------------|--------|------------|
| Product     | ✓      | 3017ms     |
| Architect   | ✓      | 39157ms    |
| CodeSpec    | ✓      | 58169ms    |
| Handler     | ✓      | 66138ms    |
| Migration   | ✓      | 66138ms    |
| Widget JS   | ✓      | 66138ms    |
| Admin UI    | ✓      | 66138ms    |
| Validation  | ✓      | 25ms       |
| Explanation | ✓      | 8105ms     |

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
        if (ctx.widgetPath === '/subscribe') {
          const { customerEmail, productId, variantId } = ctx.widgetBody;
          if (!customerEmail || !variantId || !productId) {
            return { success: false, alreadySubscribed: false };
          }
          let variantResp;
          try {
            variantResp = await ctx.shopify.get(`/variants/${variantId}.json`);
          } catch (e) {
            ctx.logger.error({ err: e.message }, 'Failed to fetch variant');
            return { success: false, alreadySubscribed: false };
          }
          if (!variantResp || !variantResp.variant) {
            return { success: false, alreadySubscribed: false };
          }
          const variant = variantResp.variant;
          // If variant is in stock, do not accept subscription
          if (
            variant.inventory_management !== null &&
            variant.inventory_policy === 'deny' &&
            variant.inventory_quantity > 0
          ) {
            return { success: false, alreadySubscribed: false };
          }
          const insertedRows = await ctx.db`
            INSERT INTO back_in_stock_subscriptions
              (id, tenant_id, variant_id, product_id, customer_id, customer_email, subscribed_at, notified_at, status)
            VALUES
              (gen_random_uuid(), ${ctx.tenantId}, ${variantId}, ${productId}, NULL, ${customerEmail}, NOW(), NULL, 'active')
            ON CONFLICT (tenant_id, variant_id, customer_email) DO NOTHING
            RETURNING id
          `;
          const alreadySubscribed = insertedRows.length === 0;
          return { success: true, alreadySubscribed };
        }

        if (ctx.widgetPath === '/status') {
          const { customerId, variantId } = ctx.widgetBody;
          if (!variantId) {
            return { alreadySubscribed: false };
          }
          if (!customerId) {
            return { alreadySubscribed: false };
          }
          const statusRows = await ctx.db`
            SELECT id FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variantId}
              AND customer_id = ${customerId}
              AND status = 'active'
              AND notified_at IS NULL
          `;
          return { alreadySubscribed: statusRows.length > 0 };
        }

        return { error: 'unknown path' };
      }

      // ── ADMIN ───────────────────────────────────────────────────────────────
      if (ctx.trigger === 'admin') {
        ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

        if (ctx.adminPath === '/subscribers') {
          const { page, pageSize, statusFilter } = ctx.adminBody;
          const resolvedPage = page ?? 1;
          const resolvedPageSize = pageSize ?? 50;
          const offset = (resolvedPage - 1) * resolvedPageSize;

          let totalRows, rows;
          if (statusFilter) {
            totalRows = await ctx.db`
              SELECT COUNT(*) AS count FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${statusFilter}
            `;
            rows = await ctx.db`
              SELECT id, variant_id, product_id, customer_email, customer_id, subscribed_at, notified_at, status
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${statusFilter}
              ORDER BY subscribed_at DESC
              LIMIT ${resolvedPageSize} OFFSET ${offset}
            `;
          } else {
            totalRows = await ctx.db`
              SELECT COUNT(*) AS count FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
            `;
            rows = await ctx.db`
              SELECT id, variant_id, product_id, customer_email, customer_id, subscribed_at, notified_at, status
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
              ORDER BY subscribed_at DESC
              LIMIT ${resolvedPageSize} OFFSET ${offset}
            `;
          }

          const total = Number(totalRows[0].count);
          if (rows.length === 0) {
            return { total, rows: [] };
          }

          // Batch fetch product info
          const productIds = [...new Set(rows.map(r => String(r.product_id)))];
          const productMap = {};
          const variantMap = {};
          const PRODUCT_BATCH = 250;
          for (let i = 0; i < productIds.length; i += PRODUCT_BATCH) {
            const chunk = productIds.slice(i, i + PRODUCT_BATCH);
            const { products } = await ctx.shopify.get(
              `/products.json?ids=${chunk.join(',')}&fields=id,title,variants`
            );
            for (const p of (products || [])) {
              productMap[String(p.id)] = { productTitle: p.title };
              for (const v of (p.variants || [])) {
                variantMap[String(v.id)] = { variantTitle: v.title };
              }
            }
          }

          const mappedRows = rows.map(row => ({
            id: row.id,
            variantId: row.variant_id,
            productId: row.product_id,
            productTitle: productMap[String(row.product_id)]?.productTitle ?? '',
            variantTitle: variantMap[String(row.variant_id)]?.variantTitle ?? '',
            customerEmail: row.customer_email,
            customerId: row.customer_id,
            subscribedAt: row.subscribed_at,
            notifiedAt: row.notified_at,
            status: row.status,
          }));

          return { total, rows: mappedRows };
        }

        if (ctx.adminPath === '/subscribers/delete') {
          const { id } = ctx.adminBody;
          if (!id) {
            return { deleted: 0 };
          }
          const claimed = await ctx.db`
            DELETE FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
            RETURNING id
          `;
          if (claimed.length === 0) {
            return { deleted: 0 };
          }
          return { deleted: claimed.length };
        }

        if (ctx.adminPath === '/config/get') {
          const configRows = await ctx.db`
            SELECT email_subject, email_from_name, notify_once_per_subscriber, auto_resubscribe_after_notification
            FROM bis_config
            WHERE tenant_id = ${ctx.tenantId}
          `;
          if (configRows.length === 0) {
            return {
              emailSubject: 'Your item is back in stock!',
              emailFromName: 'Store Notifications',
              notifyOncePerSubscriber: true,
              autoResubscribeAfterNotification: false,
            };
          }
          const row = configRows[0];
          return {
            emailSubject: row.email_subject,
            emailFromName: row.email_from_name,
            notifyOncePerSubscriber: row.notify_once_per_subscriber,
            autoResubscribeAfterNotification: row.auto_resubscribe_after_notification,
          };
        }

        if (ctx.adminPath === '/config/save') {
          const { autoResubscribeAfterNotification, emailFromName, emailSubject, notifyOncePerSubscriber } = ctx.adminBody;
          if (!emailSubject || !emailFromName) {
            return { saved: false };
          }
          await ctx.db`
            INSERT INTO bis_config
              (id, tenant_id, email_subject, email_from_name, notify_once_per_subscriber, auto_resubscribe_after_notification, updated_at)
            VALUES
              (gen_random_uuid(), ${ctx.tenantId}, ${emailSubject}, ${emailFromName}, ${notifyOncePerSubscriber}, ${autoResubscribeAfterNotification}, NOW())
            ON CONFLICT (tenant_id) DO UPDATE SET
              email_subject = ${emailSubject},
              email_from_name = ${emailFromName},
              notify_once_per_subscriber = ${notifyOncePerSubscriber},
              auto_resubscribe_after_notification = ${autoResubscribeAfterNotification},
              updated_at = NOW()
          `;
          ctx.logger.info({ adminPath: ctx.adminPath }, 'config saved');
          return { saved: true };
        }

        if (ctx.adminPath === '/stats') {
          const [totalRowsRes, notifiedRowsRes, pendingRowsRes, topVariantRows] = await Promise.all([
            ctx.db`SELECT COUNT(*) AS total FROM back_in_stock_subscriptions WHERE tenant_id = ${ctx.tenantId}`,
            ctx.db`SELECT COUNT(*) AS total FROM back_in_stock_subscriptions WHERE tenant_id = ${ctx.tenantId} AND notified_at IS NOT NULL`,
            ctx.db`SELECT COUNT(*) AS total FROM back_in_stock_subscriptions WHERE tenant_id = ${ctx.tenantId} AND notified_at IS NULL AND status = 'active'`,
            ctx.db`SELECT variant_id, product_id, COUNT(*) AS subscriber_count FROM back_in_stock_subscriptions WHERE tenant_id = ${ctx.tenantId} GROUP BY variant_id, product_id ORDER BY subscriber_count DESC LIMIT 5`,
          ]);

          let topVariants = [];
          if (topVariantRows.length > 0) {
            const topProductIds = [...new Set(topVariantRows.map(r => String(r.product_id)))];
            const topProductMap = {};
            if (topProductIds.length > 0) {
              const { products } = await ctx.shopify.get(
                `/products.json?ids=${topProductIds.join(',')}&fields=id,title`
              );
              for (const p of (products || [])) {
                topProductMap[String(p.id)] = p.title;
              }
            }
            topVariants = topVariantRows.map(r => ({
              variantId: r.variant_id,
              productTitle: topProductMap[String(r.product_id)] ?? '',
              subscriberCount: Number(r.subscriber_count),
            }));
          }

          return {
            totalSubscriptions: Number(totalRowsRes[0].total),
            totalNotificationsSent: Number(notifiedRowsRes[0].total),
            pendingNotifications: Number(pendingRowsRes[0].total),
            topVariants,
          };
        }

        ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
        return { error: 'unknown path' };
      }

      // ── WEBHOOK ─────────────────────────────────────────────────────────────
      if (ctx.trigger === 'webhook') {
        ctx.logger.info({ trigger: ctx.trigger, inventory_item_id: ctx.payload.inventory_item_id }, 'inventory_levels/update received');

        if (!ctx.payload.inventory_item_id) {
          ctx.logger.warn('Missing inventory_item_id in payload');
          return;
        }
        if (ctx.payload.available === undefined || ctx.payload.available === null) {
          ctx.logger.warn('Missing available in payload');
          return;
        }

        const newQuantity = Number(ctx.payload.available);
        const inventoryItemId = Number(ctx.payload.inventory_item_id);

        // Resolve variant and product via GraphQL
        let gqlResp;
        try {
          gqlResp = await ctx.shopify.graphql(
            `query GetInventoryItem($id: ID!) {
              inventoryItem(id: $id) {
                variant {
                  id
                  legacyResourceId
                  title
                  product {
                    title
                    onlineStoreUrl
                    featuredImage {
                      url
                    }
                  }
                }
              }
            }`,
            { id: `gid://shopify/InventoryItem/${inventoryItemId}` }
          );
        } catch (e) {
          ctx.logger.error({ err: e.message }, 'GraphQL query failed');
          return;
        }

        if (!gqlResp.inventoryItem) {
          ctx.logger.warn({ inventoryItemId }, 'Inventory item not found or deleted');
          return;
        }
        if (!gqlResp.inventoryItem.variant) {
          ctx.logger.warn({ inventoryItemId }, 'No variant linked to inventory item');
          return;
        }

        const variantId = Number(gqlResp.inventoryItem.variant.legacyResourceId);
        const productTitle = gqlResp.inventoryItem.variant.product.title;
        const productOnlineStoreUrl = gqlResp.inventoryItem.variant.product.onlineStoreUrl;
        const featuredImageUrl = gqlResp.inventoryItem.variant.product.featuredImage?.url ?? null;

        // Read previous inventory state
        const stateRows = await ctx.db`
          SELECT available_quantity FROM inventory_state
          WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventoryItemId}
        `;

        if (stateRows.length === 0) {
          // Unknown sentinel — establish baseline, skip notification
          await ctx.db`
            INSERT INTO inventory_state (tenant_id, inventory_item_id, available_quantity, updated_at)
            VALUES (${ctx.tenantId}, ${inventoryItemId}, ${newQuantity}, NOW())
            ON CONFLICT (tenant_id, inventory_item_id) DO UPDATE SET
              available_quantity = ${newQuantity},
              updated_at = NOW()
          `;
          ctx.logger.info({ inventoryItemId, newQuantity }, 'Baseline established — skip notification');
          return;
        }

        const prevQuantity = stateRows[0].available_quantity;

        if (prevQuantity === null) {
          // Sentinel null — cannot confirm transition
          await ctx.db`
            INSERT INTO inventory_state (tenant_id, inventory_item_id, available_quantity, updated_at)
            VALUES (${ctx.tenantId}, ${inventoryItemId}, ${newQuantity}, NOW())
            ON CONFLICT (tenant_id, inventory_item_id) DO UPDATE SET
              available_quantity = ${newQuantity},
              updated_at = NOW()
          `;
          ctx.logger.info({ inventoryItemId }, 'Prev quantity null — skip notification');
          return;
        }

        // Update state
        await ctx.db`
          INSERT INTO inventory_state (tenant_id, inventory_item_id, available_quantity, updated_at)
          VALUES (${ctx.tenantId}, ${inventoryItemId}, ${newQuantity}, NOW())
          ON CONFLICT (tenant_id, inventory_item_id) DO UPDATE SET
            available_quantity = ${newQuantity},
            updated_at = NOW()
        `;

        const prevQty = Number(prevQuantity);
        if (!(prevQty === 0 && newQuantity > 0)) {
          ctx.logger.info({ prevQty, newQuantity }, 'Not a back-in-stock transition — skip');
          return;
        }

        ctx.logger.info({ variantId, prevQty, newQuantity }, 'Back-in-stock transition detected');

        // Atomically claim pending subscribers
        const claimed = await ctx.db`
          UPDATE back_in_stock_subscriptions
          SET notified_at = NOW()
          WHERE tenant_id = ${ctx.tenantId}
            AND variant_id = ${variantId}
            AND status = 'active'
            AND notified_at IS NULL
          RETURNING id, customer_email, customer_id, variant_id, product_id
        `;

        if (claimed.length === 0) {
          ctx.logger.info({ variantId }, 'No pending subscribers — nothing to notify');
          return;
        }

        ctx.logger.info({ variantId, claimedCount: claimed.length }, 'Claimed subscribers for notification');

        // Load config
        const configRows = await ctx.db`
          SELECT email_subject, email_from_name, notify_once_per_subscriber, auto_resubscribe_after_notification
          FROM bis_config
          WHERE tenant_id = ${ctx.tenantId}
        `;
        const emailSubject = configRows.length > 0 ? configRows[0].email_subject : 'Your item is back in stock!';
        const emailFromName = configRows.length > 0 ? configRows[0].email_from_name : 'Store Notifications';
        const configAutoResubscribe = configRows.length > 0 ? configRows[0].auto_resubscribe_after_notification : false;

        // Send notifications
        for (const row of claimed) {
          try {
            await ctx.services.email.send({
              to: row.customer_email,
              subject: emailSubject,
              data: {
                productTitle,
                variantId: row.variant_id,
                featuredImageUrl,
                productOnlineStoreUrl,
              },
            });
          } catch (e) {
            ctx.logger.error({ err: e.message, email: row.customer_email }, 'Failed to send email');
          }
        }

        // Auto-resubscribe if configured
        if (configAutoResubscribe) {
          const claimedIds = claimed.map(r => r.id);
          await ctx.db`
            UPDATE back_in_stock_subscriptions
            SET notified_at = NULL
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variantId}
              AND status = 'active'
              AND id = ANY(${claimedIds})
          `;
          ctx.logger.info({ variantId, count: claimedIds.length }, 'Auto-resubscribed subscribers');
        }

        return;
      }

    } catch (err) {
      ctx.logger.error({ err: err.message, stack: err.stack }, 'Unhandled error in handler');
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE inventory_state (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL,
  inventory_item_id   BIGINT      NOT NULL,
  available_quantity  INTEGER,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_inv_state UNIQUE (tenant_id, inventory_item_id)
);

ALTER TABLE inventory_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_state_tenant_isolation ON inventory_state
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE TABLE back_in_stock_subscriptions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL,
  variant_id     BIGINT      NOT NULL,
  product_id     BIGINT      NOT NULL,
  customer_id    BIGINT,
  customer_email TEXT        NOT NULL,
  subscribed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at    TIMESTAMPTZ,
  status         TEXT        NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bis_tenant_variant_email UNIQUE (tenant_id, variant_id, customer_email)
);

ALTER TABLE back_in_stock_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY back_in_stock_subscriptions_tenant_isolation ON back_in_stock_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_bis_tenant_variant_status_notified
  ON back_in_stock_subscriptions (tenant_id, variant_id, status, notified_at);

CREATE INDEX idx_bis_tenant_variant_customer
  ON back_in_stock_subscriptions (tenant_id, variant_id, customer_id);

CREATE TABLE bis_config (
  id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       UUID        NOT NULL UNIQUE,
  email_subject                   TEXT,
  email_from_name                 TEXT,
  notify_once_per_subscriber      BOOLEAN     NOT NULL DEFAULT TRUE,
  auto_resubscribe_after_notification BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE bis_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY bis_config_tenant_isolation ON bis_config
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);
```

### widget.js

```javascript
export function mount(container, host) {
  const style = document.createElement('style');
  style.textContent = `
    .bis-widget {
      font-family: inherit;
      margin: 12px 0;
    }
    .bis-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 400px;
    }
    .bis-form-row {
      display: flex;
      gap: 8px;
    }
    .bis-input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
      min-width: 0;
    }
    .bis-input:focus {
      border-color: #333;
    }
    .bis-btn {
      padding: 10px 18px;
      background: #333;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 14px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.2s;
    }
    .bis-btn:hover:not(:disabled) {
      background: #111;
    }
    .bis-btn:disabled {
      background: #999;
      cursor: not-allowed;
    }
    .bis-message {
      font-size: 14px;
      padding: 10px 14px;
      border-radius: 4px;
      max-width: 400px;
    }
    .bis-message.success {
      background: #f0faf0;
      color: #2a7a2a;
      border: 1px solid #b2dfb2;
    }
    .bis-message.info {
      background: #fff8e1;
      color: #7a5c00;
      border: 1px solid #ffe082;
    }
    .bis-message.error {
      background: #fdf0f0;
      color: #a00;
      border: 1px solid #f5c6c6;
    }
    .bis-label {
      font-size: 13px;
      color: #555;
      margin-bottom: 2px;
    }
    .bis-loading {
      font-size: 13px;
      color: #888;
    }
    .bis-error-field {
      border-color: #c00 !important;
    }
    .bis-field-error {
      font-size: 12px;
      color: #c00;
    }
  `;
  container.appendChild(style);

  const root = document.createElement('div');
  root.className = 'bis-widget';
  container.appendChild(root);

  function render(html) {
    root.innerHTML = html;
  }

  function renderLoading() {
    render('<span class="bis-loading">Checking availability...</span>');
  }

  function renderEmpty() {
    root.innerHTML = '';
  }

  function renderForm(emailHint, errorMsg) {
    root.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'bis-form';

    const label = document.createElement('div');
    label.className = 'bis-label';
    label.textContent = 'Get notified when this item is back in stock:';
    wrapper.appendChild(label);

    const row = document.createElement('div');
    row.className = 'bis-form-row';

    const input = document.createElement('input');
    input.type = 'email';
    input.className = 'bis-input' + (errorMsg ? ' bis-error-field' : '');
    input.placeholder = 'Enter your email address';
    input.value = emailHint || '';
    input.setAttribute('autocomplete', 'email');
    input.setAttribute('name', 'customerEmail');
    row.appendChild(input);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bis-btn';
    btn.textContent = 'Notify Me';
    row.appendChild(btn);

    wrapper.appendChild(row);

    if (errorMsg) {
      const fieldErr = document.createElement('div');
      fieldErr.className = 'bis-field-error';
      fieldErr.textContent = errorMsg;
      wrapper.appendChild(fieldErr);
    }

    root.appendChild(wrapper);

    btn.addEventListener('click', () => {
      const email = input.value.trim();
      if (!email || !isValidEmail(email)) {
        renderForm(email, 'Please enter a valid email address.');
        return;
      }
      handleSubscribe(email);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        btn.click();
      }
    });
  }

  function renderMessage(type, text) {
    render(`<div class="bis-message ${type}">${escapeHtml(text)}</div>`);
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let currentVariantId = null;
  let currentProductId = null;

  async function init() {
    const pathMatch = location.pathname.match(/\/products\/([^/?#]+)/);
    if (!pathMatch) {
      renderEmpty();
      return;
    }

    const params = new URLSearchParams(location.search);
    const variantId = params.get('variant');

    if (!variantId) {
      renderEmpty();
      return;
    }

    currentVariantId = variantId;

    renderLoading();

    let variantData;
    try {
      variantData = await host.storefront('/variants/' + variantId + '.js');
    } catch (e) {
      renderEmpty();
      return;
    }

    if (!variantData || variantData.available) {
      renderEmpty();
      return;
    }

    currentProductId = String(variantData.product_id);

    const customerId = host.context.customerId;

    let alreadySubscribed = false;
    try {
      const statusResult = await host.call('/status', { variantId: currentVariantId, customerId });
      if (statusResult && statusResult.alreadySubscribed) {
        alreadySubscribed = true;
      }
    } catch (e) {
      // ignore status errors, show form anyway
    }

    if (alreadySubscribed) {
      renderMessage('info', 'You are already subscribed for this item.');
      return;
    }

    renderForm('', '');
  }

  async function handleSubscribe(customerEmail) {
    const btn = root.querySelector('.bis-btn');
    const input = root.querySelector('.bis-input');
    if (btn) btn.disabled = true;
    if (input) input.disabled = true;

    try {
      const result = await host.call('/subscribe', {
        customerEmail,
        variantId: currentVariantId,
        productId: currentProductId,
      });

      if (result && result.alreadySubscribed) {
        renderMessage('info', 'You are already subscribed for this item.');
      } else if (result && result.success) {
        renderMessage('success', "You'll be notified when this item is back in stock.");
      } else {
        renderForm(customerEmail, 'Something went wrong. Please try again.');
      }
    } catch (e) {
      renderForm(customerEmail, 'Something went wrong. Please try again.');
    }
  }

  init();
}
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  // ── Styles ──────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .bis-nav { display: flex; gap: var(--p-space-200); margin-bottom: var(--p-space-400); border-bottom: 1px solid var(--p-color-border); padding-bottom: 0; }
    .bis-nav-btn { background: none; border: none; border-bottom: 3px solid transparent; padding: var(--p-space-200) var(--p-space-400); font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text-secondary); cursor: pointer; margin-bottom: -1px; transition: color 0.15s; }
    .bis-nav-btn:hover { color: var(--p-color-text); }
    .bis-nav-btn.active { color: var(--p-color-text); border-bottom-color: #008060; font-weight: var(--p-font-weight-semibold); }
    .bis-section { display: none; } .bis-section.active { display: block; }
    .bis-filter-row { display: flex; align-items: center; gap: var(--p-space-300); margin-bottom: var(--p-space-400); flex-wrap: wrap; }
    .bis-select { border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); padding: var(--p-space-200) var(--p-space-300); font-size: var(--p-font-size-350); color: var(--p-color-text); background: var(--p-color-bg-surface); cursor: pointer; }
    .bis-top-variants { margin-top: var(--p-space-400); }
    .bis-top-variants-table { width: 100%; }
    .bis-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--p-space-400); }
    @media (max-width: 600px) { .bis-form-grid { grid-template-columns: 1fr; } }
    .bis-form-group { display: flex; flex-direction: column; gap: var(--p-space-100); }
    .bis-form-group label { font-size: var(--p-font-size-300); font-weight: var(--p-font-weight-semibold); color: var(--p-color-text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
    .bis-input { border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); padding: var(--p-space-200) var(--p-space-300); font-size: var(--p-font-size-350); color: var(--p-color-text); background: var(--p-color-bg-surface); width: 100%; box-sizing: border-box; }
    .bis-input:focus { outline: 2px solid #008060; outline-offset: 1px; border-color: #008060; }
    .bis-toggle-row { display: flex; align-items: center; gap: var(--p-space-300); padding: var(--p-space-300) 0; }
    .bis-toggle-label { font-size: var(--p-font-size-350); color: var(--p-color-text); }
    .bis-toggle-desc { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); display: block; margin-top: 2px; }
    .bis-toggle { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }
    .bis-toggle input { opacity: 0; width: 0; height: 0; }
    .bis-toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: var(--p-color-border-emphasis); border-radius: var(--p-border-radius-full); transition: 0.2s; }
    .bis-toggle-slider:before { position: absolute; content: ''; height: 16px; width: 16px; left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: 0.2s; }
    .bis-toggle input:checked + .bis-toggle-slider { background: #008060; }
    .bis-toggle input:checked + .bis-toggle-slider:before { transform: translateX(18px); }
    .bis-config-section { margin-bottom: var(--p-space-600); }
    .bis-config-section-title { font-size: var(--p-font-size-400); font-weight: var(--p-font-weight-semibold); color: var(--p-color-text); margin-bottom: var(--p-space-300); }
    .bis-actions-row { display: flex; gap: var(--p-space-200); align-items: center; margin-top: var(--p-space-400); }
    .bis-delete-btn { background: none; border: none; cursor: pointer; color: var(--p-color-text-critical); font-size: var(--p-font-size-350); padding: var(--p-space-100) var(--p-space-200); border-radius: var(--p-border-radius-100); }
    .bis-delete-btn:hover { background: var(--p-color-bg-fill-critical); }
    .bis-delete-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .bis-info-banner { background: var(--p-color-bg-fill-warning); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); padding: var(--p-space-300) var(--p-space-400); font-size: var(--p-font-size-350); color: var(--p-color-text); margin-bottom: var(--p-space-400); }
    .bis-pagination-info { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); }
    .bis-stat-icon { font-size: 1.5rem; margin-bottom: var(--p-space-100); }
    .bis-top-rank { font-weight: var(--p-font-weight-bold); color: var(--p-color-text-secondary); }
  `;
  container.appendChild(style);

  // ── Shell ────────────────────────────────────────────────────────────────
  container.innerHTML += `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Back In Stock</span>
        <button class="btn-secondary" id="bis-refresh-btn" style="margin-left:auto">↻ Refresh</button>
      </div>

      <nav class="bis-nav">
        <button class="bis-nav-btn active" data-tab="dashboard">Dashboard</button>
        <button class="bis-nav-btn" data-tab="subscribers">Subscribers</button>
        <button class="bis-nav-btn" data-tab="config">Settings</button>
      </nav>

      <!-- DASHBOARD -->
      <div class="bis-section active" id="bis-tab-dashboard">
        <div id="bis-stats-area"></div>
      </div>

      <!-- SUBSCRIBERS -->
      <div class="bis-section" id="bis-tab-subscribers">
        <div class="bis-filter-row">
          <select class="bis-select" id="bis-status-filter">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="notified">Notified</option>
          </select>
          <span class="bis-pagination-info" id="bis-pagination-info"></span>
          <div style="margin-left:auto; display:flex; gap:var(--p-space-200);">
            <button class="btn-secondary" id="bis-prev-btn" disabled>← Prev</button>
            <button class="btn-secondary" id="bis-next-btn" disabled>Next →</button>
          </div>
        </div>
        <div id="bis-subscribers-area"></div>
      </div>

      <!-- CONFIG -->
      <div class="bis-section" id="bis-tab-config">
        <div id="bis-config-area"></div>
      </div>
    </div>
  `;

  // ── State ────────────────────────────────────────────────────────────────
  let activeTab = 'dashboard';
  let subscriberPage = 1;
  const PAGE_SIZE = 50;
  let subscriberTotal = 0;
  let statusFilter = '';
  let deletingId = null;

  // ── Tab Navigation ───────────────────────────────────────────────────────
  const navBtns = container.querySelectorAll('.bis-nav-btn');
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      navBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
      container.querySelectorAll('.bis-section').forEach(s => s.classList.remove('active'));
      container.getElementById ? null : null;
      const tabEl = container.querySelector(`#bis-tab-${activeTab}`);
      if (tabEl) tabEl.classList.add('active');
      loadTab(activeTab);
    });
  });

  container.querySelector('#bis-refresh-btn').addEventListener('click', () => loadTab(activeTab));

  // ── Filter ───────────────────────────────────────────────────────────────
  container.querySelector('#bis-status-filter').addEventListener('change', (e) => {
    statusFilter = e.target.value;
    subscriberPage = 1;
    loadSubscribers();
  });

  // ── Pagination ────────────────────────────────────────────────────────────
  container.querySelector('#bis-prev-btn').addEventListener('click', () => {
    if (subscriberPage > 1) { subscriberPage--; loadSubscribers(); }
  });
  container.querySelector('#bis-next-btn').addEventListener('click', () => {
    if (subscriberPage * PAGE_SIZE < subscriberTotal) { subscriberPage++; loadSubscribers(); }
  });

  // ── Load Tab ─────────────────────────────────────────────────────────────
  function loadTab(tab) {
    if (tab === 'dashboard') loadStats();
    else if (tab === 'subscribers') loadSubscribers();
    else if (tab === 'config') loadConfig();
  }

  // ── STATS ─────────────────────────────────────────────────────────────────
  function loadStats() {
    const area = container.querySelector('#bis-stats-area');
    area.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;
    bridge.call('/stats').then(data => {
      renderStats(data);
    }).catch(err => {
      area.innerHTML = `<div class="shell-error-banner">Failed to load stats: ${escHtml(String(err?.message || err))}</div>`;
    });
  }

  function renderStats(data) {
    const area = container.querySelector('#bis-stats-area');
    const topRows = (data.topVariants || []).map((v, i) => `
      <tr>
        <td><span class="bis-top-rank">#${i+1}</span></td>
        <td>${escHtml(v.productTitle || '—')}</td>
        <td><span class="badge badge-neutral">${v.subscriberCount}</span></td>
      </tr>
    `).join('');

    area.innerHTML = `
      <div class="shell-stats-row">
        <div class="shell-stat-card">
          <div class="bis-stat-icon">📋</div>
          <div class="shell-stat-label">Total Subscriptions</div>
          <div class="shell-stat-value">${data.totalSubscriptions ?? 0}</div>
        </div>
        <div class="shell-stat-card">
          <div class="bis-stat-icon">📧</div>
          <div class="shell-stat-label">Notifications Sent</div>
          <div class="shell-stat-value">${data.totalNotificationsSent ?? 0}</div>
        </div>
        <div class="shell-stat-card">
          <div class="bis-stat-icon">⏳</div>
          <div class="shell-stat-label">Pending Notifications</div>
          <div class="shell-stat-value">${data.pendingNotifications ?? 0}</div>
        </div>
      </div>

      <div class="shell-card bis-top-variants">
        <div class="shell-section-title">Top Products by Subscribers</div>
        ${topRows.length === 0
          ? `<div class="shell-empty">No subscription data yet.</div>`
          : `<div class="shell-table-wrap">
              <table class="shell-table bis-top-variants-table">
                <thead><tr><th>#</th><th>Product</th><th>Subscribers</th></tr></thead>
                <tbody>${topRows}</tbody>
              </table>
            </div>`
        }
      </div>

      <div class="bis-info-banner">
        ℹ️ <strong>Email delivery:</strong> Notifications are sent via transactional email using a Handlebars template with product title, variant title, product URL, and featured image. Each subscription row is marked with <code>notified_at</code> after dispatch.
      </div>
    `;
  }

  // ── SUBSCRIBERS ───────────────────────────────────────────────────────────
  function loadSubscribers() {
    const area = container.querySelector('#bis-subscribers-area');
    area.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;
    updatePaginationControls(false);

    bridge.call('/subscribers', {
      page: subscriberPage,
      pageSize: PAGE_SIZE,
      statusFilter: statusFilter || undefined
    }).then(data => {
      subscriberTotal = data.total || 0;
      renderSubscribers(data.rows || []);
      updatePaginationInfo();
      updatePaginationControls(true);
    }).catch(err => {
      area.innerHTML = `<div class="shell-error-banner">Failed to load subscribers: ${escHtml(String(err?.message || err))}</div>`;
      updatePaginationControls(true);
    });
  }

  function renderSubscribers(rows) {
    const area = container.querySelector('#bis-subscribers-area');
    if (rows.length === 0) {
      area.innerHTML = `<div class="shell-empty">No subscribers found${statusFilter ? ` with status "${statusFilter}"` : ''}.</div>`;
      return;
    }

    const rowsHtml = rows.map(r => {
      const statusBadge = r.status === 'active'
        ? `<span class="badge badge-success">Active</span>`
        : r.status === 'notified'
        ? `<span class="badge badge-neutral">Notified</span>`
        : `<span class="badge badge-warning">${escHtml(r.status)}</span>`;

      const subscribedAt = r.subscribedAt ? formatDate(r.subscribedAt) : '—';
      const notifiedAt = r.notifiedAt ? formatDate(r.notifiedAt) : '—';

      return `
        <tr data-id="${escHtml(r.id)}">
          <td>${escHtml(r.customerEmail || '—')}</td>
          <td>${escHtml(r.productTitle || '—')}</td>
          <td>${escHtml(r.variantTitle || '—')}</td>
          <td>${statusBadge}</td>
          <td>${subscribedAt}</td>
          <td>${notifiedAt}</td>
          <td>
            <button class="bis-delete-btn" data-id="${escHtml(r.id)}" title="Delete subscription">🗑 Delete</button>
          </td>
        </tr>
      `;
    }).join('');

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
              <th></th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;

    area.querySelectorAll('.bis-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        showDeleteConfirm(id);
      });
    });
  }

  function updatePaginationInfo() {
    const info = container.querySelector('#bis-pagination-info');
    const start = subscriberTotal === 0 ? 0 : (subscriberPage - 1) * PAGE_SIZE + 1;
    const end = Math.min(subscriberPage * PAGE_SIZE, subscriberTotal);
    info.textContent = subscriberTotal > 0 ? `${start}–${end} of ${subscriberTotal}` : '0 results';
  }

  function updatePaginationControls(enabled) {
    const prev = container.querySelector('#bis-prev-btn');
    const next = container.querySelector('#bis-next-btn');
    prev.disabled = !enabled || subscriberPage <= 1;
    next.disabled = !enabled || subscriberPage * PAGE_SIZE >= subscriberTotal;
  }

  // ── Delete Confirm ────────────────────────────────────────────────────────
  function showDeleteConfirm(id) {
    const overlay = document.createElement('div');
    overlay.className = 'shell-confirm-overlay';
    overlay.innerHTML = `
      <div class="shell-confirm-dialog">
        <div class="shell-confirm-title">Delete Subscription</div>
        <div class="shell-confirm-body">Are you sure you want to delete this subscription? This action cannot be undone.</div>
        <div class="shell-confirm-actions">
          <button class="btn-secondary" id="bis-confirm-cancel">Cancel</button>
          <button class="btn-danger" id="bis-confirm-delete">Delete</button>
        </div>
      </div>
    `;
    container.appendChild(overlay);

    overlay.querySelector('#bis-confirm-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#bis-confirm-delete').addEventListener('click', () => {
      overlay.remove();
      doDelete(id);
    });
  }

  function doDelete(id) {
    const btn = container.querySelector(`.bis-delete-btn[data-id="${CSS.escape(id)}"]`);
    if (btn) btn.disabled = true;

    bridge.call('/subscribers/delete', { id }).then(res => {
      if (res.deleted === 1) {
        bridge.notify('Subscription deleted.', 'success');
        loadSubscribers();
      } else {
        bridge.notify('Subscription not found or already deleted.', 'error');
        if (btn) btn.disabled = false;
      }
    }).catch(err => {
      bridge.notify(`Delete failed: ${err?.message || err}`, 'error');
      if (btn) btn.disabled = false;
    });
  }

  // ── CONFIG ────────────────────────────────────────────────────────────────
  function loadConfig() {
    const area = container.querySelector('#bis-config-area');
    area.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;

    bridge.call('/config/get').then(cfg => {
      renderConfig(cfg);
    }).catch(err => {
      area.innerHTML = `<div class="shell-error-banner">Failed to load config: ${escHtml(String(err?.message || err))}</div>`;
    });
  }

  function renderConfig(cfg) {
    const area = container.querySelector('#bis-config-area');
    area.innerHTML = `
      <div class="shell-card">
        <div class="bis-config-section">
          <div class="bis-config-section-title">Email Settings</div>
          <div class="bis-form-grid">
            <div class="bis-form-group">
              <label for="bis-email-subject">Email Subject <span style="color:var(--p-color-text-critical)">*</span></label>
              <input class="bis-input" type="text" id="bis-email-subject" value="${escHtml(cfg.emailSubject || '')}" placeholder="Your item is back in stock!" />
            </div>
            <div class="bis-form-group">
              <label for="bis-email-from-name">From Name <span style="color:var(--p-color-text-critical)">*</span></label>
              <input class="bis-input" type="text" id="bis-email-from-name" value="${escHtml(cfg.emailFromName || '')}" placeholder="Store Notifications" />
            </div>
          </div>
        </div>

        <div class="bis-config-section">
          <div class="bis-config-section-title">Notification Behavior</div>

          <div class="bis-toggle-row">
            <label class="bis-toggle">
              <input type="checkbox" id="bis-notify-once" ${cfg.notifyOncePerSubscriber ? 'checked' : ''} />
              <span class="bis-toggle-slider"></span>
            </label>
            <div>
              <span class="bis-toggle-label">Notify once per subscriber</span>
              <span class="bis-toggle-desc">Send only one notification per subscriber per variant, even if restocked multiple times.</span>
            </div>
          </div>

          <div class="bis-toggle-row">
            <label class="bis-toggle">
              <input type="checkbox" id="bis-auto-resubscribe" ${cfg.autoResubscribeAfterNotification ? 'checked' : ''} />
              <span class="bis-toggle-slider"></span>
            </label>
            <div>
              <span class="bis-toggle-label">Auto-resubscribe after notification</span>
              <span class="bis-toggle-desc">Automatically re-activate the subscription after the customer is notified, so they receive future restock alerts.</span>
            </div>
          </div>
        </div>

        <div class="bis-actions-row">
          <button class="btn-primary" id="bis-save-btn">Save Settings</button>
          <span id="bis-save-status" style="font-size:var(--p-font-size-350); color:var(--p-color-text-secondary);"></span>
        </div>
      </div>
    `;

    container.querySelector('#bis-save-btn').addEventListener('click', saveConfig);
  }

  function saveConfig() {
    const subjectEl = container.querySelector('#bis-email-subject');
    const fromEl = container.querySelector('#bis-email-from-name');
    const notifyOnceEl = container.querySelector('#bis-notify-once');
    const autoResubEl = container.querySelector('#bis-auto-resubscribe');
    const saveBtn = container.querySelector('#bis-save-btn');
    const saveStatus = container.querySelector('#bis-save-status');

    const emailSubject = subjectEl.value.trim();
    const emailFromName = fromEl.value.trim();

    if (!emailSubject || !emailFromName) {
      bridge.notify('Email Subject and From Name are required.', 'error');
      if (!emailSubject) subjectEl.style.outline = '2px solid var(--p-color-text-critical)';
      if (!emailFromName) fromEl.style.outline = '2px solid var(--p-color-text-critical)';
      return;
    }

    subjectEl.style.outline = '';
    fromEl.style.outline = '';

    saveBtn.disabled = true;
    saveStatus.textContent = 'Saving…';

    bridge.call('/config/save', {
      emailSubject,
      emailFromName,
      notifyOncePerSubscriber: notifyOnceEl.checked,
      autoResubscribeAfterNotification: autoResubEl.checked
    }).then(res => {
      saveBtn.disabled = false;
      if (res.saved) {
        saveStatus.textContent = '✓ Saved';
        saveStatus.style.color = 'var(--p-color-text-success)';
        bridge.notify('Settings saved successfully.', 'success');
        setTimeout(() => { saveStatus.textContent = ''; }, 3000);
      } else {
        saveStatus.textContent = 'Save failed — check required fields.';
        saveStatus.style.color = 'var(--p-color-text-critical)';
        bridge.notify('Settings could not be saved. Check required fields.', 'error');
      }
    }).catch(err => {
      saveBtn.disabled = false;
      saveStatus.textContent = 'Error saving.';
      saveStatus.style.color = 'var(--p-color-text-critical)';
      bridge.notify(`Save error: ${err?.message || err}`, 'error');
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return iso;
    }
  }

  // ── Initial Load ──────────────────────────────────────────────────────────
  loadStats();
}
```


## Explanation

With the Back-in-Stock Notifications feature, your customers can sign up to be notified the moment a sold-out product comes back in stock. When a product is out of stock, a subscription widget automatically appears on the product page, letting shoppers enter their email and save their spot. They won't need to keep checking back manually — as soon as inventory is restocked, they'll receive a branded email with the product name, image, and a direct link to purchase.

As a merchant, you have full control through a dedicated dashboard where you can view all active subscriptions, see which products have the most interest, and adjust notification settings to fit your store's needs. You can customize how the emails look and decide when and how notifications go out. This makes it easy to turn high-demand, out-of-stock moments into sales opportunities by re-engaging shoppers right when the product is available again.

Note: To send email notifications with product images and call-to-action buttons, this feature requires an email service to be connected to your store. Email delivery is handled through your configured email integration, so please make sure that is set up before going live. Additionally, notifications are triggered based on real inventory updates in your store, so keeping your inventory accurately synced ensures customers are notified at exactly the right time.
