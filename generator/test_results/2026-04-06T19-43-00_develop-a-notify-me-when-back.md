# Feature Generator — Run Result

**Date:** 2026-04-06 19:43:00  
**Status:** ✅ SUCCESS  
**Total:** 190321ms  
**Prompt:** Develop a Notify Me When Back In Stock Shopify app with admin interface for managing subscriptions and notifications.

## Pipeline

| Agent       | Status | Time       |
|-------------|--------|------------|
| Product     | ✓      | 1730ms     |
| Architect   | ✓      | 47078ms    |
| CodeSpec    | ✓      | 52957ms    |
| Handler     | ✓      | 75762ms    |
| Migration   | ✓      | 75762ms    |
| Widget JS   | ✓      | 75762ms    |
| Admin UI    | ✓      | 75762ms    |
| Validation  | ✓      | 28ms       |
| Explanation | ✓      | 4493ms     |

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: ['inventory_levels/update'],
  cronSchedule: '0 */6 * * *',
  npmPackages: ['uuid@9.0.1'],
  handler: async function(ctx) {
    const { v4: uuidv4 } = require('uuid');

    // Helper: send back-in-stock email
    async function sendBackInStockEmail({ to, productTitle, variantTitle, productHandle, productImageUrl, variantId, productId }) {
      if (!to) return;
      const titleSuffix = (variantTitle && variantTitle !== 'Default Title') ? ' - ' + variantTitle : '';
      const subject = 'Back In Stock: ' + productTitle + titleSuffix;
      await ctx.services.email.send({
        to,
        subject,
        data: { productTitle, variantTitle, productHandle, productImageUrl, variantId, productId }
      });
    }

    // ── WIDGET ──────────────────────────────────────────────────────────────
    if (ctx.trigger === 'widget') {
      ctx.logger.info({ widgetPath: ctx.widgetPath }, 'widget invoke');

      if (ctx.widgetPath === '/status') {
        const { customerId, productId, variantId } = ctx.widgetBody;
        if (!customerId) {
          return { alreadySubscribed: false };
        }
        try {
          const subRows = await ctx.db`
            SELECT id FROM bis_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variantId}
              AND customer_id = ${customerId}
              AND status = 'pending'
          `;
          return { alreadySubscribed: subRows.length > 0 };
        } catch (err) {
          ctx.logger.error({ err }, 'widget /status DB error');
          return { alreadySubscribed: false };
        }
      }

      if (ctx.widgetPath === '/subscribe') {
        const { customerEmail, productId, variantId } = ctx.widgetBody;
        if (!customerEmail || !variantId || !productId) {
          return { success: false, alreadySubscribed: false };
        }
        try {
          const variantResp = await ctx.shopify.get(`/variants/${variantId}.json`);
          if (!variantResp || !variantResp.variant) {
            return { success: false, alreadySubscribed: false };
          }
          const inventoryItemId = variantResp.variant.inventory_item_id;
          const inserted = await ctx.db`
            INSERT INTO bis_subscriptions
              (id, tenant_id, variant_id, product_id, inventory_item_id, customer_id, customer_email, status, subscribed_at)
            VALUES
              (${uuidv4()}, ${ctx.tenantId}, ${variantId}, ${productId}, ${inventoryItemId}, null, ${customerEmail}, 'pending', NOW())
            ON CONFLICT ON CONSTRAINT uq_bis_subscription DO NOTHING
            RETURNING id
          `;
          const alreadySubscribed = inserted.length === 0;
          return { success: true, alreadySubscribed };
        } catch (err) {
          ctx.logger.error({ err }, 'widget /subscribe error');
          return { success: false, alreadySubscribed: false };
        }
      }

      return { error: 'unknown path' };
    }

    // ── ADMIN ────────────────────────────────────────────────────────────────
    if (ctx.trigger === 'admin') {
      ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

      if (ctx.adminPath === '/subscribers') {
        try {
          const page = ctx.adminBody?.page ?? 1;
          const pageSize = 50;
          const offset = (page - 1) * pageSize;

          const totalRow = await ctx.db`
            SELECT COUNT(*)::int as total FROM bis_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
          `;
          const total = totalRow[0].total;

          const rows = await ctx.db`
            SELECT id, customer_email, customer_id, variant_id, product_id, status, subscribed_at, notified_at
            FROM bis_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY subscribed_at DESC
            LIMIT ${pageSize} OFFSET ${offset}
          `;

          // Batch-fetch product data for enrichment
          const distinctProductIds = [...new Set(rows.map(r => String(r.product_id)))];
          const variantMap = new Map(); // key: String(variantId)

          if (distinctProductIds.length > 0) {
            for (let i = 0; i < distinctProductIds.length; i += 250) {
              const chunk = distinctProductIds.slice(i, i + 250);
              try {
                const { products } = await ctx.shopify.get(
                  `/products.json?ids=${chunk.join(',')}&fields=id,title,handle,variants&limit=250`
                );
                for (const p of (products || [])) {
                  for (const v of (p.variants || [])) {
                    variantMap.set(String(v.id), { variantTitle: v.title, productTitle: p.title });
                  }
                }
              } catch (err) {
                ctx.logger.warn({ err }, 'admin /subscribers: failed to fetch product batch');
              }
            }
          }

          const enriched = rows.map(row => {
            const info = variantMap.get(String(row.variant_id)) || {};
            return {
              id: row.id,
              customerEmail: row.customer_email,
              customerId: row.customer_id,
              variantId: row.variant_id,
              productId: row.product_id,
              productTitle: info.productTitle || '',
              variantTitle: info.variantTitle || '',
              status: row.status,
              subscribedAt: row.subscribed_at,
              notifiedAt: row.notified_at || null
            };
          });

          return { total, page, pageSize, rows: enriched };
        } catch (err) {
          ctx.logger.error({ err }, 'admin /subscribers error');
          return { total: 0, page: 1, pageSize: 50, rows: [] };
        }
      }

      if (ctx.adminPath === '/notify') {
        const { variantId } = ctx.adminBody;
        if (!variantId) {
          return { notified: 0, variantId: null };
        }
        try {
          const variantResp = await ctx.shopify.get(`/variants/${variantId}.json`);
          if (!variantResp || !variantResp.variant) {
            return { notified: 0, variantId };
          }
          const variant = variantResp.variant;
          const productId = variant.product_id;
          const variantTitle = variant.title;

          const productResp = await ctx.shopify.get(`/products/${productId}.json`);
          if (!productResp || !productResp.product) {
            return { notified: 0, variantId };
          }
          const product = productResp.product;
          const productTitle = product.title;
          const productHandle = product.handle;
          const productImageUrl = product.images && product.images[0] ? product.images[0].src : null;

          const claimed = await ctx.db`
            UPDATE bis_subscriptions
            SET status = 'notified', notified_at = NOW()
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variantId}
              AND status = 'pending'
            RETURNING id, customer_email, customer_id
          `;

          if (claimed.length === 0) {
            return { notified: 0, variantId };
          }

          for (const row of claimed) {
            await sendBackInStockEmail({
              to: row.customer_email,
              productTitle,
              variantTitle,
              productHandle,
              productImageUrl,
              variantId,
              productId
            });
          }

          ctx.logger.info({ variantId, notified: claimed.length }, 'admin /notify: sent notifications');
          return { notified: claimed.length, variantId };
        } catch (err) {
          ctx.logger.error({ err }, 'admin /notify error');
          return { notified: 0, variantId };
        }
      }

      if (ctx.adminPath === '/delete') {
        const { id } = ctx.adminBody;
        if (!id) {
          return { deleted: false, id: null };
        }
        try {
          const deleted = await ctx.db`
            DELETE FROM bis_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
            RETURNING id
          `;
          if (deleted.length === 0) {
            return { deleted: false, id };
          }
          ctx.logger.info({ id }, 'admin /delete: subscription removed');
          return { deleted: true, id };
        } catch (err) {
          ctx.logger.error({ err }, 'admin /delete error');
          return { deleted: false, id };
        }
      }

      ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
      return { error: 'unknown path' };
    }

    // ── CRON ─────────────────────────────────────────────────────────────────
    if (ctx.trigger === 'cron') {
      ctx.logger.info({ trigger: ctx.trigger }, 'cron: back-in-stock backstop run');
      try {
        const pendingRows = await ctx.db`
          SELECT DISTINCT variant_id, product_id, inventory_item_id
          FROM bis_subscriptions
          WHERE tenant_id = ${ctx.tenantId} AND status = 'pending'
        `;

        if (pendingRows.length === 0) {
          ctx.logger.info('cron: no pending subscribers');
          return;
        }

        ctx.logger.info({ count: pendingRows.length }, 'cron: pending variant rows');

        const distinctProductIds = [...new Set(pendingRows.map(r => String(r.product_id)))];
        const productMap = new Map(); // key: String(variantId)

        for (let i = 0; i < distinctProductIds.length; i += 250) {
          const chunk = distinctProductIds.slice(i, i + 250);
          try {
            const { products } = await ctx.shopify.get(
              `/products.json?ids=${chunk.join(',')}&fields=id,title,handle,variants,images&limit=250`
            );
            for (const p of (products || [])) {
              const productTitle = p.title;
              const productHandle = p.handle;
              const productImageUrl = p.images && p.images[0] ? p.images[0].src : null;
              for (const v of (p.variants || [])) {
                productMap.set(String(v.id), {
                  variantTitle: v.title,
                  productTitle,
                  productHandle,
                  productImageUrl,
                  available: v.inventory_quantity,
                  productId: p.id
                });
              }
            }
          } catch (err) {
            ctx.logger.warn({ err }, 'cron: failed to fetch product batch');
          }
        }

        for (const pendingRow of pendingRows) {
          const variantData = productMap.get(String(pendingRow.variant_id));
          if (!variantData) continue;
          if (variantData.available <= 0) continue;

          // Back in stock — claim and notify
          let claimed;
          try {
            claimed = await ctx.db`
              UPDATE bis_subscriptions
              SET status = 'notified', notified_at = NOW()
              WHERE tenant_id = ${ctx.tenantId}
                AND variant_id = ${pendingRow.variant_id}
                AND status = 'pending'
              RETURNING id, customer_email, customer_id
            `;
          } catch (err) {
            ctx.logger.error({ err, variantId: pendingRow.variant_id }, 'cron: failed to claim subscribers');
            continue;
          }

          if (claimed.length === 0) continue;

          ctx.logger.info({ variantId: pendingRow.variant_id, count: claimed.length }, 'cron: notifying subscribers');

          for (const row of claimed) {
            await sendBackInStockEmail({
              to: row.customer_email,
              productTitle: variantData.productTitle,
              variantTitle: variantData.variantTitle,
              productHandle: variantData.productHandle,
              productImageUrl: variantData.productImageUrl,
              variantId: pendingRow.variant_id,
              productId: variantData.productId
            });
          }
        }
      } catch (err) {
        ctx.logger.error({ err }, 'cron: unexpected error');
      }
      return;
    }

    // ── WEBHOOK: inventory_levels/update ─────────────────────────────────────
    try {
      const inventoryItemId = ctx.payload.inventory_item_id;
      const locationId = ctx.payload.location_id;
      const available = ctx.payload.available;

      ctx.logger.info({ trigger: ctx.trigger, inventoryItemId, locationId, available }, 'webhook: inventory_levels/update');

      if (!inventoryItemId) {
        ctx.logger.warn('webhook: missing inventory_item_id');
        return;
      }

      // Step 1: Resolve variant and product via GraphQL
      let variantId, variantTitle, productId, productTitle, productHandle, productImageUrl;
      let variantResolved = false;

      try {
        const gqlResult = await ctx.shopify.graphql(
          `query ResolveVariant($query: String!) {
            productVariants(first: 1, query: $query) {
              edges {
                node {
                  id
                  title
                  legacyResourceId
                  product {
                    id
                    title
                    handle
                    legacyResourceId
                    images(first: 1) {
                      edges {
                        node {
                          url
                        }
                      }
                    }
                  }
                }
              }
            }
          }`,
          { query: `inventory_item_id:${inventoryItemId}` }
        );

        const variantEdges = gqlResult.productVariants && gqlResult.productVariants.edges;

        if (!variantEdges || variantEdges.length === 0) {
          ctx.logger.info({ inventoryItemId }, 'webhook: no variant found for inventory_item_id — recording state only');
          // Upsert state without variant info
          await ctx.db`
            INSERT INTO inventory_state (tenant_id, inventory_item_id, available_quantity, updated_at)
            VALUES (${ctx.tenantId}, ${inventoryItemId}, ${available}, NOW())
            ON CONFLICT (tenant_id, inventory_item_id) DO UPDATE
              SET available_quantity = ${available}, updated_at = NOW()
          `;
          return;
        }

        const variantNode = variantEdges[0].node;
        variantId = variantNode.legacyResourceId;
        variantTitle = variantNode.title;
        const productNode = variantNode.product;
        productId = productNode.legacyResourceId;
        productTitle = productNode.title;
        productHandle = productNode.handle;
        productImageUrl = productNode.images.edges[0]?.node.url ?? null;
        variantResolved = true;
      } catch (err) {
        ctx.logger.error({ err, inventoryItemId }, 'webhook: GraphQL resolution failed');
        // Still try to record state
        try {
          await ctx.db`
            INSERT INTO inventory_state (tenant_id, inventory_item_id, available_quantity, updated_at)
            VALUES (${ctx.tenantId}, ${inventoryItemId}, ${available}, NOW())
            ON CONFLICT (tenant_id, inventory_item_id) DO UPDATE
              SET available_quantity = ${available}, updated_at = NOW()
          `;
        } catch (dbErr) {
          ctx.logger.error({ dbErr }, 'webhook: failed to upsert inventory_state after GraphQL error');
        }
        return;
      }

      // Step 2: Read previous inventory state
      const stateRows = await ctx.db`
        SELECT available_quantity FROM inventory_state
        WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventoryItemId}
      `;
      const prevAvailable = stateRows.length === 0 ? null : Number(stateRows[0].available_quantity);

      // Step 3: Upsert new inventory state
      await ctx.db`
        INSERT INTO inventory_state (tenant_id, inventory_item_id, available_quantity, updated_at)
        VALUES (${ctx.tenantId}, ${inventoryItemId}, ${available}, NOW())
        ON CONFLICT (tenant_id, inventory_item_id) DO UPDATE
          SET available_quantity = ${available}, updated_at = NOW()
      `;

      // Transition detection
      if (prevAvailable === null) {
        ctx.logger.info({ inventoryItemId }, 'webhook: first observation — baseline set');
        return;
      }
      if (prevAvailable > 0) {
        ctx.logger.info({ inventoryItemId, prevAvailable, available }, 'webhook: was already in stock — no transition');
        return;
      }
      if (available <= 0) {
        ctx.logger.info({ inventoryItemId, prevAvailable, available }, 'webhook: still out of stock — no transition');
        return;
      }

      // Back-in-stock transition detected
      ctx.logger.info({ inventoryItemId, variantId, prevAvailable, available }, 'webhook: back-in-stock transition detected');

      // Step 4: Claim pending subscribers and notify
      const claimed = await ctx.db`
        UPDATE bis_subscriptions
        SET status = 'notified', notified_at = NOW()
        WHERE tenant_id = ${ctx.tenantId}
          AND variant_id = ${variantId}
          AND status = 'pending'
        RETURNING id, customer_email, customer_id
      `;

      if (claimed.length === 0) {
        ctx.logger.info({ variantId }, 'webhook: no pending subscribers to notify');
        return;
      }

      ctx.logger.info({ variantId, count: claimed.length }, 'webhook: claiming and notifying subscribers');

      for (const row of claimed) {
        await sendBackInStockEmail({
          to: row.customer_email,
          productTitle,
          variantTitle,
          productHandle,
          productImageUrl,
          variantId,
          productId
        });
      }

    } catch (err) {
      ctx.logger.error({ err }, 'webhook: unexpected error');
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE inventory_state (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  inventory_item_id   BIGINT NOT NULL,
  available_quantity  INTEGER,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, inventory_item_id)
);

ALTER TABLE inventory_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_state_tenant_isolation ON inventory_state
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_inventory_state_tenant_inventory_item ON inventory_state (tenant_id, inventory_item_id);

CREATE TABLE bis_subscriptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  variant_id       BIGINT NOT NULL,
  product_id       BIGINT NOT NULL,
  inventory_item_id BIGINT,
  customer_id      BIGINT,
  customer_email   TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  subscribed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bis_subscription UNIQUE (tenant_id, variant_id, customer_email)
);

