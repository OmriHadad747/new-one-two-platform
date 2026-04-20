# Chat Local — Codegen Output

**Date:** 2026-04-09 17:16:29  
**Prompt:** Customers receive email notifications when subscribed products return to stock, and admins can manage subscriptions and manually trigger alerts.

## Artifacts

### handler.js

```javascript
module.exports = {
  webhookTopics: ['inventory_levels/update'],
  cronSchedule: null,
  npmPackages: ['uuid@9.0.1'],
  handler: async function(ctx) {
    const { v4: uuidv4 } = require('uuid');

    try {
      // ── WIDGET ──────────────────────────────────────────────────────────────
      if (ctx.trigger === 'widget') {
        if (ctx.widgetPath === '/subscriptions/create') {
          const { email, product_id, variant_id, product_title, variant_title, image_url } = ctx.widgetBody;
          if (!email || !variant_id) {
            return { success: false, subscription_id: '', message: 'email and variant_id are required' };
          }
          const id = uuidv4();
          const result = await ctx.db`
            INSERT INTO back_in_stock_subscriptions
              (id, tenant_id, customer_id, email, product_id, variant_id, product_title, variant_title, image_url, status, created_at)
            VALUES
              (${id}, ${ctx.tenantId}, NULL, ${email}, ${product_id}, ${variant_id}, ${product_title}, ${variant_title}, ${image_url}, 'pending', NOW())
            ON CONFLICT (tenant_id, email, variant_id) DO NOTHING
            RETURNING id
          `;
          if (result.length === 0) {
            // Already exists — fetch existing
            const existing = await ctx.db`
              SELECT id FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND email = ${email} AND variant_id = ${variant_id}
              LIMIT 1
            `;
            const existingId = existing.length > 0 ? String(existing[0].id) : id;
            return { success: true, subscription_id: existingId, message: 'Already subscribed' };
          }
          return { success: true, subscription_id: String(result[0].id), message: 'Subscribed successfully' };
        }

        if (ctx.widgetPath === '/subscriptions/check') {
          const { email, variant_id } = ctx.widgetBody;
          if (!email || !variant_id) {
            return { subscribed: false, status: 'not_found' };
          }
          const rows = await ctx.db`
            SELECT status FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND email = ${email} AND variant_id = ${variant_id}
            LIMIT 1
          `;
          if (rows.length === 0) {
            return { subscribed: false, status: 'not_found' };
          }
          return { subscribed: true, status: rows[0].status };
        }

        return { error: 'unknown path' };
      }

      // ── ADMIN ──────────────────────────────────────────────────────────────
      if (ctx.trigger === 'admin') {
        ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

        if (ctx.adminPath === '/admin/subscriptions/list') {
          const { page = 1, page_size = 20, status, variant_id } = ctx.adminBody || {};
          const offset = (page - 1) * page_size;

          let rows;
          let countRows;

          if (status && variant_id) {
            rows = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title, status, notified_at, created_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status} AND variant_id = ${variant_id}
              ORDER BY created_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status} AND variant_id = ${variant_id}
            `;
          } else if (status) {
            rows = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title, status, notified_at, created_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status}
              ORDER BY created_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status}
            `;
          } else if (variant_id) {
            rows = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title, status, notified_at, created_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variant_id}
              ORDER BY created_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variant_id}
            `;
          } else {
            rows = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title, status, notified_at, created_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
              ORDER BY created_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
            `;
          }

          const total = parseInt(countRows[0].total, 10);
          const items = rows.map(r => ({
            id: String(r.id),
            email: r.email,
            customer_id: r.customer_id ? Number(r.customer_id) : null,
            product_id: Number(r.product_id),
            variant_id: Number(r.variant_id),
            product_title: r.product_title,
            variant_title: r.variant_title,
            status: r.status,
            notified_at: r.notified_at ? r.notified_at.toISOString() : null,
            created_at: r.created_at ? r.created_at.toISOString() : null,
          }));

          return { items, total, page: Number(page), page_size: Number(page_size) };
        }

        if (ctx.adminPath === '/admin/subscriptions/delete') {
          const { subscription_id } = ctx.adminBody || {};
          if (!subscription_id) {
            return { success: false };
          }
          ctx.logger.info({ subscription_id }, 'admin: delete subscription');
          await ctx.db`
            DELETE FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND id = ${subscription_id}
          `;
          return { success: true };
        }

        if (ctx.adminPath === '/admin/subscriptions/notify') {
          const { subscription_id } = ctx.adminBody || {};
          if (!subscription_id) {
            return { success: false, message: 'subscription_id is required' };
          }

          const rows = await ctx.db`
            SELECT id, email, product_id, variant_id, product_title, variant_title, image_url, status
            FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND id = ${subscription_id}
            LIMIT 1
          `;
          if (rows.length === 0) {
            return { success: false, message: 'Subscription not found' };
          }

          const sub = rows[0];
          ctx.logger.info({ subscription_id, email: sub.email }, 'admin: manual notify subscription');

          // Send email
          await ctx.services.email.send({
            to: sub.email,
            subject: `${sub.product_title} is back in stock!`,
            data: {
              product_title: sub.product_title,
              variant_title: sub.variant_title,
              image_url: sub.image_url,
            },
          });

          // Update subscription status
          await ctx.db`
            UPDATE back_in_stock_subscriptions
            SET status = 'notified', notified_at = NOW()
            WHERE tenant_id = ${ctx.tenantId} AND id = ${subscription_id}
          `;

          // Insert notification log
          const logId = uuidv4();
          await ctx.db`
            INSERT INTO notification_log (id, tenant_id, subscription_id, email, variant_id, trigger_type, sent_at)
            VALUES (${logId}, ${ctx.tenantId}, ${subscription_id}, ${sub.email}, ${sub.variant_id}, 'manual', NOW())
          `;

          return { success: true, message: 'Notification sent' };
        }

        if (ctx.adminPath === '/admin/subscriptions/notify-variant') {
          const { variant_id } = ctx.adminBody || {};
          if (!variant_id) {
            return { success: false, notified_count: 0, message: 'variant_id is required' };
          }

          ctx.logger.info({ variant_id }, 'admin: notify-variant');

          // Atomically claim pending subscriptions
          const claimed = await ctx.db`
            UPDATE back_in_stock_subscriptions
            SET status = 'notified', notified_at = NOW()
            WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variant_id} AND status = 'pending'
            RETURNING id, email, product_title, variant_title, image_url
          `;

          if (claimed.length === 0) {
            return { success: true, notified_count: 0, message: 'No pending subscriptions found' };
          }

          for (const sub of claimed) {
            await ctx.services.email.send({
              to: sub.email,
              subject: `${sub.product_title} is back in stock!`,
              data: {
                product_title: sub.product_title,
                variant_title: sub.variant_title,
                image_url: sub.image_url,
              },
            });

            const logId = uuidv4();
            await ctx.db`
              INSERT INTO notification_log (id, tenant_id, subscription_id, email, variant_id, trigger_type, sent_at)
              VALUES (${logId}, ${ctx.tenantId}, ${String(sub.id)}, ${sub.email}, ${variant_id}, 'manual_variant', NOW())
            `;
          }

          return { success: true, notified_count: claimed.length, message: `Notified ${claimed.length} subscriber(s)` };
        }

        if (ctx.adminPath === '/admin/notification-log/list') {
          const { page = 1, page_size = 20, variant_id } = ctx.adminBody || {};
          const offset = (page - 1) * page_size;

          let rows;
          let countRows;

          if (variant_id) {
            rows = await ctx.db`
              SELECT id, subscription_id, email, variant_id, trigger_type, sent_at
              FROM notification_log
              WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variant_id}
              ORDER BY sent_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM notification_log
              WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variant_id}
            `;
          } else {
            rows = await ctx.db`
              SELECT id, subscription_id, email, variant_id, trigger_type, sent_at
              FROM notification_log
              WHERE tenant_id = ${ctx.tenantId}
              ORDER BY sent_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM notification_log
              WHERE tenant_id = ${ctx.tenantId}
            `;
          }

          const total = parseInt(countRows[0].total, 10);
          const items = rows.map(r => ({
            id: String(r.id),
            subscription_id: String(r.subscription_id),
            email: r.email,
            variant_id: Number(r.variant_id),
            trigger_type: r.trigger_type,
            sent_at: r.sent_at ? r.sent_at.toISOString() : null,
          }));

          return { items, total, page: Number(page), page_size: Number(page_size) };
        }

        ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
        return { error: 'unknown path' };
      }

      // ── WEBHOOK: inventory_levels/update ────────────────────────────────────
      if (ctx.trigger === 'webhook') {
        const { inventory_item_id, location_id, available } = ctx.payload;

        ctx.logger.info({ inventory_item_id, location_id, available }, 'inventory_levels/update received');

        if (inventory_item_id == null || location_id == null || available == null) {
          ctx.logger.warn('Missing required payload fields, skipping');
          return;
        }

        const stockStatus = available > 0 ? 'in_stock' : 'out_of_stock';

        // Resolve variant and product via REST
        const variantsResp = await ctx.shopify.get(`/variants.json?inventory_item_id=${inventory_item_id}`);
        const variants = variantsResp && variantsResp.variants ? variantsResp.variants : [];

        if (variants.length === 0) {
          ctx.logger.warn({ inventory_item_id }, 'No variant found for inventory_item_id');
          // Still upsert state
          await ctx.db`
            INSERT INTO inventory_level_states (id, tenant_id, inventory_item_id, location_id, variant_id, stock_status, available_quantity, updated_at)
            VALUES (${uuidv4()}, ${ctx.tenantId}, ${inventory_item_id}, ${location_id}, NULL, ${stockStatus}, ${available}, NOW())
            ON CONFLICT (tenant_id, inventory_item_id, location_id)
            DO UPDATE SET stock_status = ${stockStatus}, available_quantity = ${available}, updated_at = NOW()
          `;
          return;
        }

        const variant = variants[0];
        const variantId = variant.id;
        const productId = variant.product_id;

        // Fetch product for title info
        const productResp = await ctx.shopify.get(`/products/${productId}.json?fields=id,title,images,variants`);
        const product = productResp && productResp.product ? productResp.product : null;

        // Fetch previous state
        const prevRows = await ctx.db`
          SELECT stock_status FROM inventory_level_states
          WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventory_item_id} AND location_id = ${location_id}
          LIMIT 1
        `;

        const prevState = prevRows.length > 0 ? prevRows[0].stock_status : null;

        ctx.logger.info({ prevState, stockStatus, inventory_item_id, variantId }, 'State transition check');

        // Upsert inventory state
        await ctx.db`
          INSERT INTO inventory_level_states (id, tenant_id, inventory_item_id, location_id, variant_id, stock_status, available_quantity, updated_at)
          VALUES (${uuidv4()}, ${ctx.tenantId}, ${inventory_item_id}, ${location_id}, ${variantId}, ${stockStatus}, ${available}, NOW())
          ON CONFLICT (tenant_id, inventory_item_id, location_id)
          DO UPDATE SET stock_status = ${stockStatus}, available_quantity = ${available}, variant_id = ${variantId}, updated_at = NOW()
        `;

        // Only act on out_of_stock → in_stock transition
        const isTransition = prevState !== null && prevState === 'out_of_stock' && stockStatus === 'in_stock';

        if (!isTransition) {
          ctx.logger.info({ prevState, stockStatus }, 'No back-in-stock transition, skipping notifications');
          return;
        }

        ctx.logger.info({ variantId, productId }, 'Back-in-stock transition detected, querying subscribers');

        // Atomically claim pending subscriptions
        const claimed = await ctx.db`
          UPDATE back_in_stock_subscriptions
          SET status = 'notified', notified_at = NOW()
          WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variantId} AND status = 'pending'
          RETURNING id, email, product_title, variant_title, image_url
        `;

        if (claimed.length === 0) {
          ctx.logger.info({ variantId }, 'No pending subscribers, done');
          return;
        }

        ctx.logger.info({ variantId, count: claimed.length }, 'Claimed subscriptions, sending emails');

        // Enrich product info from Shopify if available
        const productTitle = product ? product.title : (claimed[0].product_title || '');
        const productVariant = product ? (product.variants || []).find(v => String(v.id) === String(variantId)) : null;
        const variantTitle = productVariant ? productVariant.title : (claimed[0].variant_title || '');
        const imageUrl = product && product.images && product.images.length > 0 ? product.images[0].src : (claimed[0].image_url || '');

        for (const sub of claimed) {
          await ctx.services.email.send({
            to: sub.email,
            subject: `${sub.product_title || productTitle} is back in stock!`,
            data: {
              product_title: sub.product_title || productTitle,
              variant_title: sub.variant_title || variantTitle,
              image_url: sub.image_url || imageUrl,
            },
          });

          const logId = uuidv4();
          await ctx.db`
            INSERT INTO notification_log (id, tenant_id, subscription_id, email, variant_id, trigger_type, sent_at)
            VALUES (${logId}, ${ctx.tenantId}, ${String(sub.id)}, ${sub.email}, ${variantId}, 'back_in_stock', NOW())
          `;
        }

        ctx.logger.info({ variantId, notified: claimed.length }, 'Back-in-stock notifications sent');
        return;
      }

    } catch (err) {
      ctx.logger.error({ error: err.message, stack: err.stack }, 'Handler error');
      throw err;
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE back_in_stock_subscriptions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL,
  customer_id    BIGINT      NULL,
  email          TEXT        NOT NULL,
  product_id     BIGINT      NOT NULL,
  variant_id     BIGINT      NOT NULL,
  product_title  TEXT        NOT NULL,
  variant_title  TEXT        NULL,
  image_url      TEXT        NULL,
  status         TEXT        NOT NULL DEFAULT 'pending',
  notified_at    TIMESTAMPTZ NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, variant_id, email)
);

ALTER TABLE back_in_stock_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY back_in_stock_subscriptions_tenant_isolation ON back_in_stock_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX back_in_stock_subscriptions_tenant_id_idx ON back_in_stock_subscriptions (tenant_id);
CREATE INDEX back_in_stock_subscriptions_tenant_variant_idx ON back_in_stock_subscriptions (tenant_id, variant_id);
CREATE INDEX back_in_stock_subscriptions_tenant_email_idx ON back_in_stock_subscriptions (tenant_id, email);
CREATE INDEX back_in_stock_subscriptions_tenant_status_idx ON back_in_stock_subscriptions (tenant_id, status);

CREATE TABLE inventory_level_states (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL,
  inventory_item_id   BIGINT      NOT NULL,
  location_id         BIGINT      NOT NULL,
  variant_id          BIGINT      NULL,
  stock_status        TEXT        NULL,
  available_quantity  INTEGER     NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, inventory_item_id, location_id)
);

ALTER TABLE inventory_level_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_level_states_tenant_isolation ON inventory_level_states
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX inventory_level_states_tenant_id_idx ON inventory_level_states (tenant_id);
CREATE INDEX inventory_level_states_tenant_inventory_item_idx ON inventory_level_states (tenant_id, inventory_item_id);
CREATE INDEX inventory_level_states_tenant_variant_idx ON inventory_level_states (tenant_id, variant_id);

CREATE TABLE notification_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  subscription_id  UUID        NOT NULL REFERENCES back_in_stock_subscriptions(id) ON DELETE CASCADE,
  email            TEXT        NOT NULL,
  variant_id       BIGINT      NOT NULL,
  trigger_type     TEXT        NOT NULL,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_log_tenant_isolation ON notification_log
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX notification_log_tenant_id_idx ON notification_log (tenant_id);
CREATE INDEX notification_log_tenant_subscription_idx ON notification_log (tenant_id, subscription_id);
CREATE INDEX notification_log_tenant_variant_idx ON notification_log (tenant_id, variant_id);
```

