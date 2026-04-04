# Feature Generator — Run Result

**Date:** 2026-04-04 21:39:35  
**Status:** ✅ SUCCESS  
**Total:** 157882ms  
**Prompt:** Develop a Notify Me When Back In Stock Shopify app.

## Pipeline

| Agent       | Status | Time       |
|-------------|--------|------------|
| Product     | ✓      | 2330ms     |
| Architect   | ✓      | 23731ms    |
| CodeSpec    | ✓      | 43034ms    |
| Handler     | ✓      | 55679ms    |
| Migration   | ✓      | 55679ms    |
| Widget JS   | ✓      | 18195ms    |
| Admin UI    | ✓      | 55679ms    |
| Validation  | ✓      | 17ms       |
| Explanation | ✓      | 14873ms    |

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: ['inventory_levels/update'],
  cronSchedule: null,
  handler: async function(ctx) {
    try {
      // Helper function for sending back-in-stock emails
      async function sendBackInStockEmail({ customerEmail, productTitle, variantTitle, productHandle, featuredImageUrl, variantId }) {
        if (!customerEmail) return;
        const subject = productTitle + ' is back in stock!';
        const data = { productTitle, variantTitle, productHandle, featuredImageUrl, variantId };
        await ctx.email.send({ to: customerEmail, subject, template: 'back_in_stock', data });
        ctx.logger.info({ customerEmail, variantId }, 'back-in-stock email sent to ' + customerEmail + ' for variantId ' + variantId);
      }

      // ── Widget path ──────────────────────────────────────────────
      if (ctx.trigger === 'widget') {
        if (ctx.widgetPath === '/status') {
          const { variantId, productId, customerId } = ctx.widgetBody || {};
          if (!variantId) return { subscribed: false };
          if (!customerId) return { subscribed: false };
          const statusRows = await ctx.db`
            SELECT id FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${Number(variantId)}
              AND customer_id = ${Number(customerId)}
              AND notified_at IS NULL
            LIMIT 1
          `;
          return { subscribed: statusRows.length > 0 };
        }

        if (ctx.widgetPath === '/subscribe') {
          const { customerEmail, variantId, productId } = ctx.widgetBody || {};
          if (!customerEmail || !variantId || !productId) {
            return { success: false, alreadySubscribed: false };
          }
          // Validate email format
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(customerEmail)) {
            return { success: false, alreadySubscribed: false };
          }
          const customerId = null;
          let insertResult;
          try {
            insertResult = await ctx.db`
              INSERT INTO back_in_stock_subscriptions
                (id, tenant_id, variant_id, product_id, customer_id, customer_email, subscribed_at, notified_at)
              VALUES
                (gen_random_uuid(), ${ctx.tenantId}, ${Number(variantId)}, ${Number(productId)}, ${customerId}, ${customerEmail}, NOW(), NULL)
              ON CONFLICT ON CONSTRAINT uq_bis_tenant_variant_email DO NOTHING
              RETURNING id
            `;
          } catch (err) {
            ctx.logger.error({ err }, 'Error inserting back_in_stock_subscription');
            return { success: false, alreadySubscribed: false };
          }
          if (insertResult.length === 0) {
            return { success: true, alreadySubscribed: true };
          }
          return { success: true, alreadySubscribed: false };
        }

        return { error: 'unknown path' };
      }

      // ── Admin path ───────────────────────────────────────────────
      if (ctx.trigger === 'admin') {
        if (ctx.widgetPath === '/subscribers') {
          const rows = await ctx.db`
            SELECT
              id,
              variant_id AS "variantId",
              product_id AS "productId",
              customer_id AS "customerId",
              customer_email AS "customerEmail",
              subscribed_at AS "subscribedAt",
              notified_at AS "notifiedAt"
            FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY subscribed_at DESC
            LIMIT 100
          `;

          // Collect distinct product IDs
          const productIdSet = new Set(rows.map(r => String(r.productId)));
          const productIds = [...productIdSet];

          const productMap = {};

          if (productIds.length > 0) {
            const BATCH_SIZE = 250;
            for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
              const chunk = productIds.slice(i, i + BATCH_SIZE);
              const { products } = await ctx.shopify.get(
                `/products.json?ids=${chunk.join(',')}&fields=id,title,variants`
              );
              for (const p of (products || [])) {
                const variantMap = {};
                for (const v of (p.variants || [])) {
                  variantMap[String(v.id)] = v.title;
                }
                productMap[String(p.id)] = { productTitle: p.title, variantMap };
              }
            }
          }

          const enrichedRows = rows.map(row => ({
            id: row.id,
            variantId: row.variantId,
            productId: row.productId,
            productTitle: productMap[String(row.productId)]?.productTitle ?? '',
            variantTitle: productMap[String(row.productId)]?.variantMap[String(row.variantId)] ?? '',
            customerEmail: row.customerEmail,
            customerId: row.customerId,
            subscribedAt: row.subscribedAt,
            notifiedAt: row.notifiedAt,
          }));

          return { total: enrichedRows.length, rows: enrichedRows };
        }

        if (ctx.widgetPath === '/subscribers/delete') {
          const { id } = ctx.widgetBody || {};
          if (!id) return { deleted: false };
          const deleteResult = await ctx.db`
            DELETE FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
            RETURNING id
          `;
          if (deleteResult.length === 0) return { deleted: false };
          ctx.logger.info({ id }, 'Deleted back_in_stock_subscription');
          return { deleted: true };
        }

        return { error: 'unknown path' };
      }

      // ── Webhook path ─────────────────────────────────────────────
      if (ctx.trigger === 'webhook') {
        ctx.logger.info({ trigger: ctx.trigger, topic: ctx.topic }, 'inventory_levels/update webhook received');

        const { inventory_item_id, available } = ctx.payload;

        if (!inventory_item_id) {
          ctx.logger.warn('inventory_item_id missing from payload — skipping');
          return;
        }
        if (available === null || available === undefined) {
          ctx.logger.warn('available is null/undefined — cannot determine stock level');
          return;
        }
        if (available <= 0) {
          ctx.logger.info({ inventory_item_id, available }, 'Still out of stock — nothing to notify');
          return;
        }

        // Step 1: Resolve variant_id from inventory item
        const inventoryItemResponse = await ctx.shopify.get(`/inventory_items/${inventory_item_id}.json`);
        if (!inventoryItemResponse.inventory_item) {
          ctx.logger.warn({ inventory_item_id }, 'Inventory item not found or deleted');
          return;
        }
        const variantId = inventoryItemResponse.inventory_item.variant_id;
        if (!variantId) {
          ctx.logger.warn({ inventory_item_id }, 'Inventory item not linked to a variant');
          return;
        }

        // Step 2: Fetch variant + product details via GraphQL
        const gqlResponse = await ctx.shopify.graphql(
          `query($variantId: ID!) {
            productVariant(id: $variantId) {
              id
              legacyResourceId
              title
              inventoryQuantity
              product {
                id
                title
                handle
                featuredImage { url }
              }
            }
          }`,
          { variantId: `gid://shopify/ProductVariant/${variantId}` }
        );

        if (!gqlResponse.productVariant) {
          ctx.logger.warn({ variantId }, 'Variant not found or deleted in GraphQL');
          return;
        }
        const variantNode = gqlResponse.productVariant;
        const productNode = variantNode.product;
        if (!productNode) {
          ctx.logger.warn({ variantId }, 'Product not found for variant');
          return;
        }

        const productTitle = productNode.title;
        const productHandle = productNode.handle;
        const variantTitle = variantNode.title;
        const featuredImageUrl = productNode.featuredImage?.url ?? null;
        const numericVariantId = Number(variantId);

        // Step 3: Read pending subscribers for this variant
        const pendingRows = await ctx.db`
          SELECT id, customer_email, customer_id
          FROM back_in_stock_subscriptions
          WHERE tenant_id = ${ctx.tenantId}
            AND variant_id = ${numericVariantId}
            AND notified_at IS NULL
        `;

        if (pendingRows.length === 0) {
          ctx.logger.info({ numericVariantId }, 'No pending subscribers for this variant');
          return;
        }

        const pendingIds = pendingRows.map(r => r.id);

        // Step 4: Atomically claim all pending subscribers before notifying
        const claimed = await ctx.db`
          UPDATE back_in_stock_subscriptions
          SET notified_at = NOW()
          WHERE tenant_id = ${ctx.tenantId}
            AND variant_id = ${numericVariantId}
            AND id = ANY(${pendingIds})
            AND notified_at IS NULL
          RETURNING id, customer_email, customer_id
        `;

        if (claimed.length === 0) {
          ctx.logger.info({ numericVariantId }, 'Already claimed by concurrent webhook — skipping');
          return;
        }

        ctx.logger.info({ numericVariantId, claimedCount: claimed.length }, 'Claimed subscribers for back-in-stock notification');

        // Step 5: Send notifications for each claimed subscriber
        for (const row of claimed) {
          await sendBackInStockEmail({
            customerEmail: row.customer_email,
            productTitle,
            variantTitle,
            productHandle,
            featuredImageUrl,
            variantId: numericVariantId,
          });
        }
      }
    } catch (err) {
      ctx.logger.error({ err }, 'Unhandled error in back-in-stock handler');
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE back_in_stock_subscriptions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL,
  variant_id     BIGINT      NOT NULL,
  product_id     BIGINT      NOT NULL,
  customer_id    BIGINT,
  customer_email TEXT        NOT NULL,
  subscribed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bis_tenant_variant_email UNIQUE (tenant_id, variant_id, customer_email)
);