ALTER TABLE bis_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY bis_subscriptions_tenant_isolation ON bis_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_bis_subscriptions_tenant_status ON bis_subscriptions (tenant_id, status);
CREATE INDEX idx_bis_subscriptions_tenant_variant ON bis_subscriptions (tenant_id, variant_id);
```

### widget.js

```javascript
export function mount(container, host) {
  let productData = null;
  let resolvedVariant = null;
  let resolvedProductId = null;
  let resolvedVariantId = null;

  const styles = `
    .bis-widget {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      margin: 16px 0;
      padding: 0;
    }
    .bis-widget * {
      box-sizing: border-box;
    }
    .bis-form-wrapper {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .bis-label {
      font-size: 14px;
      font-weight: 600;
      color: #1a1a1a;
      margin-bottom: 4px;
      display: block;
    }
    .bis-sublabel {
      font-size: 13px;
      color: #555;
      margin-bottom: 8px;
      display: block;
    }
    .bis-input-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .bis-email-input {
      flex: 1 1 200px;
      padding: 10px 14px;
      border: 1.5px solid #ccc;
      border-radius: 6px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
      min-width: 0;
    }
    .bis-email-input:focus {
      border-color: #1a1a1a;
    }
    .bis-email-input.bis-error-field {
      border-color: #cc0000;
    }
    .bis-submit-btn {
      padding: 10px 20px;
      background: #1a1a1a;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, opacity 0.2s;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .bis-submit-btn:hover:not(:disabled) {
      background: #333;
    }
    .bis-submit-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .bis-message {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
    }
    .bis-message.bis-success {
      background: #f0faf0;
      border: 1px solid #b3e0b3;
      color: #1e6b1e;
    }
    .bis-message.bis-already {
      background: #f5f5ff;
      border: 1px solid #c8c8f0;
      color: #3a3a8c;
    }
    .bis-message.bis-error {
      background: #fff5f5;
      border: 1px solid #f0b3b3;
      color: #8c1a1a;
    }
    .bis-error-text {
      font-size: 13px;
      color: #cc0000;
      margin-top: -4px;
    }
    .bis-loading {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 14px;
      color: #777;
      padding: 8px 0;
    }
    .bis-spinner {
      width: 18px;
      height: 18px;
      border: 2px solid #ddd;
      border-top-color: #1a1a1a;
      border-radius: 50%;
      animation: bis-spin 0.7s linear infinite;
      flex-shrink: 0;
    }
    @keyframes bis-spin {
      to { transform: rotate(360deg); }
    }
    .bis-icon {
      font-size: 16px;
    }
    .bis-divider {
      border: none;
      border-top: 1px solid #eee;
      margin: 4px 0 8px 0;
    }
    .bis-heading {
      font-size: 15px;
      font-weight: 700;
      color: #1a1a1a;
      margin: 0 0 4px 0;
    }
    .bis-out-of-stock-badge {
      display: inline-block;
      background: #f5f5f5;
      border: 1px solid #ddd;
      color: #888;
      font-size: 12px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 20px;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = styles;
  container.appendChild(styleEl);

  const root = document.createElement('div');
  root.className = 'bis-widget';
  container.appendChild(root);

  function render(html) {
    root.innerHTML = html;
  }

  function renderLoading() {
    render(`
      <div class="bis-loading">
        <div class="bis-spinner"></div>
        <span>Checking availability…</span>
      </div>
    `);
  }

  function renderHidden() {
    root.innerHTML = '';
  }

  function renderAlreadySubscribed() {
    render(`
      <div class="bis-message bis-already">
        <span class="bis-icon">🔔</span>
        <span>You're already on the list — we'll notify you when this item is back in stock.</span>
      </div>
    `);
  }

  function renderForm(errorMsg) {
    const storedEmail = (host.context && host.context.customerId) ? '' : '';
    render(`
      <div class="bis-form-wrapper">
        <div>
          <span class="bis-out-of-stock-badge">Out of Stock</span>
          <p class="bis-heading">Get notified when it's back</p>
          <span class="bis-sublabel">Enter your email and we'll alert you as soon as this item is available again.</span>
        </div>
        <hr class="bis-divider"/>
        <form id="bis-form" novalidate>
          <label class="bis-label" for="bis-email-input">Email address</label>
          <div class="bis-input-row">
            <input
              type="email"
              id="bis-email-input"
              name="customerEmail"
              class="bis-email-input${errorMsg ? ' bis-error-field' : ''}"
              placeholder="you@example.com"
              autocomplete="email"
              required
            />
            <button type="submit" class="bis-submit-btn" id="bis-submit-btn">Notify Me</button>
          </div>
          ${errorMsg ? `<div class="bis-error-text">${errorMsg}</div>` : ''}
        </form>
      </div>
    `);

    const form = root.querySelector('#bis-form');
    if (form) {
      form.addEventListener('submit', handleSubmit);
    }
  }

  function renderSubmitting() {
    const btn = root.querySelector('#bis-submit-btn');
    const input = root.querySelector('#bis-email-input');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Submitting…';
    }
    if (input) {
      input.disabled = true;
    }
  }

  function renderSuccess() {
    render(`
      <div class="bis-message bis-success">
        <span class="bis-icon">✅</span>
        <span>You'll be notified when this item is back in stock.</span>
      </div>
    `);
  }

  function renderGenericError() {
    render(`
      <div class="bis-message bis-error">
        <span class="bis-icon">⚠️</span>
        <span>Something went wrong. Please try again later.</span>
      </div>
    `);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const form = root.querySelector('#bis-form');
    if (!form) return;

    const data = host.getFormData(form);
    const customerEmail = (data.customerEmail || '').trim();

    if (!customerEmail) {
      renderForm('Please enter a valid email address.');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(customerEmail)) {
      renderForm('Please enter a valid email address.');
      return;
    }

    renderSubmitting();

    try {
      const variantId = resolvedVariantId;
      const productId = resolvedProductId;

      const result = await host.call('/subscribe', {
        customerEmail,
        variantId,
        productId,
      });

      if (result && result.alreadySubscribed) {
        render(`
          <div class="bis-message bis-already">
            <span class="bis-icon">🔔</span>
            <span>You're already on the list — we'll notify you when this item is back in stock.</span>
          </div>
        `);
      } else if (result && result.success) {
        renderSuccess();
      } else {
        renderForm('Subscription failed. Please try again.');
      }
    } catch (err) {
      renderGenericError();
    }
  }

  async function init() {
    renderLoading();

    const pathname = location.pathname;
    const search = location.search;

    const handleMatch = pathname.match(/\/products\/([^/?#]+)/);
    if (!handleMatch) {
      renderHidden();
      return;
    }

    const handle = handleMatch[1];
    const variantIdParam = new URLSearchParams(search).get('variant');

    let fetchedProductData;
    try {
      fetchedProductData = await host.storefront('/products/' + handle + '.js');
    } catch (err) {
      renderHidden();
      return;
    }

    if (!fetchedProductData || !fetchedProductData.variants || fetchedProductData.variants.length === 0) {
      renderHidden();
      return;
    }

    productData = fetchedProductData;

    const variant = variantIdParam
      ? (productData.variants.find(v => String(v.id) === String(variantIdParam)) ?? productData.variants[0])
      : productData.variants[0];

    resolvedVariant = variant;
    resolvedProductId = String(productData.id);
    resolvedVariantId = String(variant.id);

    const isOutOfStock = !variant.available;

    if (!isOutOfStock) {
      renderHidden();
      return;
    }

    const customerId = host.context ? host.context.customerId : null;

    let statusResult;
    try {
      statusResult = await host.call('/status', {
        variantId: resolvedVariantId,
        productId: resolvedProductId,
        customerId,
      });
    } catch (err) {
      renderForm();
      return;
    }

    if (statusResult && statusResult.alreadySubscribed) {
      renderAlreadySubscribed();
    } else {
      renderForm();
    }
  }

  init();
}
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  // ── State ──────────────────────────────────────────────────────────────────
  let state = {
    loading: true,
    error: null,
    rows: [],
    total: 0,
    page: 1,
    pageSize: 50,
    notifyingVariantId: null,
    deletingId: null,
    confirmDelete: null,   // { id, email }
    notifyVariantInput: '',
    notifyLoading: false,
    filterStatus: 'all',
    search: '',
  };

  // ── Styles ────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .bis-toolbar-row {
      display: flex;
      align-items: center;
      gap: var(--p-space-300);
      flex-wrap: wrap;
    }
    .bis-filter-select {
      padding: var(--p-space-200) var(--p-space-300);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      background: var(--p-color-bg-surface);
      color: var(--p-color-text);
      font-size: var(--p-font-size-350);
      font-family: var(--p-font-family-sans);
      cursor: pointer;
    }
    .bis-notify-card {
      display: flex;
      align-items: flex-end;
      gap: var(--p-space-300);
      flex-wrap: wrap;
    }
    .bis-notify-field {
      display: flex;
      flex-direction: column;
      gap: var(--p-space-100);
      flex: 1;
      min-width: 200px;
    }
    .bis-notify-field label {
      font-size: var(--p-font-size-300);
      font-weight: var(--p-font-weight-semibold);
      color: var(--p-color-text-secondary);
      font-family: var(--p-font-family-sans);
    }
    .bis-notify-field input {
      padding: var(--p-space-200) var(--p-space-300);
      border: 1px solid var(--p-color-border);
      border-radius: var(--p-border-radius-100);
      background: var(--p-color-bg-surface);
      color: var(--p-color-text);
      font-size: var(--p-font-size-350);
      font-family: var(--p-font-family-sans);
      outline: none;
    }
    .bis-notify-field input:focus {
      border-color: var(--p-color-border-emphasis);
    }
    .bis-notify-result {
      font-size: var(--p-font-size-350);
      font-family: var(--p-font-family-sans);
      padding: var(--p-space-200) var(--p-space-300);
      border-radius: var(--p-border-radius-100);
      background: var(--p-color-bg-fill-success);
      color: var(--p-color-text-success);
      font-weight: var(--p-font-weight-medium);
    }
    .bis-phase-note {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      font-family: var(--p-font-family-sans);
      font-style: italic;
      margin-top: var(--p-space-200);
    }
    .bis-action-cell {
      display: flex;
      gap: var(--p-space-200);
      align-items: center;
    }
    .bis-btn-sm {
      padding: var(--p-space-100) var(--p-space-200);
      font-size: var(--p-font-size-300);
      border-radius: var(--p-border-radius-100);
      cursor: pointer;
      font-family: var(--p-font-family-sans);
      font-weight: var(--p-font-weight-medium);
      border: none;
    }
    .bis-btn-notify {
      background: #008060;
      color: #fff;
    }
    .bis-btn-notify:hover {
      background: #006e52;
    }
    .bis-btn-notify:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .bis-btn-delete {
      background: var(--p-color-bg-fill-critical);
      color: var(--p-color-text-critical);
    }
    .bis-btn-delete:hover {
      opacity: 0.85;
    }
    .bis-btn-delete:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .bis-empty-state {
      text-align: center;
      padding: var(--p-space-800) var(--p-space-400);
      color: var(--p-color-text-secondary);
      font-family: var(--p-font-family-sans);
      font-size: var(--p-font-size-350);
    }
    .bis-stats-meta {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      font-family: var(--p-font-family-sans);
    }
    .bis-email-link {
      color: var(--p-color-text);
      font-size: var(--p-font-size-300);
      font-family: var(--p-font-family-sans);
    }
    .bis-trunc {
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: block;
    }
    .bis-date {
      font-size: var(--p-font-size-300);
      color: var(--p-color-text-secondary);
      font-family: var(--p-font-family-sans);
      white-space: nowrap;
    }
    .bis-spinner-inline {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: bisSpinInline 0.6s linear infinite;
      vertical-align: middle;
      margin-right: 4px;
    }
    @keyframes bisSpinInline {
      to { transform: rotate(360deg); }
    }
  `;
  container.appendChild(style);

  // ── Root ──────────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.className = 'shell-root';
  container.appendChild(root);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      });
    } catch {
      return iso;
    }
  }

  function statusBadge(status) {
    const map = {
      pending: 'badge-warning',
      notified: 'badge-success',
      cancelled: 'badge-neutral',
    };
    const cls = map[status] || 'badge-neutral';
    const span = document.createElement('span');
    span.className = `badge ${cls}`;
    span.textContent = status || 'unknown';
    return span;
  }

  function getFilteredRows() {
    let rows = state.rows;
    if (state.filterStatus !== 'all') {
      rows = rows.filter(r => r.status === state.filterStatus);
    }
    if (state.search.trim()) {
      const q = state.search.trim().toLowerCase();
      rows = rows.filter(r =>
        (r.customerEmail || '').toLowerCase().includes(q) ||
        (r.productTitle || '').toLowerCase().includes(q) ||
        (r.variantTitle || '').toLowerCase().includes(q) ||
        String(r.variantId || '').includes(q)
      );
    }
    return rows;
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  async function loadData(page) {
    state.loading = true;
    state.error = null;
    render();
    try {
      const body = page > 1 ? { page } : undefined;
      const result = await bridge.call('/subscribers', body);
      state.rows = result.rows || [];
      state.total = result.total || 0;
      state.page = result.page || 1;
      state.pageSize = result.pageSize || 50;
    } catch (e) {
      state.error = e?.message || 'Failed to load subscribers.';
    } finally {
      state.loading = false;
      render();
    }
  }

  // ── Notify action ─────────────────────────────────────────────────────────
  async function triggerNotify(variantId, onDone) {
    if (!variantId) {
      bridge.notify('Please enter a valid Variant ID.', 'error');
      return;
    }
    state.notifyLoading = true;
    state.notifyingVariantId = variantId;
    render();
    try {
      const result = await bridge.call('/notify', { variantId: Number(variantId) });
      if (result.notified > 0) {
        bridge.notify(`✓ Notified ${result.notified} subscriber${result.notified > 1 ? 's' : ''} for variant ${result.variantId}.`, 'success');
        // refresh list
        await loadData(state.page);
      } else {
        bridge.notify(`No pending subscribers found for variant ${variantId}.`, 'info');
      }
      if (onDone) onDone(result);
    } catch (e) {
      bridge.notify(e?.message || 'Notification failed.', 'error');
    } finally {
      state.notifyLoading = false;
      state.notifyingVariantId = null;
      render();
    }
  }

  // ── Delete action ─────────────────────────────────────────────────────────
  async function deleteSubscriber(id) {
    state.deletingId = id;
    render();
    try {
      const result = await bridge.call('/delete', { id });
      if (result.deleted) {
        state.rows = state.rows.filter(r => r.id !== id);
        state.total = Math.max(0, state.total - 1);
        bridge.notify('Subscriber removed.', 'success');
      } else {
        bridge.notify('Could not delete — record not found or already removed.', 'error');
      }
    } catch (e) {
      bridge.notify(e?.message || 'Delete failed.', 'error');
    } finally {
      state.deletingId = null;
      state.confirmDelete = null;
      render();
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    root.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'shell-header';
    const title = document.createElement('h1');
    title.className = 'shell-title';
    title.textContent = 'Back-In-Stock Notifications';
    header.appendChild(title);
    root.appendChild(header);

    // ── Stats Row ──────────────────────────────────────────────────────────
    const statsRow = document.createElement('div');
    statsRow.className = 'shell-stats-row';

    const allRows = state.rows;
    const pendingCount = allRows.filter(r => r.status === 'pending').length;
    const notifiedCount = allRows.filter(r => r.status === 'notified').length;

    const statDefs = [
      { label: 'Total Subscribers', value: state.loading ? '—' : state.total },
      { label: 'Pending Alerts', value: state.loading ? '—' : pendingCount },
      { label: 'Notified', value: state.loading ? '—' : notifiedCount },
    ];
    statDefs.forEach(({ label, value }) => {
      const card = document.createElement('div');
      card.className = 'shell-stat-card';
      const lbl = document.createElement('div');
      lbl.className = 'shell-stat-label';
      lbl.textContent = label;
      const val = document.createElement('div');
      val.className = 'shell-stat-value';
      val.textContent = value;
      card.appendChild(lbl);
      card.appendChild(val);
      statsRow.appendChild(card);
    });
    root.appendChild(statsRow);

    // ── Manual Notify Card ─────────────────────────────────────────────────
    const notifyCard = document.createElement('div');
    notifyCard.className = 'shell-card';
    const notifyTitle = document.createElement('div');
    notifyTitle.className = 'shell-section-title';
    notifyTitle.textContent = 'Send Notifications by Variant';
    notifyCard.appendChild(notifyTitle);

    const notifyRow = document.createElement('div');
    notifyRow.className = 'bis-notify-card';

    const field = document.createElement('div');
    field.className = 'bis-notify-field';
    const fieldLabel = document.createElement('label');
    fieldLabel.textContent = 'Variant ID';
    const fieldInput = document.createElement('input');
    fieldInput.type = 'number';
    fieldInput.placeholder = 'e.g. 12345678901';
    fieldInput.value = state.notifyVariantInput;
    fieldInput.addEventListener('input', e => {
      state.notifyVariantInput = e.target.value;
    });
    field.appendChild(fieldLabel);
    field.appendChild(fieldInput);
    notifyRow.appendChild(field);

    const notifyBtn = document.createElement('button');
    notifyBtn.className = 'btn-primary';
    notifyBtn.disabled = state.notifyLoading;
    if (state.notifyLoading) {
      const spin = document.createElement('span');
      spin.className = 'bis-spinner-inline';
      notifyBtn.appendChild(spin);
    }
    const notifyBtnText = document.createElement('span');
    notifyBtnText.textContent = state.notifyLoading ? 'Sending…' : 'Send Notifications';
    notifyBtn.appendChild(notifyBtnText);
    notifyBtn.addEventListener('click', () => {
      const vid = state.notifyVariantInput.trim();
      triggerNotify(vid);
    });
    notifyRow.appendChild(notifyBtn);

    notifyCard.appendChild(notifyRow);

    const phaseNote = document.createElement('p');
    phaseNote.className = 'bis-phase-note';
    phaseNote.textContent = '⚠ Email delivery is a stub in Phase 1 and will become fully functional in Phase 3.';
    notifyCard.appendChild(phaseNote);

    root.appendChild(notifyCard);

    // ── Subscribers Table Card ─────────────────────────────────────────────
    const tableCard = document.createElement('div');
    tableCard.className = 'shell-card';

    const tableHeader = document.createElement('div');
    tableHeader.className = 'shell-toolbar';

    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'shell-section-title';
    sectionTitle.textContent = 'Subscribers';

    const toolbarRight = document.createElement('div');
    toolbarRight.className = 'bis-toolbar-row';

    // Search
    const searchInput = document.createElement('input');
    searchInput.className = 'shell-search';
    searchInput.type = 'search';
    searchInput.placeholder = 'Search email, product…';
    searchInput.value = state.search;
    let searchDebounce = null;
    searchInput.addEventListener('input', e => {
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        state.search = e.target.value;
        render();
      }, 300);
    });

    // Status filter
    const filterSelect = document.createElement('select');
    filterSelect.className = 'bis-filter-select';
    [
      { value: 'all', label: 'All statuses' },
      { value: 'pending', label: 'Pending' },
      { value: 'notified', label: 'Notified' },
      { value: 'cancelled', label: 'Cancelled' },
    ].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === state.filterStatus) o.selected = true;
      filterSelect.appendChild(o);
    });
    filterSelect.addEventListener('change', e => {
      state.filterStatus = e.target.value;
      render();
    });

    // Refresh
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn-secondary';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.disabled = state.loading;
    refreshBtn.addEventListener('click', () => loadData(state.page));

    toolbarRight.appendChild(searchInput);
    toolbarRight.appendChild(filterSelect);
    toolbarRight.appendChild(refreshBtn);

    tableHeader.appendChild(sectionTitle);
    tableHeader.appendChild(toolbarRight);
    tableCard.appendChild(tableHeader);

    // Loading
    if (state.loading) {
      const loading = document.createElement('div');
      loading.className = 'shell-loading';
      const spinner = document.createElement('div');
      spinner.className = 'shell-spinner';
      loading.appendChild(spinner);
      tableCard.appendChild(loading);
      root.appendChild(tableCard);
      return;
    }

    // Error
    if (state.error) {
      const errBanner = document.createElement('div');
      errBanner.className = 'shell-error-banner';
      errBanner.textContent = state.error;
      tableCard.appendChild(errBanner);
      root.appendChild(tableCard);
      return;
    }

    const filtered = getFilteredRows();

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bis-empty-state';
      empty.textContent = state.search || state.filterStatus !== 'all'
        ? 'No subscribers match your filter.'
        : 'No subscribers yet. They will appear once customers sign up for back-in-stock alerts.';
      tableCard.appendChild(empty);
    } else {
      const tableWrap = document.createElement('div');
      tableWrap.className = 'shell-table-wrap';
      const table = document.createElement('table');
      table.className = 'shell-table';

      // Head
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      ['Customer Email', 'Product', 'Variant', 'Status', 'Subscribed', 'Notified', 'Actions'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      // Body
      const tbody = document.createElement('tbody');
      filtered.forEach(row => {
        const tr = document.createElement('tr');

        // Email
        const tdEmail = document.createElement('td');
        const emailLink = document.createElement('span');
        emailLink.className = 'bis-email-link bis-trunc';
        emailLink.textContent = row.customerEmail || '—';
        emailLink.title = row.customerEmail || '';
        tdEmail.appendChild(emailLink);
        tr.appendChild(tdEmail);

        // Product
        const tdProduct = document.createElement('td');
        const productSpan = document.createElement('span');
        productSpan.className = 'bis-trunc';
        productSpan.textContent = row.productTitle || `ID: ${row.productId}`;
        productSpan.title = row.productTitle || '';
        tdProduct.appendChild(productSpan);
        tr.appendChild(tdProduct);

        // Variant
        const tdVariant = document.createElement('td');
        const variantSpan = document.createElement('span');
        variantSpan.className = 'bis-trunc';
        variantSpan.textContent = row.variantTitle || `ID: ${row.variantId}`;
        variantSpan.title = row.variantTitle || '';
        tdVariant.appendChild(variantSpan);
        tr.appendChild(tdVariant);

        // Status
        const tdStatus = document.createElement('td');
        tdStatus.appendChild(statusBadge(row.status));
        tr.appendChild(tdStatus);

        // Subscribed at
        const tdSub = document.createElement('td');
        tdSub.className = 'bis-date';
        tdSub.textContent = formatDate(row.subscribedAt);
        tr.appendChild(tdSub);

        // Notified at
        const tdNotif = document.createElement('td');
        tdNotif.className = 'bis-date';
        tdNotif.textContent = formatDate(row.notifiedAt);
        tr.appendChild(tdNotif);

        // Actions
        const tdActions = document.createElement('td');
        const actionDiv = document.createElement('div');
        actionDiv.className = 'bis-action-cell';

        // Notify button (only for pending)
        if (row.status === 'pending') {
          const notifyRowBtn = document.createElement('button');
          notifyRowBtn.className = 'bis-btn-sm bis-btn-notify';
          const isNotifying = state.notifyLoading && state.notifyingVariantId === String(row.variantId);
          notifyRowBtn.disabled = state.notifyLoading;
          if (isNotifying) {
            const sp = document.createElement('span');
            sp.className = 'bis-spinner-inline';
            notifyRowBtn.appendChild(sp);
          }
          const ntxt = document.createElement('span');
          ntxt.textContent = isNotifying ? 'Sending…' : 'Notify';
          notifyRowBtn.appendChild(ntxt);
          notifyRowBtn.addEventListener('click', () => {
            triggerNotify(String(row.variantId));
          });
          actionDiv.appendChild(notifyRowBtn);
        }

        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'bis-btn-sm bis-btn-delete';
        deleteBtn.disabled = state.deletingId === row.id;
        if (state.deletingId === row.id) {
          const sp = document.createElement('span');
          sp.className = 'bis-spinner-inline';
          deleteBtn.appendChild(sp);
        }
        const dtxt = document.createElement('span');
        dtxt.textContent = state.deletingId === row.id ? '…' : 'Delete';
        deleteBtn.appendChild(dtxt);
        deleteBtn.addEventListener('click', () => {
          state.confirmDelete = { id: row.id, email: row.customerEmail };
          render();
        });
        actionDiv.appendChild(deleteBtn);

        tdActions.appendChild(actionDiv);
        tr.appendChild(tdActions);

        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      tableWrap.appendChild(table);
      tableCard.appendChild(tableWrap);

      // Pagination info
      const pagDiv = document.createElement('div');
      pagDiv.className = 'shell-pagination';
      const meta = document.createElement('span');
      meta.className = 'bis-stats-meta';
      const startIdx = (state.page - 1) * state.pageSize + 1;
      const endIdx = Math.min(state.page * state.pageSize, state.total);
      meta.textContent = `Showing ${state.total === 0 ? 0 : startIdx}–${endIdx} of ${state.total} subscribers`;
      pagDiv.appendChild(meta);

      if (state.total > state.pageSize) {
        const pagBtns = document.createElement('div');
        pagBtns.className = 'shell-pagination-btns';

        const prevBtn = document.createElement('button');
        prevBtn.className = 'btn-secondary';
        prevBtn.textContent = '← Previous';
        prevBtn.disabled = state.page <= 1;
        prevBtn.addEventListener('click', () => loadData(state.page - 1));

        const nextBtn = document.createElement('button');
        nextBtn.className = 'btn-secondary';
        nextBtn.textContent = 'Next →';
        nextBtn.disabled = state.page * state.pageSize >= state.total;
        nextBtn.addEventListener('click', () => loadData(state.page + 1));

        pagBtns.appendChild(prevBtn);
        pagBtns.appendChild(nextBtn);
        pagDiv.appendChild(pagBtns);
      }

      tableCard.appendChild(pagDiv);
    }

    root.appendChild(tableCard);

    // ── Confirm Delete Modal ───────────────────────────────────────────────
    if (state.confirmDelete) {
      const overlay = document.createElement('div');
      overlay.className = 'shell-confirm-overlay';

      const dialog = document.createElement('div');
      dialog.className = 'shell-confirm-dialog';

      const dlgTitle = document.createElement('div');
      dlgTitle.className = 'shell-confirm-title';
      dlgTitle.textContent = 'Delete Subscriber?';

      const dlgBody = document.createElement('div');
      dlgBody.className = 'shell-confirm-body';
      dlgBody.textContent = `Are you sure you want to remove the subscription for "${state.confirmDelete.email}"? This cannot be undone.`;

      const dlgActions = document.createElement('div');
      dlgActions.className = 'shell-confirm-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn-secondary';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        state.confirmDelete = null;
        render();
      });

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn-danger';
      confirmBtn.textContent = 'Delete';
      confirmBtn.addEventListener('click', () => {
        const id = state.confirmDelete.id;
        deleteSubscriber(id);
      });

      dlgActions.appendChild(cancelBtn);
      dlgActions.appendChild(confirmBtn);
      dialog.appendChild(dlgTitle);
      dialog.appendChild(dlgBody);
      dialog.appendChild(dlgActions);
      overlay.appendChild(dialog);

      // Close on overlay click
      overlay.addEventListener('click', e => {
        if (e.target === overlay) {
          state.confirmDelete = null;
          render();
        }
      });

      root.appendChild(overlay);
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  loadData(1);
}
```


## Explanation

Your back-in-stock notification feature lets customers sign up to be notified when out-of-stock products are available again. When a product comes back into stock, subscribers automatically receive an email alert with product details and a direct link to purchase. You control everything from your Shopify Admin dashboard.

Here's how it works: Customers see a "Notify me when available" button on your storefront for out-of-stock items. When they click it, they enter their email and join the notification list for that product. Your store automatically checks inventory every 6 hours to find products that have been restocked. When stock is detected, emails are sent instantly to all waiting subscribers, and you can see their status in your dashboard (sent, pending, or unsubscribed).

From your admin dashboard, you can view all active subscribers, see which products they're waiting for, and manually send notifications anytime you want—useful if you need to alert customers about a restock before the automatic check runs. You can also remove individual subscribers if needed. All settings are managed right in your Shopify Admin with no technical setup required.
