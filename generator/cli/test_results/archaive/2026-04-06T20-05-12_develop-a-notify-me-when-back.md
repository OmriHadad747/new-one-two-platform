# Feature Generator — Run Result

**Date:** 2026-04-06 20:05:12  
**Status:** ✅ SUCCESS  
**Total:** 313417ms  
**Prompt:** Develop a Notify Me When Back In Stock Shopify app with admin interface for managing subscriptions and notifications.

## Pipeline

| Agent       | Status | Time       |
|-------------|--------|------------|
| Product     | ✓      | 1280ms     |
| Architect   | ✓      | 36780ms    |
| CodeSpec    | ✓      | 52055ms    |
| Handler     | ✓      | 91113ms    |
| Migration   | ✓      | 91113ms    |
| Widget JS   | ✓      | 91113ms    |
| Admin UI    | ✓      | 91113ms    |
| Validation  | ✓      | 13ms       |
| Explanation | ✓      | 5116ms     |

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: ['inventory_levels/update'],
  cronSchedule: '0 */6 * * *',
  npmPackages: [],
  handler: async function(ctx) {
    // Helper: send notification email
    async function sendNotificationEmail({ to, productTitle, variantTitle, productHandle, featuredImageUrl, variantId }) {
      const subject = `${productTitle} - ${variantTitle} is back in stock!`;
      const productUrl = '/products/' + productHandle + '?variant=' + variantId;
      const imgTag = featuredImageUrl
        ? `<img src="${featuredImageUrl}" alt="${productTitle}" style="max-width:400px;width:100%;" /><br/>`
        : '';
      const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          ${imgTag}
          <h2>${productTitle}</h2>
          <p><strong>${variantTitle}</strong> is back in stock!</p>
          <a href="${productUrl}" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;text-decoration:none;border-radius:4px;">Shop Now</a>
        </div>
      `;
      ctx.logger.info({ to, productTitle, variantTitle, productHandle, variantId }, 'BIS notification intent');
      await ctx.services.email.send({ to, subject, html });
    }

    try {
      // ── WIDGET ───────────────────────────────────────────────────────────────
      if (ctx.trigger === 'widget') {
        if (ctx.widgetPath === '/subscribe') {
          const { customerEmail, customerId, productId, variantId } = ctx.widgetBody;
          if (!customerEmail || !variantId || !productId) {
            return { success: false, alreadySubscribed: false };
          }
          const insertResult = await ctx.db`
            INSERT INTO bis_subscriptions (id, tenant_id, variant_id, product_id, customer_id, customer_email, status, created_at)
            VALUES (gen_random_uuid(), ${ctx.tenantId}, ${variantId}, ${productId}, ${customerId}, ${customerEmail}, 'pending', NOW())
            ON CONFLICT ON CONSTRAINT uq_bis_sub DO NOTHING
            RETURNING id
          `;
          const alreadySubscribed = insertResult.length === 0;
          return { success: true, alreadySubscribed };
        }

        if (ctx.widgetPath === '/status') {
          const { customerId, variantId } = ctx.widgetBody;
          if (!customerId) {
            return { subscribed: false };
          }
          const rows = await ctx.db`
            SELECT id FROM bis_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variantId}
              AND customer_id = ${customerId}
              AND status = 'pending'
          `;
          return { subscribed: rows.length > 0 };
        }

        if (ctx.widgetPath === '/unsubscribe') {
          const { customerEmail, variantId } = ctx.widgetBody;
          if (!variantId || !customerEmail) {
            return { success: false };
          }
          await ctx.db`
            UPDATE bis_subscriptions
            SET status = 'unsubscribed'
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variantId}
              AND customer_email = ${customerEmail}
              AND status = 'pending'
          `;
          return { success: true };
        }

        return { error: 'unknown path' };
      }

      // ── ADMIN ────────────────────────────────────────────────────────────────
      if (ctx.trigger === 'admin') {
        ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

        if (ctx.adminPath === '/subscribers') {
          const rows = await ctx.db`
            SELECT id, variant_id, product_id, customer_id, customer_email, status, created_at, notified_at
            FROM bis_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY created_at DESC
            LIMIT 500
          `;
          if (rows.length === 0) {
            return { total: 0, pending: 0, notified: 0, rows: [] };
          }
          const productIdSet = [...new Set(rows.map(r => String(r.product_id)))];
          const variantMetaMap = new Map();
          const BATCH = 250;
          for (let i = 0; i < productIdSet.length; i += BATCH) {
            const chunk = productIdSet.slice(i, i + BATCH);
            const { products } = await ctx.shopify.get(
              `/products.json?ids=${chunk.join(',')}&fields=id,title,variants&limit=250`
            );
            for (const p of (products || [])) {
              for (const v of (p.variants || [])) {
                variantMetaMap.set(String(v.id), { productTitle: p.title, variantTitle: v.title });
              }
            }
          }
          const total = rows.length;
          const pending = rows.filter(r => r.status === 'pending').length;
          const notified = rows.filter(r => r.status === 'notified').length;
          const enriched = rows.map(r => {
            const meta = variantMetaMap.get(String(r.variant_id)) || {};
            return {
              id: r.id,
              variantId: Number(r.variant_id),
              productId: Number(r.product_id),
              productTitle: meta.productTitle || '',
              variantTitle: meta.variantTitle || '',
              customerEmail: r.customer_email,
              customerId: r.customer_id ? Number(r.customer_id) : null,
              status: r.status,
              createdAt: r.created_at,
              notifiedAt: r.notified_at || null
            };
          });
          return { total, pending, notified, rows: enriched };
        }

        if (ctx.adminPath === '/notify-manual') {
          const { variantId } = ctx.adminBody;
          if (!variantId) {
            return { notified: 0, variantId: 0 };
          }
          const variantData = await ctx.shopify.graphql(
            `query GetVariant($id: ID!) {
              productVariant(id: $id) {
                id
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
            { id: `gid://shopify/ProductVariant/${variantId}` }
          );
          if (!variantData.productVariant) {
            return { notified: 0, variantId };
          }
          const productTitle = variantData.productVariant.product.title;
          const variantTitle = variantData.productVariant.title;
          const productHandle = variantData.productVariant.product.handle;
          const featuredImageUrl = variantData.productVariant.product.featuredImage?.url ?? null;

          const claimed = await ctx.db`
            UPDATE bis_subscriptions
            SET status = 'notified', notified_at = NOW()
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variantId}
              AND status = 'pending'
            RETURNING id, customer_email
          `;
          if (claimed.length === 0) {
            return { notified: 0, variantId };
          }
          for (const row of claimed) {
            await sendNotificationEmail({ to: row.customer_email, productTitle, variantTitle, productHandle, featuredImageUrl, variantId });
          }
          ctx.logger.info({ variantId, notified: claimed.length }, 'manual notify complete');
          return { notified: claimed.length, variantId };
        }

        if (ctx.adminPath === '/delete-subscription') {
          const { subscriptionId } = ctx.adminBody;
          if (!subscriptionId) {
            return { success: false };
          }
          const deleted = await ctx.db`
            DELETE FROM bis_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND id = ${subscriptionId}
            RETURNING id
          `;
          if (deleted.length === 0) {
            return { success: false };
          }
          return { success: true };
        }

        if (ctx.adminPath === '/stats') {
          const [totalRow] = await ctx.db`
            SELECT COUNT(*) AS total FROM bis_subscriptions WHERE tenant_id = ${ctx.tenantId}
          `;
          const [pendingRow] = await ctx.db`
            SELECT COUNT(*) AS pending FROM bis_subscriptions WHERE tenant_id = ${ctx.tenantId} AND status = 'pending'
          `;
          const [last30Row] = await ctx.db`
            SELECT COUNT(*) AS last30 FROM bis_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND status = 'notified' AND notified_at >= NOW() - INTERVAL '30 days'
          `;
          const topRows = await ctx.db`
            SELECT variant_id, product_id, COUNT(*) AS pending_count
            FROM bis_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND status = 'pending'
            GROUP BY variant_id, product_id
            ORDER BY pending_count DESC
            LIMIT 10
          `;
          const variantMetaMap = new Map();
          if (topRows.length > 0) {
            const productIds = [...new Set(topRows.map(r => String(r.product_id)))];
            const { products } = await ctx.shopify.get(
              `/products.json?ids=${productIds.join(',')}&fields=id,title,variants&limit=250`
            );
            for (const p of (products || [])) {
              for (const v of (p.variants || [])) {
                variantMetaMap.set(String(v.id), { productTitle: p.title, variantTitle: v.title });
              }
            }
          }
          const topVariants = topRows.map(r => ({
            variantId: Number(r.variant_id),
            productTitle: variantMetaMap.get(String(r.variant_id))?.productTitle ?? '',
            variantTitle: variantMetaMap.get(String(r.variant_id))?.variantTitle ?? '',
            pendingCount: Number(r.pending_count)
          }));
          return {
            totalSubscriptions: Number(totalRow.total),
            pendingSubscriptions: Number(pendingRow.pending),
            notificationsSentLast30Days: Number(last30Row.last30),
            topVariants
          };
        }

        ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
        return { error: 'unknown path' };
      }

      // ── CRON ─────────────────────────────────────────────────────────────────
      if (ctx.trigger === 'cron') {
        ctx.logger.info({ trigger: ctx.trigger }, 'cron: back-in-stock check');
        const pendingRows = await ctx.db`
          SELECT DISTINCT variant_id, product_id
          FROM bis_subscriptions
          WHERE tenant_id = ${ctx.tenantId} AND status = 'pending'
        `;
        if (pendingRows.length === 0) {
          ctx.logger.info('cron: no pending subscriptions');
          return;
        }
        const productIds = [...new Set(pendingRows.map(r => String(r.product_id)))];
        const variantInventoryMap = new Map();
        const variantMetaMap = new Map();
        const BATCH = 250;
        for (let i = 0; i < productIds.length; i += BATCH) {
          const chunk = productIds.slice(i, i + BATCH);
          const { products } = await ctx.shopify.get(
            `/products.json?ids=${chunk.join(',')}&fields=id,title,handle,images,variants&limit=250`
          );
          for (const p of (products || [])) {
            for (const v of (p.variants || [])) {
              variantInventoryMap.set(String(v.id), v.inventory_quantity);
              variantMetaMap.set(String(v.id), {
                variantTitle: v.title,
                productTitle: p.title,
                productHandle: p.handle,
                featuredImageUrl: p.images?.[0]?.src ?? null
              });
            }
          }
        }
        const inStockVariantIds = pendingRows
          .filter(r => {
            const qty = variantInventoryMap.get(String(r.variant_id));
            return qty !== undefined && qty > 0;
          })
          .map(r => r.variant_id);

        ctx.logger.info({ inStockCount: inStockVariantIds.length }, 'cron: in-stock variants with pending subscribers');

        for (const inStockVariantId of inStockVariantIds) {
          const claimed = await ctx.db`
            UPDATE bis_subscriptions
            SET status = 'notified', notified_at = NOW()
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${inStockVariantId}
              AND status = 'pending'
            RETURNING id, customer_email
          `;
          if (claimed.length === 0) {
            ctx.logger.info({ variantId: inStockVariantId }, 'cron: already processed by webhook — skip');
            continue;
          }
          const meta = variantMetaMap.get(String(inStockVariantId)) || {};
          for (const row of claimed) {
            await sendNotificationEmail({
              to: row.customer_email,
              productTitle: meta.productTitle || '',
              variantTitle: meta.variantTitle || '',
              productHandle: meta.productHandle || '',
              featuredImageUrl: meta.featuredImageUrl || null,
              variantId: inStockVariantId
            });
          }
          ctx.logger.info({ variantId: inStockVariantId, notified: claimed.length }, 'cron: notified subscribers');
          await new Promise(r => setTimeout(r, 200));
        }
        return;
      }

      // ── WEBHOOK (inventory_levels/update) ─────────────────────────────────────
      ctx.logger.info({ trigger: ctx.trigger, inventory_item_id: ctx.payload.inventory_item_id }, 'webhook: inventory_levels/update');
      const { inventory_item_id, available } = ctx.payload;
      if (!inventory_item_id) {
        ctx.logger.warn('webhook: missing inventory_item_id');
        return;
      }

      const variantsResp = await ctx.shopify.get(
        `/variants.json?inventory_item_ids=${inventory_item_id}&fields=id,product_id,title,inventory_item_id`
      );
      const variants = variantsResp.variants || [];
      if (variants.length === 0) {
        ctx.logger.info({ inventory_item_id }, 'webhook: no variant found for inventory_item_id');
        return;
      }
      const variantId = variants[0].id;
      const productId = variants[0].product_id;
      const variantTitle = variants[0].title;

      const stateRows = await ctx.db`
        SELECT available_quantity FROM inventory_states
        WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variantId}
      `;
      const prevQuantity = stateRows.length === 0 ? null : Number(stateRows[0].available_quantity);

      await ctx.db`
        INSERT INTO inventory_states (tenant_id, variant_id, available_quantity, updated_at)
        VALUES (${ctx.tenantId}, ${variantId}, ${available}, NOW())
        ON CONFLICT (tenant_id, variant_id) DO UPDATE SET available_quantity = EXCLUDED.available_quantity, updated_at = NOW()
      `;

      if (stateRows.length === 0) {
        ctx.logger.info({ variantId }, 'webhook: first observation — baseline established');
        return;
      }
      if (prevQuantity === null) {
        ctx.logger.info({ variantId }, 'webhook: prevQuantity null — cannot confirm transition');
        return;
      }
      if (prevQuantity > 0) {
        ctx.logger.info({ variantId, prevQuantity }, 'webhook: was already in stock — no transition');
        return;
      }
      if (available <= 0) {
        ctx.logger.info({ variantId, available }, 'webhook: still out of stock — no transition');
        return;
      }

      ctx.logger.info({ variantId, prevQuantity, available }, 'webhook: out-of-stock → in-stock transition detected');

      const variantData = await ctx.shopify.graphql(
        `query GetVariant($id: ID!) {
          productVariant(id: $id) {
            id
            title
            product {
              id
              title
              handle
              featuredImage { url }
            }
            inventoryQuantity
          }
        }`,
        { id: `gid://shopify/ProductVariant/${variantId}` }
      );

      if (!variantData.productVariant) {
        ctx.logger.warn({ variantId }, 'webhook: variant not found in GraphQL — skipping');
        return;
      }
      const productTitle = variantData.productVariant.product.title;
      const productHandle = variantData.productVariant.product.handle;
      const featuredImageUrl = variantData.productVariant.product.featuredImage?.url ?? null;

      const claimed = await ctx.db`
        UPDATE bis_subscriptions
        SET status = 'notified', notified_at = NOW()
        WHERE tenant_id = ${ctx.tenantId}
          AND variant_id = ${variantId}
          AND status = 'pending'
        RETURNING id, customer_email
      `;
      if (claimed.length === 0) {
        ctx.logger.info({ variantId }, 'webhook: no pending subscribers or already processed');
        return;
      }
      ctx.logger.info({ variantId, count: claimed.length }, 'webhook: claimed subscribers for notification');
      for (const row of claimed) {
        await sendNotificationEmail({ to: row.customer_email, productTitle, variantTitle, productHandle, featuredImageUrl, variantId });
      }
    } catch (err) {
      ctx.logger.error({ err: err.message, stack: err.stack }, 'handler error');
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE inventory_states (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL,
  variant_id         BIGINT      NOT NULL,
  available_quantity INTEGER,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_inventory_states UNIQUE (tenant_id, variant_id)
);

ALTER TABLE inventory_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_states_tenant_isolation ON inventory_states
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE TABLE bis_subscriptions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL,
  variant_id     BIGINT      NOT NULL,
  product_id     BIGINT      NOT NULL,
  customer_id    BIGINT,
  customer_email TEXT        NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'pending',
  notified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bis_sub UNIQUE (tenant_id, variant_id, customer_email)
);