ALTER TABLE back_in_stock_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY back_in_stock_subscriptions_tenant_isolation ON back_in_stock_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_bis_tenant_variant_notified ON back_in_stock_subscriptions (tenant_id, variant_id, notified_at);
```

### widget.js

```javascript
export function mount(container, host) {
  const style = document.createElement('style');
  style.textContent = `
    .bis-widget {
      font-family: inherit;
      margin: 16px 0;
    }
    .bis-widget .bis-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 400px;
    }
    .bis-widget .bis-email-input {
      padding: 10px 14px;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 14px;
      width: 100%;
      box-sizing: border-box;
    }
    .bis-widget .bis-email-input:focus {
      outline: none;
      border-color: #333;
    }
    .bis-widget .bis-btn {
      padding: 10px 20px;
      background: #333;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 14px;
      cursor: pointer;
      width: 100%;
    }
    .bis-widget .bis-btn:hover {
      background: #555;
    }
    .bis-widget .bis-btn:disabled {
      background: #999;
      cursor: not-allowed;
    }
    .bis-widget .bis-message {
      padding: 10px 14px;
      border-radius: 4px;
      font-size: 14px;
    }
    .bis-widget .bis-message.success {
      background: #f0faf0;
      color: #2d6a2d;
      border: 1px solid #a3d4a3;
    }
    .bis-widget .bis-message.info {
      background: #f0f4fa;
      color: #2d4a6a;
      border: 1px solid #a3bcd4;
    }
    .bis-widget .bis-message.error {
      background: #faf0f0;
      color: #6a2d2d;
      border: 1px solid #d4a3a3;
    }
    .bis-widget .bis-label {
      font-size: 13px;
      color: #555;
      margin-bottom: 2px;
    }
    .bis-widget .bis-loading {
      font-size: 13px;
      color: #888;
    }
  `;
  container.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.className = 'bis-widget';
  container.appendChild(wrapper);

  function render(html) {
    wrapper.innerHTML = html;
  }

  function showLoading() {
    render('<span class="bis-loading">Loading...</span>');
  }

  async function init() {
    showLoading();

    const handle = location.pathname.match(/\/products\/([^/?#]+)/)?.[1];
    if (!handle) {
      render('');
      return;
    }

    const variantId = new URLSearchParams(location.search).get('variant');

    let productData;
    try {
      productData = await host.storefront('/products/' + handle + '.js');
    } catch (e) {
      render('');
      return;
    }

    const variant = productData.variants.find(v => String(v.id) === String(variantId)) ?? productData.variants[0];
    const isOutOfStock = !variant.available;
    const productId = String(productData.id);

    if (!isOutOfStock) {
      render('');
      return;
    }

    const customerId = host.context.customerId;

    let alreadySubscribed = false;
    try {
      const statusResult = await host.call('/status', {
        variantId: String(variant.id),
        productId,
        customerId
      });
      alreadySubscribed = statusResult.subscribed === true;
    } catch (e) {
      alreadySubscribed = false;
    }

    if (alreadySubscribed) {
      render('<div class="bis-message info">You are already subscribed for this product.</div>');
      return;
    }

    showNotifyForm(variant, productId);
  }

  function showNotifyForm(variant, productId) {
    render(`
      <form class="bis-form" id="bis-form">
        <div class="bis-label">Get notified when this item is back in stock</div>
        <input
          type="email"
          name="customerEmail"
          class="bis-email-input"
          placeholder="Enter your email address"
          required
          autocomplete="email"
        />
        <button type="submit" class="bis-btn" id="bis-submit-btn">Notify Me</button>
      </form>
    `);

    const form = container.querySelector('#bis-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const emailInput = form.querySelector('input[name="customerEmail"]');
      const submitBtn = container.querySelector('#bis-submit-btn');
      const customerEmail = emailInput ? emailInput.value.trim() : '';

      if (!customerEmail) {
        showFormError(variant, productId, 'Please enter a valid email address.');
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting...';
      }

      try {
        const result = await host.call('/subscribe', {
          customerEmail,
          variantId: String(variant.id),
          productId
        });

        if (result.alreadySubscribed === true) {
          render('<div class="bis-message info">You are already subscribed for this product.</div>');
        } else if (result.alreadySubscribed === false && result.success === true) {
          render('<div class="bis-message success">You\'ll be notified when this is back in stock.</div>');
        } else {
          showFormError(variant, productId, 'Something went wrong. Please try again.');
        }
      } catch (e) {
        showFormError(variant, productId, 'Something went wrong. Please try again.');
      }
    });
  }

  function showFormError(variant, productId, errorMsg) {
    showNotifyForm(variant, productId);
    const errorDiv = document.createElement('div');
    errorDiv.className = 'bis-message error';
    errorDiv.textContent = errorMsg;
    const form = container.querySelector('#bis-form');
    if (form) {
      form.insertAdjacentElement('afterend', errorDiv);
    }
  }

  init();
}
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  const styles = `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    .bis-panel {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f6f6f7;
      min-height: 100vh;
      padding: 24px;
      color: #202223;
    }

    .bis-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }

    .bis-title {
      font-size: 20px;
      font-weight: 600;
      color: #202223;
    }

    .bis-subtitle {
      font-size: 13px;
      color: #6d7175;
      margin-top: 2px;
    }

    .bis-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: background 0.15s, opacity 0.15s;
    }

    .bis-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .bis-btn-primary {
      background: #008060;
      color: #fff;
    }

    .bis-btn-primary:hover:not(:disabled) {
      background: #006e52;
    }

    .bis-btn-danger {
      background: transparent;
      color: #d72c0d;
      border: 1px solid #ffa8a8;
      padding: 5px 10px;
      font-size: 12px;
    }

    .bis-btn-danger:hover:not(:disabled) {
      background: #fff4f4;
    }

    .bis-stat-row {
      display: flex;
      gap: 16px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }

    .bis-stat-card {
      background: #fff;
      border: 1px solid #e1e3e5;
      border-radius: 8px;
      padding: 16px 24px;
      min-width: 160px;
      flex: 1;
    }

    .bis-stat-label {
      font-size: 12px;
      color: #6d7175;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 6px;
    }

    .bis-stat-value {
      font-size: 28px;
      font-weight: 700;
      color: #202223;
    }

    .bis-stat-value.notified {
      color: #008060;
    }

    .bis-stat-value.pending {
      color: #b98900;
    }

    .bis-card {
      background: #fff;
      border: 1px solid #e1e3e5;
      border-radius: 8px;
      overflow: hidden;
    }

    .bis-table-wrap {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    thead {
      background: #f6f6f7;
    }

    th {
      text-align: left;
      padding: 10px 14px;
      font-weight: 600;
      color: #6d7175;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-bottom: 1px solid #e1e3e5;
      white-space: nowrap;
    }

    td {
      padding: 11px 14px;
      border-bottom: 1px solid #f1f2f3;
      vertical-align: middle;
      color: #202223;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tr:hover td {
      background: #fafbfb;
    }

    .bis-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }

    .bis-badge-notified {
      background: #e3f1eb;
      color: #008060;
    }

    .bis-badge-pending {
      background: #fff5d6;
      color: #b98900;
    }

    .bis-empty {
      text-align: center;
      padding: 48px 24px;
      color: #6d7175;
    }

    .bis-empty-icon {
      font-size: 32px;
      margin-bottom: 12px;
    }

    .bis-empty-text {
      font-size: 15px;
      font-weight: 500;
      margin-bottom: 6px;
    }

    .bis-empty-sub {
      font-size: 13px;
    }

    .bis-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 24px;
      gap: 14px;
      color: #6d7175;
      font-size: 14px;
    }

    .bis-spinner {
      width: 28px;
      height: 28px;
      border: 3px solid #e1e3e5;
      border-top-color: #008060;
      border-radius: 50%;
      animation: bis-spin 0.7s linear infinite;
    }

    @keyframes bis-spin {
      to { transform: rotate(360deg); }
    }

    .bis-error {
      background: #fff4f4;
      border: 1px solid #ffa8a8;
      border-radius: 8px;
      padding: 16px 20px;
      color: #d72c0d;
      font-size: 13px;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 20px;
    }

    .bis-error-icon {
      font-size: 16px;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .bis-truncate {
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .bis-email {
      color: #005bd3;
      font-weight: 500;
    }

    .bis-product-title {
      font-weight: 500;
    }

    .bis-variant-title {
      font-size: 11px;
      color: #6d7175;
      margin-top: 2px;
    }

    .bis-date {
      white-space: nowrap;
      color: #6d7175;
      font-size: 12px;
    }

    .bis-pagination {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-top: 1px solid #e1e3e5;
      font-size: 13px;
      color: #6d7175;
    }

    .bis-load-more {
      display: block;
      width: 100%;
      text-align: center;
      padding: 12px;
      background: #f6f6f7;
      border: none;
      border-top: 1px solid #e1e3e5;
      cursor: pointer;
      font-size: 13px;
      color: #005bd3;
      font-weight: 500;
      transition: background 0.15s;
    }

    .bis-load-more:hover {
      background: #eff0f1;
    }

    .bis-confirm-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .bis-confirm-box {
      background: #fff;
      border-radius: 10px;
      padding: 24px;
      max-width: 380px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
    }

    .bis-confirm-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 10px;
      color: #202223;
    }

    .bis-confirm-text {
      font-size: 13px;
      color: #6d7175;
      margin-bottom: 20px;
      line-height: 1.5;
    }

    .bis-confirm-actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }

    .bis-btn-neutral {
      background: #fff;
      color: #202223;
      border: 1px solid #c9cccf;
      padding: 8px 16px;
    }

    .bis-btn-neutral:hover:not(:disabled) {
      background: #f6f6f7;
    }

    .bis-deleting-cell {
      opacity: 0.4;
      pointer-events: none;
    }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = styles;
  container.appendChild(styleEl);

  const root = document.createElement('div');
  root.className = 'bis-panel';
  container.appendChild(root);

  const PAGE_SIZE = 50;

  let allRows = [];
  let displayCount = PAGE_SIZE;
  let isLoading = false;
  let errorMsg = null;

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function render() {
    root.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'bis-header';

    const titleBlock = document.createElement('div');
    const titleEl = document.createElement('div');
    titleEl.className = 'bis-title';
    titleEl.textContent = 'Back-in-Stock Subscribers';
    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'bis-subtitle';
    subtitleEl.textContent = 'Customers subscribed to out-of-stock product notifications';
    titleBlock.appendChild(titleEl);
    titleBlock.appendChild(subtitleEl);

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'bis-btn bis-btn-primary';
    refreshBtn.disabled = isLoading;
    refreshBtn.innerHTML = isLoading
      ? '<span class="bis-spinner" style="width:14px;height:14px;border-width:2px;"></span> Loading…'
      : '↻ Refresh';
    refreshBtn.addEventListener('click', () => loadData());

    header.appendChild(titleBlock);
    header.appendChild(refreshBtn);
    root.appendChild(header);

    if (errorMsg) {
      const errDiv = document.createElement('div');
      errDiv.className = 'bis-error';
      errDiv.innerHTML = `<span class="bis-error-icon">⚠</span><div><strong>Error loading subscribers:</strong><br>${errorMsg}</div>`;
      root.appendChild(errDiv);
    }

    if (!isLoading && !errorMsg) {
      const total = allRows.length;
      const notified = allRows.filter(r => r.notifiedAt).length;
      const pending = total - notified;

      const statRow = document.createElement('div');
      statRow.className = 'bis-stat-row';

      const makeCard = (label, value, cls) => {
        const card = document.createElement('div');
        card.className = 'bis-stat-card';
        card.innerHTML = `<div class="bis-stat-label">${label}</div><div class="bis-stat-value ${cls || ''}">${value}</div>`;
        return card;
      };

      statRow.appendChild(makeCard('Total Subscribers', total, ''));
      statRow.appendChild(makeCard('Notified', notified, 'notified'));
      statRow.appendChild(makeCard('Awaiting Restock', pending, 'pending'));
      root.appendChild(statRow);
    }

    const card = document.createElement('div');
    card.className = 'bis-card';
    root.appendChild(card);

    if (isLoading) {
      const loading = document.createElement('div');
      loading.className = 'bis-loading';
      loading.innerHTML = '<div class="bis-spinner"></div><span>Loading subscribers…</span>';
      card.appendChild(loading);
      return;
    }

    if (!errorMsg && allRows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bis-empty';
      empty.innerHTML = `
        <div class="bis-empty-icon">📭</div>
        <div class="bis-empty-text">No subscribers yet</div>
        <div class="bis-empty-sub">When customers sign up for back-in-stock alerts, they'll appear here.</div>
      `;
      card.appendChild(empty);
      return;
    }

    if (errorMsg) return;

    const tableWrap = document.createElement('div');
    tableWrap.className = 'bis-table-wrap';
    card.appendChild(tableWrap);

    const table = document.createElement('table');
    tableWrap.appendChild(table);

    const thead = document.createElement('thead');
    thead.innerHTML = `
      <tr>
        <th>Customer</th>
        <th>Product</th>
        <th>Subscribed</th>
        <th>Status</th>
        <th>Notified At</th>
        <th></th>
      </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    const rowsToShow = allRows.slice(0, displayCount);

    rowsToShow.forEach(row => {
      const tr = document.createElement('tr');
      tr.dataset.id = row.id;

      const emailCell = document.createElement('td');
      emailCell.innerHTML = `<div class="bis-email bis-truncate" title="${row.customerEmail}">${row.customerEmail}</div>${row.customerId ? `<div style="font-size:11px;color:#6d7175">ID: ${row.customerId}</div>` : ''}`;

      const productCell = document.createElement('td');
      productCell.innerHTML = `<div class="bis-product-title bis-truncate" title="${row.productTitle || row.productId}">${row.productTitle || `Product #${row.productId}`}</div><div class="bis-variant-title">${row.variantTitle || `Variant #${row.variantId}`}</div>`;

      const subscribedCell = document.createElement('td');
      subscribedCell.className = 'bis-date';
      subscribedCell.textContent = formatDate(row.subscribedAt);

      const statusCell = document.createElement('td');
      if (row.notifiedAt) {
        statusCell.innerHTML = '<span class="bis-badge bis-badge-notified">✓ Notified</span>';
      } else {
        statusCell.innerHTML = '<span class="bis-badge bis-badge-pending">⏳ Pending</span>';
      }

      const notifiedCell = document.createElement('td');
      notifiedCell.className = 'bis-date';
      notifiedCell.textContent = formatDate(row.notifiedAt);

      const actionCell = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.className = 'bis-btn bis-btn-danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => confirmDelete(row));
      actionCell.appendChild(delBtn);

      tr.appendChild(emailCell);
      tr.appendChild(productCell);
      tr.appendChild(subscribedCell);
      tr.appendChild(statusCell);
      tr.appendChild(notifiedCell);
      tr.appendChild(actionCell);

      tbody.appendChild(tr);
    });

    const paginationBar = document.createElement('div');
    paginationBar.className = 'bis-pagination';
    const showing = Math.min(displayCount, allRows.length);
    paginationBar.textContent = `Showing ${showing} of ${allRows.length} subscriber${allRows.length !== 1 ? 's' : ''}`;
    card.appendChild(paginationBar);

    if (allRows.length > displayCount) {
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.className = 'bis-load-more';
      loadMoreBtn.textContent = `Load more (${allRows.length - displayCount} remaining)`;
      loadMoreBtn.addEventListener('click', () => {
        displayCount += PAGE_SIZE;
        render();
      });
      card.appendChild(loadMoreBtn);
    }
  }

  function confirmDelete(row) {
    const overlay = document.createElement('div');
    overlay.className = 'bis-confirm-overlay';

    const box = document.createElement('div');
    box.className = 'bis-confirm-box';
    box.innerHTML = `
      <div class="bis-confirm-title">Delete Subscription?</div>
      <div class="bis-confirm-text">
        Remove <strong>${row.customerEmail}</strong>'s subscription for
        <strong>${row.productTitle || 'this product'}</strong>?
        This action cannot be undone.
      </div>
    `;

    const actions = document.createElement('div');
    actions.className = 'bis-confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'bis-btn bis-btn-neutral';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'bis-btn bis-btn-danger';
    confirmBtn.style.background = '#d72c0d';
    confirmBtn.style.color = '#fff';
    confirmBtn.style.border = 'none';
    confirmBtn.style.padding = '8px 16px';
    confirmBtn.textContent = 'Delete';
    confirmBtn.addEventListener('click', () => {
      overlay.remove();
      deleteRow(row.id);
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    box.appendChild(actions);
    overlay.appendChild(box);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    container.appendChild(overlay);
  }

  async function deleteRow(id) {
    const tr = root.querySelector(`tr[data-id="${id}"]`);
    if (tr) {
      tr.querySelectorAll('td').forEach(td => td.classList.add('bis-deleting-cell'));
    }

    try {
      const result = await bridge.call('/subscribers/delete', { id });
      if (result && result.deleted) {
        allRows = allRows.filter(r => r.id !== id);
        bridge.notify('Subscription deleted', 'success');
        render();
      } else {
        bridge.notify('Could not delete subscription — it may have already been removed.', 'error');
        if (tr) {
          tr.querySelectorAll('td').forEach(td => td.classList.remove('bis-deleting-cell'));
        }
      }
    } catch (err) {
      bridge.notify('Error deleting subscription: ' + (err && err.message ? err.message : String(err)), 'error');
      if (tr) {
        tr.querySelectorAll('td').forEach(td => td.classList.remove('bis-deleting-cell'));
      }
    }
  }

  async function loadData() {
    isLoading = true;
    errorMsg = null;
    render();

    try {
      const result = await bridge.call('/subscribers');
      allRows = (result && Array.isArray(result.rows)) ? result.rows : [];
      displayCount = PAGE_SIZE;
      isLoading = false;
      render();
    } catch (err) {
      isLoading = false;
      errorMsg = err && err.message ? err.message : String(err);
      render();
    }
  }

  loadData();
}
```


## Explanation

This feature adds a "Notify Me When Available" button to any product page where an item is out of stock. When a shopper clicks the button, they enter their email address and are added to a waiting list for that specific product. Everything happens right on your storefront — no extra steps or redirects required.

When you restock a product, the feature automatically detects the inventory change and sends an email notification to everyone who signed up for that item. Each subscriber is only contacted once per restock event, so your customers won't receive repeated emails if you make small inventory adjustments afterward. The notification email includes the product name, variant details, and a link back to your store so customers can head straight to checkout.

You can manage this feature through your app dashboard, where you can view current subscriber lists and monitor notification activity. Note: to send email notifications, this feature requires an email delivery service (such as Klaviyo or SendGrid) to be connected to your store. Without one, the back-in-stock alerts will not be delivered to your customers.