### widget.js

```javascript
export function mount(container, host) {
  const styles = `
    .btns-widget {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 480px;
    }
    .btns-widget * {
      box-sizing: border-box;
    }
    .btns-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 12px;
    }
    .btns-label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #444;
      margin-bottom: 4px;
    }
    .btns-input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 14px;
      color: #111;
      outline: none;
      transition: border-color 0.2s;
    }
    .btns-input:focus {
      border-color: #5b21b6;
      box-shadow: 0 0 0 3px rgba(91,33,182,0.1);
    }
    .btns-btn {
      padding: 10px 18px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, opacity 0.2s;
    }
    .btns-btn-primary {
      background: #5b21b6;
      color: #fff;
    }
    .btns-btn-primary:hover {
      background: #4c1d95;
    }
    .btns-btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .btns-btn-secondary {
      background: transparent;
      color: #5b21b6;
      border: 1px solid #5b21b6;
      padding: 6px 12px;
      font-size: 13px;
    }
    .btns-btn-secondary:hover {
      background: #f3f0ff;
    }
    .btns-message {
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 13px;
      line-height: 1.5;
    }
    .btns-message-success {
      background: #ecfdf5;
      color: #065f46;
      border: 1px solid #a7f3d0;
    }
    .btns-message-error {
      background: #fef2f2;
      color: #991b1b;
      border: 1px solid #fecaca;
    }
    .btns-message-info {
      background: #eff6ff;
      color: #1e40af;
      border: 1px solid #bfdbfe;
    }
    .btns-spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.4);
      border-top-color: #fff;
      border-radius: 50%;
      animation: btns-spin 0.7s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes btns-spin {
      to { transform: rotate(360deg); }
    }
    .btns-already {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .btns-already-text {
      font-size: 13px;
      color: #065f46;
    }
    .btns-title {
      font-size: 15px;
      font-weight: 700;
      color: #111;
      margin: 0 0 4px 0;
    }
    .btns-subtitle {
      font-size: 13px;
      color: #6b7280;
      margin: 0 0 8px 0;
    }
    .btns-hidden {
      display: none;
    }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = styles;
  container.appendChild(styleEl);

  const root = document.createElement('div');
  root.className = 'btns-widget';
  container.appendChild(root);

  let productData = null;
  let variantId = null;
  let variantTitle = null;
  let imageUrl = null;
  let currentState = 'loading';

  function render(state, opts = {}) {
    currentState = state;
    root.innerHTML = '';

    if (state === 'loading') {
      root.innerHTML = '<p style="font-size:13px;color:#6b7280;">Loading...</p>';
      return;
    }

    if (state === 'unavailable') {
      return;
    }

    if (state === 'in-stock') {
      return;
    }

    if (state === 'error') {
      const msg = document.createElement('div');
      msg.className = 'btns-message btns-message-error';
      msg.textContent = opts.message || 'Something went wrong. Please try again.';
      root.appendChild(msg);
      return;
    }

    if (state === 'form') {
      const title = document.createElement('p');
      title.className = 'btns-title';
      title.textContent = 'Notify me when back in stock';
      root.appendChild(title);

      const subtitle = document.createElement('p');
      subtitle.className = 'btns-subtitle';
      subtitle.textContent = 'Enter your email and we\'ll let you know as soon as this item is available again.';
      root.appendChild(subtitle);

      const form = document.createElement('form');
      form.className = 'btns-form';
      form.id = 'btns-notify-form';

      const labelEl = document.createElement('label');
      labelEl.className = 'btns-label';
      labelEl.setAttribute('for', 'btns-email-input');
      labelEl.textContent = 'Email address';
      form.appendChild(labelEl);

      const input = document.createElement('input');
      input.type = 'email';
      input.id = 'btns-email-input';
      input.name = 'email';
      input.className = 'btns-input';
      input.placeholder = 'you@example.com';
      input.required = true;
      if (host.context.customerId) {
        input.setAttribute('data-prefill', 'true');
      }
      form.appendChild(input);

      if (opts.errorMsg) {
        const errDiv = document.createElement('div');
        errDiv.className = 'btns-message btns-message-error';
        errDiv.textContent = opts.errorMsg;
        form.appendChild(errDiv);
      }

      const btn = document.createElement('button');
      btn.type = 'submit';
      btn.className = 'btns-btn btns-btn-primary';
      btn.textContent = 'Notify Me';
      form.appendChild(btn);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = host.getFormData(form);
        const email = (data.email || '').trim();
        if (!email) {
          render('form', { errorMsg: 'Please enter a valid email address.' });
          return;
        }
        btn.disabled = true;
        btn.innerHTML = '<span class="btns-spinner"></span> Subscribing...';
        await handleSubscribe(email);
      });

      root.appendChild(form);
      return;
    }

    if (state === 'submitting') {
      const msg = document.createElement('div');
      msg.className = 'btns-message btns-message-info';
      msg.innerHTML = '<span class="btns-spinner" style="border-top-color:#1e40af;border-color:rgba(30,64,175,0.3);"></span> Subscribing you...';
      root.appendChild(msg);
      return;
    }

    if (state === 'already-subscribed') {
      const title = document.createElement('p');
      title.className = 'btns-title';
      title.textContent = 'Already subscribed';
      root.appendChild(title);

      const wrapper = document.createElement('div');
      wrapper.className = 'btns-already';

      const text = document.createElement('span');
      text.className = 'btns-already-text';
      text.textContent = '✓ You\'re on the list! We\'ll notify you when this item is back.';
      wrapper.appendChild(text);

      const changeBtn = document.createElement('button');
      changeBtn.className = 'btns-btn btns-btn-secondary';
      changeBtn.textContent = 'Use different email';
      changeBtn.addEventListener('click', () => render('form'));
      wrapper.appendChild(changeBtn);

      root.appendChild(title);
      root.appendChild(wrapper);
      return;
    }

    if (state === 'success') {
      const msg = document.createElement('div');
      msg.className = 'btns-message btns-message-success';
      msg.textContent = '✓ You\'re subscribed! We\'ll email you when this item is back in stock.';
      root.appendChild(msg);
      return;
    }
  }

  async function handleSubscribe(email) {
    try {
      const checkResult = await host.call('/subscriptions/check', {
        email: email,
        variant_id: variantId
      });

      if (checkResult && checkResult.subscribed) {
        render('already-subscribed');
        return;
      }

      const createResult = await host.call('/subscriptions/create', {
        email: email,
        product_id: productData.id,
        variant_id: variantId,
        product_title: productData.title || '',
        variant_title: variantTitle || '',
        image_url: imageUrl || ''
      });

      if (createResult && createResult.success) {
        render('success');
      } else {
        render('form', { errorMsg: (createResult && createResult.message) || 'Could not subscribe. Please try again.' });
      }
    } catch (err) {
      render('form', { errorMsg: 'An error occurred. Please try again.' });
    }
  }

  async function init() {
    render('loading');

    try {
      const pathname = location.pathname;
      const search = location.search;

      if (!pathname.startsWith('/products/')) {
        render('unavailable');
        return;
      }

      const handle = pathname.replace('/products/', '').split('/')[0].split('?')[0];
      if (!handle) {
        render('unavailable');
        return;
      }

      const product = await host.storefront('/products/' + handle + '.js');
      if (!product || !product.variants) {
        render('unavailable');
        return;
      }

      productData = product;

      let selectedVariant = null;

      const params = new URLSearchParams(search);
      const variantParam = params.get('variant');

      if (variantParam) {
        const vid = parseInt(variantParam, 10);
        selectedVariant = product.variants.find(v => v.id === vid) || null;
      }

      if (!selectedVariant) {
        selectedVariant = product.variants[0] || null;
      }

      if (!selectedVariant) {
        render('unavailable');
        return;
      }

      variantId = selectedVariant.id;
      variantTitle = selectedVariant.title || '';

      if (product.images && product.images.length > 0) {
        imageUrl = product.images[0].src || '';
      } else if (selectedVariant.featured_image && selectedVariant.featured_image.src) {
        imageUrl = selectedVariant.featured_image.src;
      } else {
        imageUrl = '';
      }

      const available = selectedVariant.available;

      if (available) {
        render('in-stock');
        return;
      }

      render('form');

    } catch (err) {
      render('error', { message: 'Unable to load product information.' });
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
    .tab-btn { background: none; border: none; border-bottom: 3px solid transparent; padding: var(--p-space-200) var(--p-space-400); cursor: pointer; font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text-secondary); margin-bottom: -1px; }
    .tab-btn.active { color: var(--p-color-text); border-bottom-color: #008060; }
    .tab-btn:hover { color: var(--p-color-text); }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .filter-row { display: flex; gap: var(--p-space-200); align-items: center; flex-wrap: wrap; margin-bottom: var(--p-space-400); }
    .filter-row select, .filter-row input { padding: var(--p-space-200) var(--p-space-300); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); font-size: var(--p-font-size-350); background: var(--p-color-bg-surface); color: var(--p-color-text); }
    .filter-row label { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); font-weight: var(--p-font-weight-medium); }
    .action-cell { display: flex; gap: var(--p-space-100); }
    .btn-sm { padding: var(--p-space-100) var(--p-space-200); font-size: var(--p-font-size-300); }
    .stat-info { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-top: var(--p-space-100); }
    .notify-variant-box { background: var(--p-color-bg-surface-secondary); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-200); padding: var(--p-space-400); margin-bottom: var(--p-space-400); }
    .notify-variant-box h3 { margin: 0 0 var(--p-space-200) 0; font-size: var(--p-font-size-400); font-weight: var(--p-font-weight-semibold); color: var(--p-color-text); }
    .notify-variant-box p { margin: 0 0 var(--p-space-300) 0; font-size: var(--p-font-size-350); color: var(--p-color-text-secondary); }
    .notify-variant-row { display: flex; gap: var(--p-space-200); align-items: flex-end; flex-wrap: wrap; }
    .notify-variant-row .field { display: flex; flex-direction: column; gap: var(--p-space-100); }
    .notify-variant-row label { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); font-weight: var(--p-font-weight-medium); }
    .notify-variant-row input { padding: var(--p-space-200) var(--p-space-300); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); font-size: var(--p-font-size-350); background: var(--p-color-bg-surface); color: var(--p-color-text); min-width: 200px; }
    .limitation-banner { background: var(--p-color-bg-fill-warning); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-200); padding: var(--p-space-300) var(--p-space-400); margin-bottom: var(--p-space-400); font-size: var(--p-font-size-300); color: var(--p-color-text); }
    .limitation-banner strong { font-weight: var(--p-font-weight-semibold); }
    .limitation-banner ul { margin: var(--p-space-100) 0 0 var(--p-space-400); padding: 0; }
    .limitation-banner li { margin-bottom: var(--p-space-100); }
    .log-trigger { font-family: monospace; font-size: var(--p-font-size-300); background: var(--p-color-bg-surface-secondary); padding: 2px var(--p-space-200); border-radius: var(--p-border-radius-100); }
    .empty-state { text-align: center; padding: var(--p-space-800) var(--p-space-400); color: var(--p-color-text-secondary); font-size: var(--p-font-size-350); }
    .empty-state svg { display: block; margin: 0 auto var(--p-space-300); opacity: 0.4; }
    .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--p-space-300); }
    .section-header h2 { margin: 0; font-size: var(--p-font-size-400); font-weight: var(--p-font-weight-semibold); color: var(--p-color-text); }
    .total-count { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); }
  `;

  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Back-in-Stock Notifications</span>
      </div>
      <div class="tabs">
        <button class="tab-btn active" data-tab="subscriptions">Subscriptions</button>
        <button class="tab-btn" data-tab="notify">Trigger Alerts</button>
        <button class="tab-btn" data-tab="log">Notification Log</button>
      </div>

      <!-- Subscriptions Tab -->
      <div id="tab-subscriptions" class="tab-panel active">
        <div class="shell-card">
          <div class="section-header">
            <h2>Subscriptions <span id="sub-total-badge" class="total-count"></span></h2>
            <button class="btn-secondary btn-sm" id="sub-refresh-btn">Refresh</button>
          </div>
          <div class="filter-row">
            <div>
              <label>Status</label><br>
              <select id="sub-status-filter">
                <option value="">All</option>
                <option value="active">Active</option>
                <option value="notified">Notified</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
            <div>
              <label>Variant ID</label><br>
              <input type="number" id="sub-variant-filter" placeholder="Filter by variant ID" style="min-width:180px;">
            </div>
            <div style="align-self:flex-end;">
              <button class="btn-primary btn-sm" id="sub-apply-filter-btn">Apply</button>
            </div>
          </div>
          <div id="sub-content"></div>
          <div class="shell-pagination" id="sub-pagination"></div>
        </div>
      </div>

      <!-- Trigger Alerts Tab -->
      <div id="tab-notify" class="tab-panel">
        <div class="limitation-banner">
          <strong>⚠ Backend Limitations to Note</strong>
          <ul>
            <li>Webhook payloads from Shopify inventory updates include only <code>inventory_item_id</code> — the backend must resolve variant/product info via a secondary Shopify API call before matching subscribers.</li>
            <li>Emails are dispatched individually per subscriber (no batch API) — large subscriber lists may take time to process.</li>
          </ul>
        </div>
        <div class="notify-variant-box">
          <h3>Notify All Subscribers for a Variant</h3>
          <p>Enter a variant ID to send back-in-stock notifications to all active subscribers for that product variant. All matching subscribers will be emailed individually.</p>
          <div class="notify-variant-row">
            <div class="field">
              <label for="notify-variant-id-input">Variant ID</label>
              <input type="number" id="notify-variant-id-input" placeholder="e.g. 12345678901">
            </div>
            <div style="align-self:flex-end;">
              <button class="btn-primary" id="notify-variant-btn">Send Notifications</button>
            </div>
          </div>
          <div id="notify-variant-result" style="margin-top:var(--p-space-300);"></div>
        </div>
      </div>

      <!-- Notification Log Tab -->
      <div id="tab-log" class="tab-panel">
        <div class="shell-card">
          <div class="section-header">
            <h2>Notification Log <span id="log-total-badge" class="total-count"></span></h2>
            <button class="btn-secondary btn-sm" id="log-refresh-btn">Refresh</button>
          </div>
          <div class="filter-row">
            <div>
              <label>Variant ID</label><br>
              <input type="number" id="log-variant-filter" placeholder="Filter by variant ID" style="min-width:180px;">
            </div>
            <div style="align-self:flex-end;">
              <button class="btn-primary btn-sm" id="log-apply-filter-btn">Apply</button>
            </div>
          </div>
          <div id="log-content"></div>
          <div class="shell-pagination" id="log-pagination"></div>
        </div>
      </div>

    </div>
  `;

  container.appendChild(style);

  // --- State ---
  const state = {
    subs: { page: 1, page_size: 25, total: 0, status: '', variant_id: null, loading: false },
    log: { page: 1, page_size: 25, total: 0, variant_id: null, loading: false },
    activeTab: 'subscriptions',
  };

  // --- Tab switching ---
  const tabBtns = container.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      container.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      container.querySelector('#tab-' + tab).classList.add('active');
      state.activeTab = tab;
    });
  });

  // --- Helpers ---
  function formatDate(str) {
    if (!str) return '—';
    try {
      const d = new Date(str);
      return d.toLocaleString();
    } catch (e) { return str; }
  }

  function statusBadge(status) {
    const map = { active: 'badge-success', notified: 'badge-neutral', cancelled: 'badge-warning' };
    const cls = map[status] || 'badge-neutral';
    return `<span class="badge ${cls}">${status || '—'}</span>`;
  }

  function triggerBadge(type) {
    const map = { webhook: 'badge-neutral', manual: 'badge-success', widget: 'badge-warning' };
    const cls = map[type] || 'badge-neutral';
    return `<span class="log-trigger">${type || '—'}</span>`;
  }

  function renderLoading(el) {
    el.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;
  }

  function renderError(el, msg) {
    el.innerHTML = `<div class="shell-error-banner">${msg}</div>`;
  }

  function renderEmptyState(el, msg) {
    el.innerHTML = `<div class="empty-state">${msg}</div>`;
  }

  // --- Subscriptions ---
  function loadSubscriptions() {
    if (state.subs.loading) return;
    state.subs.loading = true;

    const contentEl = container.querySelector('#sub-content');
    renderLoading(contentEl);
    container.querySelector('#sub-pagination').innerHTML = '';
    container.querySelector('#sub-total-badge').textContent = '';

    const body = {
      page: state.subs.page,
      page_size: state.subs.page_size,
    };
    if (state.subs.status) body.status = state.subs.status;
    if (state.subs.variant_id) body.variant_id = state.subs.variant_id;

    bridge.call('/admin/subscriptions/list', body).then(res => {
      state.subs.loading = false;
      state.subs.total = res.total || 0;
      container.querySelector('#sub-total-badge').textContent = `(${res.total || 0} total)`;
      renderSubscriptionsTable(contentEl, res.items || []);
      renderPagination(
        container.querySelector('#sub-pagination'),
        state.subs.page,
        state.subs.page_size,
        state.subs.total,
        (p) => { state.subs.page = p; loadSubscriptions(); }
      );
    }).catch(err => {
      state.subs.loading = false;
      renderError(contentEl, 'Failed to load subscriptions. Please try again.');
    });
  }

  function renderSubscriptionsTable(el, items) {
    if (!items.length) {
      renderEmptyState(el, 'No subscriptions found matching your filters.');
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
          <th>Variant ID</th>
          <th>Status</th>
          <th>Notified At</th>
          <th>Created At</th>
          <th>Actions</th>
        </tr>
      </thead>
    `;

    const tbody = document.createElement('tbody');
    items.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item.email || '—'}</td>
        <td>${item.product_title || '—'}</td>
        <td>${item.variant_title || '—'}</td>
        <td><code>${item.variant_id || '—'}</code></td>
        <td>${statusBadge(item.status)}</td>
        <td>${formatDate(item.notified_at)}</td>
        <td>${formatDate(item.created_at)}</td>
        <td>
          <div class="action-cell">
            <button class="btn-primary btn-sm" data-action="notify" data-id="${item.id}" ${item.status !== 'active' ? 'disabled' : ''}>Notify</button>
            <button class="btn-danger btn-sm" data-action="delete" data-id="${item.id}">Delete</button>
          </div>
        </td>
      `;

      tr.querySelector('[data-action="notify"]').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '...';
        bridge.call('/admin/subscriptions/notify', { subscription_id: item.id }).then(res => {
          if (res.success) {
            bridge.notify(res.message || 'Notification sent!', 'success');
            loadSubscriptions();
          } else {
            bridge.notify(res.message || 'Failed to send notification.', 'error');
            btn.disabled = false;
            btn.textContent = 'Notify';
          }
        }).catch(() => {
          bridge.notify('Error sending notification.', 'error');
          btn.disabled = false;
          btn.textContent = 'Notify';
        });
      });

      tr.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        showConfirmDelete(item.id, item.email, item.product_title);
      });

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    el.innerHTML = '';
    el.appendChild(wrap);
  }

  // --- Confirm Delete Modal ---
  function showConfirmDelete(subscriptionId, email, productTitle) {
    const overlay = document.createElement('div');
    overlay.className = 'shell-confirm-overlay';
    overlay.innerHTML = `
      <div class="shell-confirm-dialog">
        <div class="shell-confirm-title">Delete Subscription</div>
        <div class="shell-confirm-body">
          Are you sure you want to delete the subscription for <strong>${email}</strong> for <strong>${productTitle || 'this product'}</strong>? This action cannot be undone.
        </div>
        <div class="shell-confirm-actions">
          <button class="btn-secondary" id="confirm-cancel-btn">Cancel</button>
          <button class="btn-danger" id="confirm-delete-btn">Delete</button>
        </div>
      </div>
    `;

    container.appendChild(overlay);

    overlay.querySelector('#confirm-cancel-btn').addEventListener('click', () => {
      container.removeChild(overlay);
    });

    overlay.querySelector('#confirm-delete-btn').addEventListener('click', () => {
      const deleteBtn = overlay.querySelector('#confirm-delete-btn');
      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting...';
      bridge.call('/admin/subscriptions/delete', { subscription_id: subscriptionId }).then(res => {
        container.removeChild(overlay);
        if (res.success) {
          bridge.notify('Subscription deleted.', 'success');
          loadSubscriptions();
        } else {
          bridge.notify('Failed to delete subscription.', 'error');
        }
      }).catch(() => {
        container.removeChild(overlay);
        bridge.notify('Error deleting subscription.', 'error');
      });
    });
  }

  // --- Pagination ---
  function renderPagination(el, page, pageSize, total, onPageChange) {
    el.innerHTML = '';
    const totalPages = Math.ceil(total / pageSize);
    if (totalPages <= 1) return;

    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);

    const info = document.createElement('span');
    info.textContent = `Showing ${start}–${end} of ${total}`;
    info.style.fontSize = 'var(--p-font-size-300)';
    info.style.color = 'var(--p-color-text-secondary)';

    const btns = document.createElement('div');
    btns.className = 'shell-pagination-btns';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'btn-secondary btn-sm';
    prevBtn.textContent = '← Prev';
    prevBtn.disabled = page <= 1;
    prevBtn.addEventListener('click', () => onPageChange(page - 1));

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn-secondary btn-sm';
    nextBtn.textContent = 'Next →';
    nextBtn.disabled = page >= totalPages;
    nextBtn.addEventListener('click', () => onPageChange(page + 1));

    const pageInfo = document.createElement('span');
    pageInfo.textContent = `Page ${page} of ${totalPages}`;
    pageInfo.style.fontSize = 'var(--p-font-size-300)';
    pageInfo.style.color = 'var(--p-color-text-secondary)';
    pageInfo.style.alignSelf = 'center';

    btns.appendChild(prevBtn);
    btns.appendChild(pageInfo);
    btns.appendChild(nextBtn);

    el.appendChild(info);
    el.appendChild(btns);
  }

  // --- Notification Log ---
  function loadLog() {
    if (state.log.loading) return;
    state.log.loading = true;

    const contentEl = container.querySelector('#log-content');
    renderLoading(contentEl);
    container.querySelector('#log-pagination').innerHTML = '';
    container.querySelector('#log-total-badge').textContent = '';

    const body = {
      page: state.log.page,
      page_size: state.log.page_size,
    };
    if (state.log.variant_id) body.variant_id = state.log.variant_id;

    bridge.call('/admin/notification-log/list', body).then(res => {
      state.log.loading = false;
      state.log.total = res.total || 0;
      container.querySelector('#log-total-badge').textContent = `(${res.total || 0} total)`;
      renderLogTable(contentEl, res.items || []);
      renderPagination(
        container.querySelector('#log-pagination'),
        state.log.page,
        state.log.page_size,
        state.log.total,
        (p) => { state.log.page = p; loadLog(); }
      );
    }).catch(err => {
      state.log.loading = false;
      renderError(contentEl, 'Failed to load notification log. Please try again.');
    });
  }

  function renderLogTable(el, items) {
    if (!items.length) {
      renderEmptyState(el, 'No notification log entries found.');
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
          <th>Subscription ID</th>
          <th>Trigger</th>
          <th>Sent At</th>
        </tr>
      </thead>
    `;

    const tbody = document.createElement('tbody');
    items.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item.email || '—'}</td>
        <td><code>${item.variant_id || '—'}</code></td>
        <td><code style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary);">${item.subscription_id || '—'}</code></td>
        <td>${triggerBadge(item.trigger_type)}</td>
        <td>${formatDate(item.sent_at)}</td>
      `;
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    el.innerHTML = '';
    el.appendChild(wrap);
  }

  // --- Notify Variant ---
  const notifyVariantBtn = container.querySelector('#notify-variant-btn');
  const notifyVariantInput = container.querySelector('#notify-variant-id-input');
  const notifyVariantResult = container.querySelector('#notify-variant-result');

  notifyVariantBtn.addEventListener('click', () => {
    const rawVal = notifyVariantInput.value.trim();
    if (!rawVal) {
      notifyVariantResult.innerHTML = `<div class="shell-error-banner">Please enter a variant ID.</div>`;
      return;
    }
    const variantId = parseInt(rawVal, 10);
    if (isNaN(variantId) || variantId <= 0) {
      notifyVariantResult.innerHTML = `<div class="shell-error-banner">Please enter a valid numeric variant ID.</div>`;
      return;
    }

    notifyVariantBtn.disabled = true;
    notifyVariantBtn.textContent = 'Sending...';
    notifyVariantResult.innerHTML = `<div class="shell-loading"><div class="shell-spinner"></div></div>`;

    bridge.call('/admin/subscriptions/notify-variant', { variant_id: variantId }).then(res => {
      notifyVariantBtn.disabled = false;
      notifyVariantBtn.textContent = 'Send Notifications';

      if (res.success) {
        notifyVariantResult.innerHTML = `
          <div style="background:var(--p-color-bg-fill-success);border:1px solid var(--p-color-border);border-radius:var(--p-border-radius-100);padding:var(--p-space-300) var(--p-space-400);font-size:var(--p-font-size-350);color:var(--p-color-text-success);">
            ✓ ${res.message || 'Notifications sent.'} <strong>${res.notified_count}</strong> subscriber(s) notified.
          </div>
        `;
        bridge.notify(res.message || `Notified ${res.notified_count} subscriber(s).`, 'success');
      } else {
        notifyVariantResult.innerHTML = `<div class="shell-error-banner">${res.message || 'Failed to send notifications.'}</div>`;
        bridge.notify(res.message || 'Failed to send notifications.', 'error');
      }
    }).catch(() => {
      notifyVariantBtn.disabled = false;
      notifyVariantBtn.textContent = 'Send Notifications';
      notifyVariantResult.innerHTML = `<div class="shell-error-banner">Error sending notifications. Please try again.</div>`;
      bridge.notify('Error sending notifications.', 'error');
    });
  });

  // --- Filter bindings ---
  container.querySelector('#sub-apply-filter-btn').addEventListener('click', () => {
    const statusVal = container.querySelector('#sub-status-filter').value;
    const variantVal = container.querySelector('#sub-variant-filter').value.trim();
    state.subs.status = statusVal;
    state.subs.variant_id = variantVal ? parseInt(variantVal, 10) : null;
    state.subs.page = 1;
    loadSubscriptions();
  });

  container.querySelector('#sub-status-filter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') container.querySelector('#sub-apply-filter-btn').click();
  });

  container.querySelector('#sub-variant-filter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') container.querySelector('#sub-apply-filter-btn').click();
  });

  container.querySelector('#sub-refresh-btn').addEventListener('click', () => {
    loadSubscriptions();
  });

  container.querySelector('#log-apply-filter-btn').addEventListener('click', () => {
    const variantVal = container.querySelector('#log-variant-filter').value.trim();
    state.log.variant_id = variantVal ? parseInt(variantVal, 10) : null;
    state.log.page = 1;
    loadLog();
  });

  container.querySelector('#log-variant-filter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') container.querySelector('#log-apply-filter-btn').click();
  });

  container.querySelector('#log-refresh-btn').addEventListener('click', () => {
    loadLog();
  });

  // --- Tab click auto-load ---
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if (tab === 'log') {
        loadLog();
      }
    });
  });

  // --- Initial load ---
  loadSubscriptions();
}
```