ALTER TABLE bis_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY bis_subscriptions_tenant_isolation ON bis_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE UNIQUE INDEX uq_bis_sub_customer
  ON bis_subscriptions (tenant_id, variant_id, customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX idx_bis_subscriptions_tenant_status
  ON bis_subscriptions (tenant_id, status);

CREATE INDEX idx_bis_subscriptions_tenant_variant_status
  ON bis_subscriptions (tenant_id, variant_id, status);
```

### widget.js

```javascript
export function mount(container, host) {
  let productData = null;
  let variant = null;
  let variantId = null;
  let productId = null;
  let isOutOfStock = false;
  let subscribedEmail = null;

  const productHandle = location.pathname.match(/\/products\/([^/?#]+)/)?.[1];

  if (!productHandle) {
    container.innerHTML = '';
    return;
  }

  function getVariantId(pd) {
    const fromUrl = new URLSearchParams(location.search).get('variant');
    return fromUrl ?? (pd ? String(pd.variants[0].id) : null);
  }

  function render(state, message) {
    container.innerHTML = '';

    if (state === 'loading') {
      const el = document.createElement('div');
      el.style.cssText = 'font-family:sans-serif;padding:12px;color:#555;font-size:14px;';
      el.textContent = 'Checking availability…';
      container.appendChild(el);
      return;
    }

    if (state === 'in-stock') {
      return;
    }

    if (state === 'already-subscribed') {
      const el = document.createElement('div');
      el.style.cssText = getBoxStyle();
      el.innerHTML = `
        <p style="margin:0 0 6px;font-size:14px;color:#333;font-weight:600;">Already subscribed</p>
        <p style="margin:0 0 12px;font-size:13px;color:#555;">You're on the list — we'll notify you when this item is back in stock.</p>
        ${renderUnsubscribeButton()}
      `;
      container.appendChild(el);
      attachUnsubscribeListener(el);
      return;
    }

    if (state === 'subscribed') {
      const el = document.createElement('div');
      el.style.cssText = getBoxStyle();
      el.innerHTML = `
        <p style="margin:0 0 6px;font-size:14px;color:#2a7a2a;font-weight:600;">✓ You're on the list!</p>
        <p style="margin:0 0 12px;font-size:13px;color:#555;">You'll be notified when this item is back in stock. (Notification delivery may take a short time.)</p>
        ${renderUnsubscribeButton()}
      `;
      container.appendChild(el);
      attachUnsubscribeListener(el);
      return;
    }

    if (state === 'unsubscribed') {
      const el = document.createElement('div');
      el.style.cssText = getBoxStyle();
      el.innerHTML = `<p style="margin:0;font-size:14px;color:#555;">You've been removed from the notification list.</p>`;
      container.appendChild(el);
      return;
    }

    if (state === 'error') {
      const el = document.createElement('div');
      el.style.cssText = getBoxStyle() + 'border-color:#f5c6cb;background:#fff8f8;';
      el.innerHTML = `<p style="margin:0;font-size:14px;color:#c0392b;">${message || 'Something went wrong. Please try again.'}</p>`;
      container.appendChild(el);
      return;
    }

    if (state === 'form') {
      const el = document.createElement('div');
      el.style.cssText = getBoxStyle();
      el.innerHTML = `
        <p style="margin:0 0 6px;font-size:14px;color:#333;font-weight:600;">Out of stock</p>
        <p style="margin:0 0 12px;font-size:13px;color:#555;">Enter your email to be notified when this item becomes available again.</p>
        <form id="bis-form" novalidate style="display:flex;flex-direction:column;gap:8px;">
          <input
            id="bis-email"
            type="email"
            name="email"
            placeholder="your@email.com"
            required
            style="padding:9px 12px;border:1px solid #ccc;border-radius:4px;font-size:14px;width:100%;box-sizing:border-box;"
          />
          <div id="bis-field-error" style="display:none;color:#c0392b;font-size:12px;"></div>
          <button
            type="submit"
            id="bis-submit"
            style="padding:10px 16px;background:#222;color:#fff;border:none;border-radius:4px;font-size:14px;cursor:pointer;font-weight:600;"
          >Notify Me</button>
        </form>
      `;
      container.appendChild(el);

      const form = el.querySelector('#bis-form');
      const emailInput = el.querySelector('#bis-email');
      const fieldError = el.querySelector('#bis-field-error');
      const submitBtn = el.querySelector('#bis-submit');

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = host.getFormData(form);
        const customerEmail = (formData.email || '').trim();

        fieldError.style.display = 'none';
        fieldError.textContent = '';

        if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
          fieldError.textContent = 'Please enter a valid email address.';
          fieldError.style.display = 'block';
          return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';

        try {
          const customerId = host.context.customerId;
          const result = await host.call('/subscribe', {
            customerEmail,
            customerId,
            productId,
            variantId,
          });

          subscribedEmail = customerEmail;

          if (result.alreadySubscribed) {
            render('already-subscribed');
          } else if (result.success) {
            render('subscribed');
          } else {
            render('error', 'Could not subscribe. Please try again.');
          }
        } catch (err) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Notify Me';
          render('error', 'Could not subscribe. Please try again.');
        }
      });
    }
  }

  function renderUnsubscribeButton() {
    return `<button id="bis-unsub-btn" style="background:none;border:none;padding:0;font-size:12px;color:#888;cursor:pointer;text-decoration:underline;">Remove me from this list</button>`;
  }

  function attachUnsubscribeListener(el) {
    const btn = el.querySelector('#bis-unsub-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const emailToUse = subscribedEmail;
      if (!emailToUse) {
        render('error', 'Unable to unsubscribe — email not found.');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Removing…';
      try {
        const result = await host.call('/unsubscribe', {
          variantId,
          customerEmail: emailToUse,
        });
        if (result.success) {
          render('unsubscribed');
        } else {
          render('error', 'Could not unsubscribe. Please try again.');
        }
      } catch (err) {
        render('error', 'Could not unsubscribe. Please try again.');
      }
    });
  }

  function getBoxStyle() {
    return 'font-family:sans-serif;padding:16px;border:1px solid #ddd;border-radius:6px;background:#fafafa;margin:12px 0;max-width:420px;box-sizing:border-box;';
  }

  async function init() {
    render('loading');

    try {
      productData = await host.storefront('/products/' + productHandle + '.js');
    } catch (err) {
      container.innerHTML = '';
      return;
    }

    const rawVariantId = new URLSearchParams(location.search).get('variant');
    variant = rawVariantId
      ? (productData.variants.find(v => String(v.id) === String(rawVariantId)) ?? productData.variants[0])
      : productData.variants[0];

    variantId = String(variant.id);
    productId = String(productData.id);
    isOutOfStock = !variant.available;

    if (!isOutOfStock) {
      render('in-stock');
      return;
    }

    const customerId = host.context.customerId;
    if (customerId) {
      try {
        const statusResult = await host.call('/status', { variantId, customerId });
        if (statusResult.subscribed) {
          render('already-subscribed');
          return;
        }
      } catch (err) {
        // If status check fails, fall through to show the form
      }
    }

    render('form');
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
    .bis-tabs { display: flex; gap: var(--p-space-200); border-bottom: 1px solid var(--p-color-border); margin-bottom: var(--p-space-400); padding-bottom: 0; }
    .bis-tab { background: none; border: none; border-bottom: 2px solid transparent; padding: var(--p-space-200) var(--p-space-400); font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text-secondary); cursor: pointer; margin-bottom: -1px; }
    .bis-tab.active { color: var(--p-color-text); border-bottom-color: #008060; }
    .bis-tab:hover:not(.active) { color: var(--p-color-text); }
    .bis-tab-panel { display: none; }
    .bis-tab-panel.active { display: block; }
    .top-variants-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--p-space-300); margin-top: var(--p-space-300); }
    .top-variant-card { background: var(--p-color-bg-surface-secondary); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-200); padding: var(--p-space-300) var(--p-space-400); display: flex; align-items: center; justify-content: space-between; gap: var(--p-space-200); }
    .top-variant-info { flex: 1; min-width: 0; }
    .top-variant-product { font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-semibold); color: var(--p-color-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .top-variant-title { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .top-variant-count { font-size: var(--p-font-size-500); font-weight: var(--p-font-weight-bold); color: #008060; flex-shrink: 0; }
    .bis-filter-row { display: flex; gap: var(--p-space-200); align-items: center; margin-bottom: var(--p-space-300); flex-wrap: wrap; }
    .bis-select { border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); padding: var(--p-space-200) var(--p-space-300); font-size: var(--p-font-size-350); background: var(--p-color-bg-surface); color: var(--p-color-text); cursor: pointer; }
    .bis-actions-cell { display: flex; gap: var(--p-space-100); }
    .btn-xs { padding: 2px var(--p-space-200); font-size: var(--p-font-size-300); border-radius: var(--p-border-radius-100); cursor: pointer; font-weight: var(--p-font-weight-medium); border: 1px solid transparent; white-space: nowrap; }
    .btn-xs-primary { background: #008060; color: #fff; border-color: #008060; }
    .btn-xs-primary:hover { background: #006e52; }
    .btn-xs-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-xs-danger { background: var(--p-color-bg-surface); color: var(--p-color-text-critical); border-color: var(--p-color-text-critical); }
    .btn-xs-danger:hover { background: var(--p-color-bg-fill-critical); }
    .btn-xs-danger:disabled { opacity: 0.5; cursor: not-allowed; }
    .bis-empty-cell { text-align: center; color: var(--p-color-text-secondary); padding: var(--p-space-800); font-size: var(--p-font-size-350); }
    .bis-truncate { max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: inline-block; vertical-align: middle; }
    .bis-notify-row { background: var(--p-color-bg-surface); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-200); padding: var(--p-space-400); margin-bottom: var(--p-space-400); }
    .bis-notify-row label { font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); display: block; margin-bottom: var(--p-space-200); }
    .bis-notify-input-row { display: flex; gap: var(--p-space-200); align-items: center; }
    .bis-input { border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); padding: var(--p-space-200) var(--p-space-300); font-size: var(--p-font-size-350); color: var(--p-color-text); background: var(--p-color-bg-surface); width: 260px; }
    .bis-input:focus { outline: 2px solid #008060; outline-offset: 1px; }
    .bis-phase-notice { background: var(--p-color-bg-fill-warning); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-200); padding: var(--p-space-300) var(--p-space-400); font-size: var(--p-font-size-300); color: var(--p-color-text); margin-bottom: var(--p-space-400); }
    .bis-result-banner { border-radius: var(--p-border-radius-200); padding: var(--p-space-300) var(--p-space-400); font-size: var(--p-font-size-350); margin-top: var(--p-space-300); }
    .bis-result-success { background: var(--p-color-bg-fill-success); color: var(--p-color-text-success); }
    .bis-result-error { background: var(--p-color-bg-fill-critical); color: var(--p-color-text-critical); }
    .shell-stat-value { color: var(--p-color-text); }
  `;
  container.appendChild(style);

  // ── Root ────────────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.className = 'shell-root';
  root.innerHTML = `
    <div class="shell-header">
      <span class="shell-title">Back-in-Stock Notifications</span>
      <button class="btn-secondary" id="bis-refresh-btn">↻ Refresh</button>
    </div>
    <div class="bis-phase-notice">
      ⚠️ <strong>Phase notice:</strong> Email delivery is currently in stub mode. Notification intents are logged for external integration. Full email delivery activates in Phase 3.
    </div>
    <div class="bis-tabs">
      <button class="bis-tab active" data-tab="overview">Overview</button>
      <button class="bis-tab" data-tab="subscribers">Subscribers</button>
      <button class="bis-tab" data-tab="notify">Manual Notify</button>
    </div>

    <!-- Overview Tab -->
    <div class="bis-tab-panel active" id="tab-overview">
      <div id="overview-loading" class="shell-loading"><div class="shell-spinner"></div> Loading stats…</div>
      <div id="overview-error" class="shell-error-banner" style="display:none;"></div>
      <div id="overview-content" style="display:none;">
        <div class="shell-stats-row" id="stats-row"></div>
        <div class="shell-card" style="margin-top: var(--p-space-400);">
          <div class="shell-section-title">Top Variants Awaiting Restock</div>
          <div id="top-variants-container"></div>
        </div>
      </div>
    </div>

    <!-- Subscribers Tab -->
    <div class="bis-tab-panel" id="tab-subscribers">
      <div class="bis-filter-row">
        <input class="shell-search" id="bis-search" type="text" placeholder="Search email or product…" style="flex:1; min-width: 200px;" />
        <select class="bis-select" id="bis-status-filter">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="notified">Notified</option>
        </select>
      </div>
      <div id="subs-loading" class="shell-loading"><div class="shell-spinner"></div> Loading subscribers…</div>
      <div id="subs-error" class="shell-error-banner" style="display:none;"></div>
      <div id="subs-content" style="display:none;">
        <div class="shell-section-title" id="subs-count-label" style="margin-bottom: var(--p-space-200);"></div>
        <div class="shell-table-wrap">
          <table class="shell-table" id="subs-table">
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
            <tbody id="subs-tbody"></tbody>
          </table>
        </div>
        <div class="shell-pagination">
          <span id="subs-page-info" style="font-size: var(--p-font-size-300); color: var(--p-color-text-secondary);"></span>
          <div class="shell-pagination-btns">
            <button class="btn-secondary" id="subs-prev-btn">← Prev</button>
            <button class="btn-secondary" id="subs-next-btn">Next →</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Manual Notify Tab -->
    <div class="bis-tab-panel" id="tab-notify">
      <div class="shell-card bis-notify-row">
        <div class="shell-section-title" style="margin-bottom: var(--p-space-200);">Trigger Notifications for a Variant</div>
        <p style="font-size: var(--p-font-size-350); color: var(--p-color-text-secondary); margin: 0 0 var(--p-space-300);">
          Enter a Shopify Variant ID to immediately notify all pending subscribers for that variant. This marks them as notified and sends emails.
        </p>
        <label for="manual-variant-input" style="font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); display:block; margin-bottom: var(--p-space-200);">Variant ID</label>
        <div class="bis-notify-input-row">
          <input class="bis-input" id="manual-variant-input" type="text" placeholder="e.g. 12345678901" />
          <button class="btn-primary" id="manual-notify-btn">Send Notifications</button>
        </div>
        <div id="manual-result" style="display:none;"></div>
      </div>
      <div class="shell-card" style="margin-top: var(--p-space-400);">
        <div class="shell-section-title" style="margin-bottom: var(--p-space-200);">Notify by Variant from Subscriber List</div>
        <p style="font-size: var(--p-font-size-350); color: var(--p-color-text-secondary); margin: 0 0 var(--p-space-300);">
          You can also trigger notifications directly from the Subscribers tab using the "Notify All" button next to each variant group.
        </p>
        <div id="pending-variants-loading" class="shell-loading" style="display:none;"><div class="shell-spinner"></div></div>
        <div id="pending-variants-list"></div>
      </div>
    </div>
  `;
  container.appendChild(root);

  // ── State ────────────────────────────────────────────────────────────────────
  let allSubscribers = [];
  let filteredSubscribers = [];
  let currentPage = 1;
  const PAGE_SIZE = 50;
  let loadingRows = new Set(); // row ids currently being acted on

  // ── Tab switching ─────────────────────────────────────────────────────────
  const tabs = container.querySelectorAll('.bis-tab');
  const tabPanels = container.querySelectorAll('.bis-tab-panel');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panelId = 'tab-' + tab.dataset.tab;
      const panel = container.querySelector('#' + panelId);
      if (panel) panel.classList.add('active');
    });
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function formatDate(str) {
    if (!str) return '—';
    try {
      return new Date(str).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return str; }
  }

  function statusBadge(status) {
    if (status === 'pending') return '<span class="badge badge-warning">Pending</span>';
    if (status === 'notified') return '<span class="badge badge-success">Notified</span>';
    return `<span class="badge badge-neutral">${status}</span>`;
  }

  function showEl(el) { el.style.display = ''; }
  function hideEl(el) { el.style.display = 'none'; }

  // ── Load Stats (Overview) ─────────────────────────────────────────────────
  async function loadStats() {
    const loadingEl = container.querySelector('#overview-loading');
    const errorEl = container.querySelector('#overview-error');
    const contentEl = container.querySelector('#overview-content');
    showEl(loadingEl);
    hideEl(errorEl);
    hideEl(contentEl);

    try {
      const data = await bridge.call('/stats');
      hideEl(loadingEl);

      const statsRow = container.querySelector('#stats-row');
      statsRow.innerHTML = `
        <div class="shell-stat-card">
          <div class="shell-stat-label">Total Subscriptions</div>
          <div class="shell-stat-value">${data.totalSubscriptions ?? 0}</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Pending</div>
          <div class="shell-stat-value">${data.pendingSubscriptions ?? 0}</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Notified (Last 30 Days)</div>
          <div class="shell-stat-value">${data.notificationsSentLast30Days ?? 0}</div>
        </div>
      `;

      const topContainer = container.querySelector('#top-variants-container');
      const topVariants = data.topVariants || [];
      if (topVariants.length === 0) {
        topContainer.innerHTML = '<div class="shell-empty" style="padding: var(--p-space-400);">No pending variants.</div>';
      } else {
        const grid = document.createElement('div');
        grid.className = 'top-variants-grid';
        topVariants.forEach(v => {
          const card = document.createElement('div');
          card.className = 'top-variant-card';
          card.innerHTML = `
            <div class="top-variant-info">
              <div class="top-variant-product" title="${v.productTitle || '—'}">${v.productTitle || '—'}</div>
              <div class="top-variant-title" title="${v.variantTitle || '—'}">${v.variantTitle || 'Default'}</div>
              <div style="margin-top: var(--p-space-100);">
                <button class="btn-xs btn-xs-primary notify-top-btn" data-variant-id="${v.variantId}">Notify All</button>
              </div>
            </div>
            <div class="top-variant-count">${v.pendingCount}</div>
          `;
          grid.appendChild(card);
        });
        topContainer.innerHTML = '';
        topContainer.appendChild(grid);

        grid.querySelectorAll('.notify-top-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const variantId = parseInt(btn.dataset.variantId, 10);
            btn.disabled = true;
            btn.textContent = 'Sending…';
            try {
              const result = await bridge.call('/notify-manual', { variantId });
              bridge.notify(`Sent ${result.notified} notification(s) for variant ${variantId}`, 'success');
              btn.textContent = `✓ Sent ${result.notified}`;
              await loadStats();
            } catch (err) {
              bridge.notify('Failed to send notifications: ' + (err.message || err), 'error');
              btn.disabled = false;
              btn.textContent = 'Notify All';
            }
          });
        });
      }

      showEl(contentEl);
    } catch (err) {
      hideEl(loadingEl);
      errorEl.textContent = 'Failed to load stats: ' + (err.message || String(err));
      showEl(errorEl);
    }
  }

  // ── Load Subscribers ──────────────────────────────────────────────────────
  async function loadSubscribers() {
    const loadingEl = container.querySelector('#subs-loading');
    const errorEl = container.querySelector('#subs-error');
    const contentEl = container.querySelector('#subs-content');
    showEl(loadingEl);
    hideEl(errorEl);
    hideEl(contentEl);

    try {
      const data = await bridge.call('/subscribers');
      allSubscribers = data.rows || [];
      applyFilters();
      hideEl(loadingEl);
      showEl(contentEl);
      renderPendingVariantsList();
    } catch (err) {
      hideEl(loadingEl);
      errorEl.textContent = 'Failed to load subscribers: ' + (err.message || String(err));
      showEl(errorEl);
    }
  }

  function applyFilters() {
    const search = (container.querySelector('#bis-search').value || '').toLowerCase().trim();
    const statusFilter = container.querySelector('#bis-status-filter').value;

    filteredSubscribers = allSubscribers.filter(row => {
      const matchStatus = !statusFilter || row.status === statusFilter;
      const matchSearch = !search || (
        (row.customerEmail || '').toLowerCase().includes(search) ||
        (row.productTitle || '').toLowerCase().includes(search) ||
        (row.variantTitle || '').toLowerCase().includes(search)
      );
      return matchStatus && matchSearch;
    });

    currentPage = 1;
    renderTable();
  }

  function renderTable() {
    const tbody = container.querySelector('#subs-tbody');
    const countLabel = container.querySelector('#subs-count-label');
    const pageInfo = container.querySelector('#subs-page-info');
    const prevBtn = container.querySelector('#subs-prev-btn');
    const nextBtn = container.querySelector('#subs-next-btn');

    const total = filteredSubscribers.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageRows = filteredSubscribers.slice(start, start + PAGE_SIZE);

    countLabel.textContent = `Showing ${total} subscriber${total !== 1 ? 's' : ''}`;
    pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;

    tbody.innerHTML = '';

    if (pageRows.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="7" class="bis-empty-cell">No subscribers found.</td>`;
      tbody.appendChild(tr);
      return;
    }

    pageRows.forEach(row => {
      const tr = document.createElement('tr');
      tr.dataset.id = row.id;

      const notifyDisabled = row.status !== 'pending' || loadingRows.has(row.id) ? 'disabled' : '';
      const deleteDisabled = loadingRows.has(row.id) ? 'disabled' : '';

      tr.innerHTML = `
        <td><span class="bis-truncate" title="${row.customerEmail || ''}">${row.customerEmail || '—'}</span></td>
        <td><span class="bis-truncate" title="${row.productTitle || ''}">${row.productTitle || '—'}</span></td>
        <td><span class="bis-truncate" title="${row.variantTitle || ''}">${row.variantTitle || 'Default'}</span></td>
        <td>${statusBadge(row.status)}</td>
        <td style="white-space:nowrap; font-size: var(--p-font-size-300);">${formatDate(row.createdAt)}</td>
        <td style="white-space:nowrap; font-size: var(--p-font-size-300);">${formatDate(row.notifiedAt)}</td>
        <td>
          <div class="bis-actions-cell">
            <button class="btn-xs btn-xs-primary row-notify-btn" data-id="${row.id}" data-variant-id="${row.variantId}" ${notifyDisabled} title="Notify all pending subscribers for this variant">Notify All</button>
            <button class="btn-xs btn-xs-danger row-delete-btn" data-id="${row.id}" ${deleteDisabled} title="Delete this subscription">Delete</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.row-notify-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const variantId = parseInt(btn.dataset.variantId, 10);
        const id = btn.dataset.id;
        loadingRows.add(id);
        renderTable();
        try {
          const result = await bridge.call('/notify-manual', { variantId });
          bridge.notify(`Sent ${result.notified} notification(s) for variant ${variantId}`, 'success');
          await loadSubscribers();
        } catch (err) {
          bridge.notify('Failed to send notifications: ' + (err.message || err), 'error');
          loadingRows.delete(id);
          renderTable();
        }
      });
    });

    tbody.querySelectorAll('.row-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const subscriptionId = btn.dataset.id;
        loadingRows.add(subscriptionId);
        renderTable();
        try {
          const result = await bridge.call('/delete-subscription', { subscriptionId });
          if (result.success) {
            allSubscribers = allSubscribers.filter(r => r.id !== subscriptionId);
            bridge.notify('Subscription deleted.', 'success');
            applyFilters();
          } else {
            bridge.notify('Could not delete subscription (not found or unauthorized).', 'error');
            loadingRows.delete(subscriptionId);
            renderTable();
          }
        } catch (err) {
          bridge.notify('Error deleting subscription: ' + (err.message || err), 'error');
          loadingRows.delete(subscriptionId);
          renderTable();
        }
      });
    });
  }

  container.querySelector('#subs-prev-btn').addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; renderTable(); }
  });
  container.querySelector('#subs-next-btn').addEventListener('click', () => {
    const totalPages = Math.ceil(filteredSubscribers.length / PAGE_SIZE);
    if (currentPage < totalPages) { currentPage++; renderTable(); }
  });

  // Debounced search
  let searchTimer = null;
  container.querySelector('#bis-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applyFilters(), 300);
  });
  container.querySelector('#bis-status-filter').addEventListener('change', () => applyFilters());

  // ── Pending Variants List (Notify Tab) ────────────────────────────────────
  function renderPendingVariantsList() {
    const listEl = container.querySelector('#pending-variants-list');
    // Group pending by variantId
    const pendingMap = new Map();
    allSubscribers.filter(r => r.status === 'pending').forEach(r => {
      if (!pendingMap.has(r.variantId)) {
        pendingMap.set(r.variantId, { variantId: r.variantId, productTitle: r.productTitle, variantTitle: r.variantTitle, count: 0 });
      }
      pendingMap.get(r.variantId).count++;
    });

    const variants = Array.from(pendingMap.values()).sort((a, b) => b.count - a.count);

    if (variants.length === 0) {
      listEl.innerHTML = '<div class="shell-empty" style="padding: var(--p-space-400);">No pending variants found.</div>';
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'shell-table-wrap';
    const table = document.createElement('table');
    table.className = 'shell-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Product</th>
          <th>Variant</th>
          <th>Pending Count</th>
          <th>Action</th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement('tbody');
    variants.forEach(v => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${v.productTitle || '—'}</td>
        <td>${v.variantTitle || 'Default'}</td>
        <td><strong>${v.count}</strong></td>
        <td><button class="btn-xs btn-xs-primary pv-notify-btn" data-variant-id="${v.variantId}">Notify All (${v.count})</button></td>
      `;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    listEl.innerHTML = '';
    listEl.appendChild(wrap);

    tbody.querySelectorAll('.pv-notify-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const variantId = parseInt(btn.dataset.variantId, 10);
        btn.disabled = true;
        btn.textContent = 'Sending…';
        try {
          const result = await bridge.call('/notify-manual', { variantId });
          bridge.notify(`Sent ${result.notified} notification(s).`, 'success');
          btn.textContent = `✓ Sent ${result.notified}`;
          await loadSubscribers();
        } catch (err) {
          bridge.notify('Failed to send notifications: ' + (err.message || err), 'error');
          btn.disabled = false;
          btn.textContent = `Notify All`;
        }
      });
    });
  }

  // ── Manual Notify Form ────────────────────────────────────────────────────
  const manualBtn = container.querySelector('#manual-notify-btn');
  const manualInput = container.querySelector('#manual-variant-input');
  const manualResult = container.querySelector('#manual-result');

  manualBtn.addEventListener('click', async () => {
    const raw = (manualInput.value || '').trim();
    if (!raw) {
      bridge.notify('Please enter a Variant ID.', 'error');
      return;
    }
    const variantId = parseInt(raw, 10);
    if (isNaN(variantId) || variantId <= 0) {
      bridge.notify('Please enter a valid numeric Variant ID.', 'error');
      return;
    }

    manualBtn.disabled = true;
    manualBtn.textContent = 'Sending…';
    hideEl(manualResult);

    try {
      const result = await bridge.call('/notify-manual', { variantId });
      manualResult.className = 'bis-result-banner bis-result-success';
      manualResult.textContent = result.notified > 0
        ? `✓ Successfully sent ${result.notified} notification(s) for variant ${variantId}.`
        : `No pending subscribers found for variant ${variantId}. Nothing was sent.`;
      showEl(manualResult);
      bridge.notify(result.notified > 0 ? `Sent ${result.notified} notification(s).` : 'No pending subscribers.', result.notified > 0 ? 'success' : 'info');
      if (result.notified > 0) {
        await loadSubscribers();
      }
    } catch (err) {
      manualResult.className = 'bis-result-banner bis-result-error';
      manualResult.textContent = 'Error: ' + (err.message || String(err));
      showEl(manualResult);
      bridge.notify('Failed to send notifications.', 'error');
    } finally {
      manualBtn.disabled = false;
      manualBtn.textContent = 'Send Notifications';
    }
  });

  // ── Refresh Button ────────────────────────────────────────────────────────
  container.querySelector('#bis-refresh-btn').addEventListener('click', () => {
    loadStats();
    loadSubscribers();
  });

  // ── Initial Load ──────────────────────────────────────────────────────────
  loadStats();
  loadSubscribers();
}
```


## Explanation

Your back-in-stock notification app lets customers sign up to be notified whenever an out-of-stock product comes back into inventory. When a product restocks, your app automatically detects the change and sends notification emails to all waiting customers with product details and a direct link. The app checks for newly stocked items every 6 hours automatically, so notifications go out promptly without any work from you. You can also manually send notifications anytime from your Shopify admin dashboard — just find the product, click "Notify subscribers," and the emails go out immediately. From your admin dashboard, you'll see a list of all products with pending subscribers, how many customers are waiting, and the ability to resend notifications or clear subscriptions. If you have an email service connected to your store (like SendGrid or similar), the app will use that to deliver emails; otherwise, notifications are logged and ready to send once you set up your preferred email provider.
