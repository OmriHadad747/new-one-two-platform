# Chat Local — Codegen Output

**Date:** 2026-04-09 16:53:37  
**Prompt:** Customers receive notifications when subscribed products are back in stock, and merchants can review and manage all active subscriptions from the admin panel.

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
      // ── WIDGET TRIGGER ──────────────────────────────────────────────────────
      if (ctx.trigger === 'widget') {
        ctx.logger.info({ trigger: ctx.trigger, widgetPath: ctx.widgetPath }, 'widget invoke');

        // POST /subscribe
        if (ctx.widgetPath === '/subscribe') {
          const { email, product_id, variant_id, product_title, variant_title, customer_id } = ctx.widgetBody;

          if (!email || !product_id || !variant_id) {
            return { success: false, message: 'Missing required fields', subscription_id: '' };
          }

          const id = uuidv4();
          const inserted = await ctx.db`
            INSERT INTO back_in_stock_subscriptions
              (id, tenant_id, customer_id, email, product_id, variant_id, product_title, variant_title, status, created_at)
            VALUES
              (${id}, ${ctx.tenantId}, ${customer_id || null}, ${email}, ${product_id}, ${variant_id},
               ${product_title}, ${variant_title || null}, 'active', NOW())
            ON CONFLICT (tenant_id, email, variant_id) DO NOTHING
            RETURNING id
          `;

          if (inserted.length === 0) {
            // Already subscribed — find existing
            const [existing] = await ctx.db`
              SELECT id FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND email = ${email} AND variant_id = ${variant_id}
            `;
            return { success: true, message: 'Already subscribed', subscription_id: existing ? String(existing.id) : '' };
          }

          return { success: true, message: 'Subscribed successfully', subscription_id: String(inserted[0].id) };
        }

        // POST /subscribe/check
        if (ctx.widgetPath === '/subscribe/check') {
          const { email, variant_id } = ctx.widgetBody;

          const rows = await ctx.db`
            SELECT id FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND email = ${email} AND variant_id = ${variant_id}
              AND status = 'active'
          `;

          return { subscribed: rows.length > 0 };
        }

        // POST /subscribe/cancel
        if (ctx.widgetPath === '/subscribe/cancel') {
          const { email, variant_id } = ctx.widgetBody;

          await ctx.db`
            UPDATE back_in_stock_subscriptions
            SET status = 'cancelled'
            WHERE tenant_id = ${ctx.tenantId} AND email = ${email} AND variant_id = ${variant_id}
              AND status = 'active'
          `;

          return { success: true };
        }

        ctx.logger.warn({ widgetPath: ctx.widgetPath }, 'widget: unknown path');
        return { error: 'unknown path' };
      }

      // ── ADMIN TRIGGER ───────────────────────────────────────────────────────
      if (ctx.trigger === 'admin') {
        ctx.logger.info({ adminPath: ctx.adminPath }, 'admin invoke');

        // GET /admin/subscriptions
        if (ctx.adminPath === '/admin/subscriptions') {
          const { page = 1, page_size = 20, status = null, product_id = null } = ctx.adminBody || {};
          const offset = (page - 1) * page_size;

          let countRows, dataRows;

          if (status !== null && product_id !== null) {
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status} AND product_id = ${product_id}
            `;
            dataRows = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title,
                     status, created_at, notified_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status} AND product_id = ${product_id}
              ORDER BY created_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
          } else if (status !== null) {
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status}
            `;
            dataRows = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title,
                     status, created_at, notified_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND status = ${status}
              ORDER BY created_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
          } else if (product_id !== null) {
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND product_id = ${product_id}
            `;
            dataRows = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title,
                     status, created_at, notified_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId} AND product_id = ${product_id}
              ORDER BY created_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
          } else {
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
            `;
            dataRows = await ctx.db`
              SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title,
                     status, created_at, notified_at
              FROM back_in_stock_subscriptions
              WHERE tenant_id = ${ctx.tenantId}
              ORDER BY created_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
          }

          const total = parseInt(countRows[0].total, 10);
          const items = dataRows.map(r => ({
            id: String(r.id),
            email: r.email,
            customer_id: r.customer_id ? Number(r.customer_id) : null,
            product_id: Number(r.product_id),
            variant_id: Number(r.variant_id),
            product_title: r.product_title,
            variant_title: r.variant_title || null,
            status: r.status,
            created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
            notified_at: r.notified_at ? (r.notified_at instanceof Date ? r.notified_at.toISOString() : String(r.notified_at)) : null
          }));

          return { items, total, page: Number(page), page_size: Number(page_size) };
        }

        // POST /admin/subscriptions/delete
        if (ctx.adminPath === '/admin/subscriptions/delete') {
          const { id } = ctx.adminBody || {};
          ctx.logger.info({ id }, 'admin: delete subscription');

          await ctx.db`
            DELETE FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
          `;

          return { success: true };
        }

        // POST /admin/subscriptions/update-status
        if (ctx.adminPath === '/admin/subscriptions/update-status') {
          const { id, status } = ctx.adminBody || {};
          ctx.logger.info({ id, status }, 'admin: update subscription status');

          const updated = await ctx.db`
            UPDATE back_in_stock_subscriptions
            SET status = ${status}
            WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
            RETURNING id, status
          `;

          if (updated.length === 0) {
            return { success: false, id: String(id), status };
          }

          return { success: true, id: String(updated[0].id), status: updated[0].status };
        }

        // GET /admin/notification-log
        if (ctx.adminPath === '/admin/notification-log') {
          const { page = 1, page_size = 20, subscription_id = null } = ctx.adminBody || {};
          const offset = (page - 1) * page_size;

          let countRows, dataRows;

          if (subscription_id !== null) {
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM notification_log
              WHERE tenant_id = ${ctx.tenantId} AND subscription_id = ${subscription_id}
            `;
            dataRows = await ctx.db`
              SELECT id, subscription_id, email, variant_id, sent_at
              FROM notification_log
              WHERE tenant_id = ${ctx.tenantId} AND subscription_id = ${subscription_id}
              ORDER BY sent_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
          } else {
            countRows = await ctx.db`
              SELECT COUNT(*) AS total FROM notification_log
              WHERE tenant_id = ${ctx.tenantId}
            `;
            dataRows = await ctx.db`
              SELECT id, subscription_id, email, variant_id, sent_at
              FROM notification_log
              WHERE tenant_id = ${ctx.tenantId}
              ORDER BY sent_at DESC
              LIMIT ${page_size} OFFSET ${offset}
            `;
          }

          const total = parseInt(countRows[0].total, 10);
          const items = dataRows.map(r => ({
            id: String(r.id),
            subscription_id: String(r.subscription_id),
            email: r.email,
            variant_id: Number(r.variant_id),
            sent_at: r.sent_at instanceof Date ? r.sent_at.toISOString() : String(r.sent_at)
          }));

          return { items, total, page: Number(page), page_size: Number(page_size) };
        }

        ctx.logger.warn({ adminPath: ctx.adminPath }, 'admin: unknown path');
        return { error: 'unknown path' };
      }

      // ── WEBHOOK TRIGGER: inventory_levels/update ────────────────────────────
      const { inventory_item_id, location_id, available } = ctx.payload;
      ctx.logger.info({ trigger: ctx.trigger, inventory_item_id, location_id, available }, 'webhook invoke');

      const newStatus = available > 0 ? 'in_stock' : 'out_of_stock';

      // Upsert inventory_level_states to track prior state
      const existingState = await ctx.db`
        SELECT id, stock_status FROM inventory_level_states
        WHERE tenant_id = ${ctx.tenantId}
          AND inventory_item_id = ${inventory_item_id}
          AND location_id = ${location_id}
      `;

      const prevState = existingState.length > 0 ? existingState[0].stock_status : null;

      ctx.logger.info({ prevState, newStatus }, 'state comparison');

      // Update or insert state
      if (existingState.length > 0) {
        await ctx.db`
          UPDATE inventory_level_states
          SET stock_status = ${newStatus}, last_observed_at = NOW()
          WHERE tenant_id = ${ctx.tenantId}
            AND inventory_item_id = ${inventory_item_id}
            AND location_id = ${location_id}
        `;
      } else {
        await ctx.db`
          INSERT INTO inventory_level_states
            (tenant_id, inventory_item_id, location_id, stock_status, last_observed_at)
          VALUES
            (${ctx.tenantId}, ${inventory_item_id}, ${location_id}, ${newStatus}, NOW())
          ON CONFLICT (tenant_id, inventory_item_id, location_id) DO UPDATE
            SET stock_status = ${newStatus}, last_observed_at = NOW()
        `;
      }

      // Only notify if transitioning from out_of_stock → in_stock
      const isBackInStock = prevState !== null && prevState === 'out_of_stock' && newStatus === 'in_stock';

      if (!isBackInStock) {
        ctx.logger.info({ prevState, newStatus }, 'no back-in-stock transition — exiting');
        return;
      }

      ctx.logger.info({ inventory_item_id }, 'back-in-stock transition detected');

      // Resolve variant from inventory_item_id
      const variantData = await ctx.shopify.graphql(
        `query GetVariantByInventoryItem($inventoryItemId: ID!) {
          inventoryItem(id: $inventoryItemId) {
            variant {
              id
              title
              product {
                id
                title
              }
            }
          }
        }`,
        { inventoryItemId: `gid://shopify/InventoryItem/${inventory_item_id}` }
      );

      const variantNode = variantData && variantData.inventoryItem && variantData.inventoryItem.variant;

      if (!variantNode) {
        ctx.logger.warn({ inventory_item_id }, 'could not resolve variant from inventory item');
        return;
      }

      // Extract numeric variant ID from GID
      const variantGid = variantNode.id; // e.g. gid://shopify/ProductVariant/12345
      const variantIdNumeric = parseInt(variantGid.split('/').pop(), 10);
      const variantTitle = variantNode.title;
      const productTitle = variantNode.product ? variantNode.product.title : '';

      ctx.logger.info({ variantIdNumeric, productTitle, variantTitle }, 'resolved variant info');

      // Fetch all active subscriptions for this variant
      const subscriptions = await ctx.db`
        SELECT id, email, customer_id, product_id, variant_id, product_title, variant_title
        FROM back_in_stock_subscriptions
        WHERE tenant_id = ${ctx.tenantId}
          AND variant_id = ${variantIdNumeric}
          AND status = 'active'
          AND notified_at IS NULL
      `;

      if (subscriptions.length === 0) {
        ctx.logger.info({ variantIdNumeric }, 'no active subscriptions for variant');
        return;
      }

      ctx.logger.info({ count: subscriptions.length, variantIdNumeric }, 'found subscriptions to notify');

      // Atomically claim subscriptions for notification
      const subscriptionIds = subscriptions.map(s => s.id);
      const claimed = await ctx.db`
        UPDATE back_in_stock_subscriptions
        SET notified_at = NOW(), status = 'notified'
        WHERE tenant_id = ${ctx.tenantId}
          AND id = ANY(${subscriptionIds})
          AND notified_at IS NULL
          AND status = 'active'
        RETURNING id, email, customer_id, product_id, variant_id, product_title, variant_title
      `;

      if (claimed.length === 0) {
        ctx.logger.info({ variantIdNumeric }, 'all subscriptions already claimed — skipping');
        return;
      }

      ctx.logger.info({ claimedCount: claimed.length }, 'claimed subscriptions for notification');

      // Send emails and log notifications for each claimed subscription
      for (const sub of claimed) {
        try {
          const emailProductTitle = sub.product_title || productTitle;
          const emailVariantTitle = sub.variant_title || variantTitle;

          await ctx.services.email.send({
            to: sub.email,
            subject: `${emailProductTitle} is back in stock!`,
            data: {
              productTitle: emailProductTitle,
              variantTitle: emailVariantTitle,
              email: sub.email
            }
          });

          const logId = uuidv4();
          await ctx.db`
            INSERT INTO notification_log
              (id, tenant_id, subscription_id, email, variant_id, sent_at)
            VALUES
              (${logId}, ${ctx.tenantId}, ${sub.id}, ${sub.email}, ${sub.variant_id}, NOW())
          `;
        } catch (err) {
          ctx.logger.error({ subscriptionId: String(sub.id), email: sub.email, err: err.message }, 'failed to notify subscriber');
        }
      }

      ctx.logger.info({ notified: claimed.length }, 'back-in-stock notifications dispatched');

    } catch (err) {
      ctx.logger.error({ err: err.message, stack: err.stack }, 'handler error');
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
  status         TEXT        NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at    TIMESTAMPTZ NULL,
  UNIQUE (tenant_id, email, variant_id)
);

ALTER TABLE back_in_stock_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY back_in_stock_subscriptions_tenant_isolation ON back_in_stock_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX back_in_stock_subscriptions_tenant_id_idx   ON back_in_stock_subscriptions (tenant_id);
CREATE INDEX back_in_stock_subscriptions_variant_id_idx  ON back_in_stock_subscriptions (tenant_id, variant_id);
CREATE INDEX back_in_stock_subscriptions_status_idx      ON back_in_stock_subscriptions (tenant_id, status);

CREATE TABLE inventory_level_states (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL,
  inventory_item_id  BIGINT      NOT NULL,
  location_id        BIGINT      NOT NULL,
  stock_status       TEXT        NULL,
  last_observed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, inventory_item_id, location_id)
);

ALTER TABLE inventory_level_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_level_states_tenant_isolation ON inventory_level_states
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX inventory_level_states_tenant_id_idx          ON inventory_level_states (tenant_id);
CREATE INDEX inventory_level_states_inventory_item_id_idx  ON inventory_level_states (tenant_id, inventory_item_id);

CREATE TABLE notification_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  subscription_id  UUID        NOT NULL REFERENCES back_in_stock_subscriptions(id) ON DELETE CASCADE,
  email            TEXT        NOT NULL,
  variant_id       BIGINT      NOT NULL,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  const { shop, customerId } = host.context;

  const styles = `
    :host, .bns-widget * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .bns-widget { max-width: 480px; }
    .bns-form { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
    .bns-label { font-size: 13px; font-weight: 500; color: #444; margin-bottom: 2px; display: block; }
    .bns-input { width: 100%; padding: 9px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; outline: none; transition: border-color 0.2s; }
    .bns-input:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,0.1); }
    .bns-btn { padding: 10px 18px; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.2s, opacity 0.2s; }
    .bns-btn-primary { background: #4f46e5; color: #fff; }
    .bns-btn-primary:hover { background: #4338ca; }
    .bns-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
    .bns-btn-cancel { background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; }
    .bns-btn-cancel:hover { background: #e5e7eb; }
    .bns-alert { padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-top: 8px; }
    .bns-alert-success { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; }
    .bns-alert-error { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
    .bns-alert-info { background: #e0e7ff; color: #3730a3; border: 1px solid #a5b4fc; }
    .bns-heading { font-size: 15px; font-weight: 700; color: #111; margin: 0 0 4px 0; }
    .bns-sub { font-size: 13px; color: #6b7280; margin: 0; }
    .bns-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.4); border-top-color: #fff; border-radius: 50%; animation: bns-spin 0.7s linear infinite; vertical-align: middle; margin-right: 6px; }
    @keyframes bns-spin { to { transform: rotate(360deg); } }
    .bns-row { display: flex; gap: 8px; align-items: center; }
    .bns-badge-oos { display: inline-block; background: #fee2e2; color: #991b1b; border-radius: 4px; font-size: 11px; font-weight: 600; padding: 2px 7px; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = styles;
  container.appendChild(styleEl);

  const root = document.createElement('div');
  root.className = 'bns-widget';
  container.appendChild(root);

  let productData = null;
  let variantData = null;
  let currentVariantId = null;
  let isSubscribed = false;
  let userEmail = '';

  function render(state) {
    root.innerHTML = '';

    if (state.loading) {
      root.innerHTML = '<p style="font-size:13px;color:#6b7280;">Loading…</p>';
      return;
    }

    if (state.error) {
      const el = document.createElement('div');
      el.className = 'bns-alert bns-alert-error';
      el.textContent = state.error;
      root.appendChild(el);
      return;
    }

    if (!state.outOfStock) {
      return;
    }

    const heading = document.createElement('p');
    heading.className = 'bns-heading';
    heading.textContent = 'Notify Me When Available';
    root.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'bns-row';
    row.style.marginBottom = '4px';
    const badge = document.createElement('span');
    badge.className = 'bns-badge-oos';
    badge.textContent = 'Out of Stock';
    row.appendChild(badge);
    if (variantData && variantData.title && variantData.title !== 'Default Title') {
      const vtitle = document.createElement('span');
      vtitle.style.cssText = 'font-size:13px;color:#6b7280;';
      vtitle.textContent = variantData.title;
      row.appendChild(vtitle);
    }
    root.appendChild(row);

    if (state.subscribed) {
      const info = document.createElement('div');
      info.className = 'bns-alert bns-alert-info';
      info.innerHTML = `You're subscribed for restock notifications. <br><small style="opacity:0.8">Email: ${escHtml(state.subscribedEmail || '')}</small>`;
      root.appendChild(info);

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'bns-btn bns-btn-cancel';
      cancelBtn.textContent = 'Cancel Subscription';
      cancelBtn.style.marginTop = '8px';
      cancelBtn.addEventListener('click', () => handleCancel(state.subscribedEmail));
      root.appendChild(cancelBtn);
      return;
    }

    if (state.success) {
      const el = document.createElement('div');
      el.className = 'bns-alert bns-alert-success';
      el.textContent = state.message || "You're on the list! We'll notify you when this is back in stock.";
      root.appendChild(el);
      return;
    }

    const sub = document.createElement('p');
    sub.className = 'bns-sub';
    sub.textContent = "Enter your email and we'll notify you when this item is back in stock.";
    root.appendChild(sub);

    const form = document.createElement('form');
    form.className = 'bns-form';

    const emailLabel = document.createElement('label');
    emailLabel.className = 'bns-label';
    emailLabel.textContent = 'Email address';
    emailLabel.setAttribute('for', 'bns-email');

    const emailInput = document.createElement('input');
    emailInput.className = 'bns-input';
    emailInput.type = 'email';
    emailInput.id = 'bns-email';
    emailInput.name = 'email';
    emailInput.placeholder = 'you@example.com';
    emailInput.required = true;
    emailInput.value = userEmail;

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'bns-btn bns-btn-primary';
    submitBtn.textContent = 'Notify Me';

    if (state.submitting) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="bns-spinner"></span>Subscribing…';
    }

    form.appendChild(emailLabel);
    form.appendChild(emailInput);

    if (state.formError) {
      const ferr = document.createElement('div');
      ferr.className = 'bns-alert bns-alert-error';
      ferr.textContent = state.formError;
      form.appendChild(ferr);
    }

    form.appendChild(submitBtn);
    root.appendChild(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = host.getFormData(form);
      userEmail = data.email || '';
      await handleSubscribe(data.email);
    });
  }

  function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function handleSubscribe(email) {
    if (!email || !currentVariantId || !productData || !variantData) return;

    render({ outOfStock: true, submitting: true });

    try {
      const result = await host.call('/subscribe', {
        email: email,
        product_id: productData.id,
        variant_id: variantData.id,
        product_title: productData.title,
        variant_title: variantData.title !== 'Default Title' ? variantData.title : null,
        customer_id: customerId ? Number(customerId) : null,
      });

      if (result && result.success) {
        isSubscribed = true;
        render({ outOfStock: true, success: true, message: result.message });
      } else {
        render({ outOfStock: true, formError: (result && result.message) || 'Subscription failed. Please try again.' });
      }
    } catch (err) {
      render({ outOfStock: true, formError: 'Something went wrong. Please try again.' });
    }
  }

  async function handleCancel(email) {
    if (!email || !currentVariantId) return;
    render({ outOfStock: true, loading: true });

    try {
      const result = await host.call('/subscribe/cancel', {
        email: email,
        variant_id: variantData.id,
      });

      if (result && result.success) {
        isSubscribed = false;
        render({ outOfStock: true, subscribed: false });
      } else {
        render({ outOfStock: true, subscribed: true, subscribedEmail: email, error: 'Could not cancel. Please try again.' });
      }
    } catch (err) {
      render({ outOfStock: true, subscribed: true, subscribedEmail: email });
    }
  }

  async function checkSubscription(email, variantId) {
    if (!email) return false;
    try {
      const result = await host.call('/subscribe/check', { email, variant_id: variantId });
      return result && result.subscribed;
    } catch {
      return false;
    }
  }

  async function init() {
    render({ loading: true });

    const pathname = location.pathname;
    const search = location.search;

    const productMatch = pathname.match(/\/products\/([^/?#]+)/);
    if (!productMatch) {
      render({});
      return;
    }

    const handle = productMatch[1];

    try {
      const product = await host.storefront('/products/' + handle + '.js');
      productData = product;

      const params = new URLSearchParams(search);
      const variantParam = params.get('variant');

      let variant = null;
      if (variantParam) {
        variant = product.variants.find(v => String(v.id) === String(variantParam));
      }
      if (!variant) {
        variant = product.variants[0];
      }

      variantData = variant;
      currentVariantId = variant.id;

      const outOfStock = !variant.available;

      if (!outOfStock) {
        render({ outOfStock: false });
        return;
      }

      let subscribedEmail = null;
      let alreadySubscribed = false;

      if (customerId) {
        try {
          const cart = await host.storefront('/cart.js');
          if (cart && cart.email) {
            userEmail = cart.email;
            const subCheck = await checkSubscription(cart.email, variant.id);
            if (subCheck) {
              alreadySubscribed = true;
              subscribedEmail = cart.email;
            }
          }
        } catch {}
      }

      if (alreadySubscribed) {
        render({ outOfStock: true, subscribed: true, subscribedEmail });
      } else {
        render({ outOfStock: true });
      }

    } catch (err) {
      render({ error: 'Could not load product information.' });
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
    .tabs { display: flex; gap: var(--p-space-200); margin-bottom: var(--p-space-400); border-bottom: 1px solid var(--p-color-border); }
    .tab-btn { background: none; border: none; border-bottom: 2px solid transparent; padding: var(--p-space-200) var(--p-space-400); font-size: var(--p-font-size-350); font-weight: var(--p-font-weight-medium); color: var(--p-color-text-secondary); cursor: pointer; margin-bottom: -1px; }
    .tab-btn.active { color: var(--p-color-text); border-bottom-color: #008060; }
    .tab-btn:hover:not(.active) { color: var(--p-color-text); }
    .filter-row { display: flex; gap: var(--p-space-300); align-items: center; flex-wrap: wrap; margin-bottom: var(--p-space-400); }
    .filter-row select, .filter-row input { padding: var(--p-space-200) var(--p-space-300); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-100); background: var(--p-color-bg-surface); color: var(--p-color-text); font-size: var(--p-font-size-350); }
    .filter-row select:focus, .filter-row input:focus { outline: 2px solid #008060; outline-offset: 1px; }
    .row-actions { display: flex; gap: var(--p-space-200); }
    .btn-sm { padding: var(--p-space-100) var(--p-space-200); font-size: var(--p-font-size-300); }
    .stat-meta { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-top: var(--p-space-100); }
    .section-gap { margin-bottom: var(--p-space-600); }
    .info-banner { background: var(--p-color-bg-surface-secondary); border: 1px solid var(--p-color-border); border-radius: var(--p-border-radius-200); padding: var(--p-space-300) var(--p-space-400); font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); margin-bottom: var(--p-space-400); }
    .info-banner strong { color: var(--p-color-text); }
    .truncate { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .log-email { font-family: monospace; font-size: var(--p-font-size-300); }
    .confirm-status { font-size: var(--p-font-size-300); color: var(--p-color-text-secondary); }
  `;

  container.innerHTML = `
    <div class="shell-root">
      <div class="shell-header">
        <span class="shell-title">Back-in-Stock Subscriptions</span>
        <button class="btn-secondary" id="refresh-btn">Refresh</button>
      </div>

      <div class="shell-stats-row" id="stats-row">
        <div class="shell-stat-card">
          <div class="shell-stat-label">Total Subscriptions</div>
          <div class="shell-stat-value" id="stat-total">—</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Active</div>
          <div class="shell-stat-value" id="stat-active">—</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Notified</div>
          <div class="shell-stat-value" id="stat-notified">—</div>
        </div>
        <div class="shell-stat-card">
          <div class="shell-stat-label">Cancelled</div>
          <div class="shell-stat-value" id="stat-cancelled">—</div>
        </div>
      </div>

      <div class="tabs">
        <button class="tab-btn active" data-tab="subscriptions">Subscriptions</button>
        <button class="tab-btn" data-tab="notifications">Notification Log</button>
      </div>

      <div id="tab-subscriptions">
        <div class="info-banner">
          <strong>How it works:</strong> Customers subscribe to out-of-stock products. When inventory is updated via webhook, the system derives stock status and sends individual transactional emails to each matching subscriber.
        </div>
        <div class="filter-row">
          <select id="filter-status">
            <option value="">All Statuses</option>
            <option value="active">Active</option>
            <option value="notified">Notified</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <input type="number" id="filter-product" placeholder="Filter by Product ID" style="width:180px" />
          <button class="btn-secondary btn-sm" id="apply-filter-btn">Apply</button>
          <button class="btn-secondary btn-sm" id="clear-filter-btn">Clear</button>
        </div>
        <div id="subs-loading" class="shell-loading" style="display:none"><div class="shell-spinner"></div></div>
        <div id="subs-error" class="shell-error-banner" style="display:none"></div>
        <div id="subs-empty" class="shell-empty" style="display:none">No subscriptions found.</div>
        <div class="shell-table-wrap" id="subs-table-wrap" style="display:none">
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
            <tbody id="subs-tbody"></tbody>
          </table>
        </div>
        <div class="shell-pagination" id="subs-pagination" style="display:none">
          <span id="subs-page-info" style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary)"></span>
          <div class="shell-pagination-btns">
            <button class="btn-secondary btn-sm" id="subs-prev-btn">Previous</button>
            <button class="btn-secondary btn-sm" id="subs-next-btn">Next</button>
          </div>
        </div>
      </div>

      <div id="tab-notifications" style="display:none">
        <div class="info-banner">
          <strong>Note:</strong> Shopify does not provide a batch notification API. Each subscriber receives an individual transactional email. This log shows all sent notifications.
        </div>
        <div id="log-loading" class="shell-loading" style="display:none"><div class="shell-spinner"></div></div>
        <div id="log-error" class="shell-error-banner" style="display:none"></div>
        <div id="log-empty" class="shell-empty" style="display:none">No notifications sent yet.</div>
        <div class="shell-table-wrap" id="log-table-wrap" style="display:none">
          <table class="shell-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Variant ID</th>
                <th>Subscription ID</th>
                <th>Sent At</th>
              </tr>
            </thead>
            <tbody id="log-tbody"></tbody>
          </table>
        </div>
        <div class="shell-pagination" id="log-pagination" style="display:none">
          <span id="log-page-info" style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary)"></span>
          <div class="shell-pagination-btns">
            <button class="btn-secondary btn-sm" id="log-prev-btn">Previous</button>
            <button class="btn-secondary btn-sm" id="log-next-btn">Next</button>
          </div>
        </div>
      </div>

      <div class="shell-confirm-overlay" id="confirm-overlay" style="display:none">
        <div class="shell-confirm-dialog">
          <div class="shell-confirm-title" id="confirm-title"></div>
          <div class="shell-confirm-body" id="confirm-body"></div>
          <div class="shell-confirm-actions">
            <button class="btn-secondary" id="confirm-cancel-btn">Cancel</button>
            <button class="btn-danger" id="confirm-ok-btn">Confirm</button>
          </div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(style);

  const PAGE_SIZE = 25;

  const state = {
    currentTab: 'subscriptions',
    subs: { page: 1, total: 0, items: [], status: '', productId: null },
    log: { page: 1, total: 0, items: [] },
    stats: { total: 0, active: 0, notified: 0, cancelled: 0 },
    confirmCallback: null
  };

  function $(id) { return container.querySelector('#' + id); }

  function formatDate(str) {
    if (!str) return '—';
    try {
      return new Date(str).toLocaleString();
    } catch (e) {
      return str;
    }
  }

  function statusBadge(status) {
    const map = {
      active: 'badge-success',
      notified: 'badge-warning',
      cancelled: 'badge-neutral'
    };
    const cls = map[status] || 'badge-neutral';
    return `<span class="badge ${cls}">${status}</span>`;
  }

  function showConfirm(title, body, okLabel, okClass, callback) {
    $('confirm-title').textContent = title;
    $('confirm-body').innerHTML = body;
    $('confirm-ok-btn').textContent = okLabel;
    $('confirm-ok-btn').className = 'btn-' + okClass;
    state.confirmCallback = callback;
    $('confirm-overlay').style.display = 'flex';
  }

  function hideConfirm() {
    $('confirm-overlay').style.display = 'none';
    state.confirmCallback = null;
  }

  $('confirm-cancel-btn').addEventListener('click', hideConfirm);
  $('confirm-ok-btn').addEventListener('click', () => {
    if (state.confirmCallback) state.confirmCallback();
    hideConfirm();
  });

  async function loadStats() {
    try {
      const [allRes, activeRes, notifiedRes, cancelledRes] = await Promise.all([
        bridge.call('/admin/subscriptions', { page: 1, page_size: 1, status: null, product_id: null }),
        bridge.call('/admin/subscriptions', { page: 1, page_size: 1, status: 'active', product_id: null }),
        bridge.call('/admin/subscriptions', { page: 1, page_size: 1, status: 'notified', product_id: null }),
        bridge.call('/admin/subscriptions', { page: 1, page_size: 1, status: 'cancelled', product_id: null })
      ]);
      $('stat-total').textContent = allRes.total;
      $('stat-active').textContent = activeRes.total;
      $('stat-notified').textContent = notifiedRes.total;
      $('stat-cancelled').textContent = cancelledRes.total;
    } catch (e) {
      // stats failure is non-critical
    }
  }

  async function loadSubscriptions() {
    const loadingEl = $('subs-loading');
    const errorEl = $('subs-error');
    const emptyEl = $('subs-empty');
    const tableWrap = $('subs-table-wrap');
    const pagination = $('subs-pagination');

    loadingEl.style.display = 'flex';
    errorEl.style.display = 'none';
    emptyEl.style.display = 'none';
    tableWrap.style.display = 'none';
    pagination.style.display = 'none';

    try {
      const res = await bridge.call('/admin/subscriptions', {
        page: state.subs.page,
        page_size: PAGE_SIZE,
        status: state.subs.status || null,
        product_id: state.subs.productId || null
      });

      state.subs.total = res.total;
      state.subs.items = res.items;

      loadingEl.style.display = 'none';

      if (!res.items || res.items.length === 0) {
        emptyEl.style.display = 'block';
        return;
      }

      renderSubsTable(res.items);
      tableWrap.style.display = '';

      const totalPages = Math.ceil(res.total / PAGE_SIZE);
      if (totalPages > 1) {
        const start = (state.subs.page - 1) * PAGE_SIZE + 1;
        const end = Math.min(state.subs.page * PAGE_SIZE, res.total);
        $('subs-page-info').textContent = `Showing ${start}–${end} of ${res.total}`;
        $('subs-prev-btn').disabled = state.subs.page <= 1;
        $('subs-next-btn').disabled = state.subs.page >= totalPages;
        pagination.style.display = 'flex';
      }
    } catch (e) {
      loadingEl.style.display = 'none';
      errorEl.style.display = 'block';
      errorEl.textContent = 'Failed to load subscriptions: ' + (e.message || 'Unknown error');
    }
  }

  function renderSubsTable(items) {
    const tbody = $('subs-tbody');
    tbody.innerHTML = '';
    items.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="truncate" title="${item.email}">${item.email}</span></td>
        <td><span class="truncate" title="${item.product_title || item.product_id}">${item.product_title || item.product_id}</span></td>
        <td>${item.variant_title || item.variant_id}</td>
        <td>${statusBadge(item.status)}</td>
        <td style="font-size:var(--p-font-size-300)">${formatDate(item.created_at)}</td>
        <td style="font-size:var(--p-font-size-300)">${formatDate(item.notified_at)}</td>
        <td>
          <div class="row-actions">
            ${item.status !== 'active' ? `<button class="btn-secondary btn-sm" data-action="activate" data-id="${item.id}">Activate</button>` : ''}
            ${item.status !== 'cancelled' ? `<button class="btn-secondary btn-sm" data-action="cancel" data-id="${item.id}">Cancel</button>` : ''}
            <button class="btn-danger btn-sm" data-action="delete" data-id="${item.id}">Delete</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.addEventListener('click', handleSubsAction);
  }

  function handleSubsAction(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const item = state.subs.items.find(i => i.id === id);
    if (!item) return;

    if (action === 'delete') {
      showConfirm(
        'Delete Subscription',
        `Delete subscription for <strong>${item.email}</strong> on <strong>${item.product_title || 'Product ' + item.product_id}</strong>? This cannot be undone.`,
        'Delete',
        'danger',
        async () => {
          try {
            const res = await bridge.call('/admin/subscriptions/delete', { id });
            if (res.success) {
              bridge.notify('Subscription deleted', 'success');
              loadSubscriptions();
              loadStats();
            } else {
              bridge.notify('Failed to delete subscription', 'error');
            }
          } catch (err) {
            bridge.notify('Error: ' + (err.message || 'Unknown error'), 'error');
          }
        }
      );
    } else if (action === 'activate') {
      showConfirm(
        'Activate Subscription',
        `Re-activate subscription for <strong>${item.email}</strong>?`,
        'Activate',
        'primary',
        async () => {
          try {
            const res = await bridge.call('/admin/subscriptions/update-status', { id, status: 'active' });
            if (res.success) {
              bridge.notify('Subscription activated', 'success');
              loadSubscriptions();
              loadStats();
            } else {
              bridge.notify('Failed to update subscription', 'error');
            }
          } catch (err) {
            bridge.notify('Error: ' + (err.message || 'Unknown error'), 'error');
          }
        }
      );
    } else if (action === 'cancel') {
      showConfirm(
        'Cancel Subscription',
        `Cancel subscription for <strong>${item.email}</strong> on <strong>${item.product_title || 'Product ' + item.product_id}</strong>?`,
        'Cancel Subscription',
        'danger',
        async () => {
          try {
            const res = await bridge.call('/admin/subscriptions/update-status', { id, status: 'cancelled' });
            if (res.success) {
              bridge.notify('Subscription cancelled', 'success');
              loadSubscriptions();
              loadStats();
            } else {
              bridge.notify('Failed to cancel subscription', 'error');
            }
          } catch (err) {
            bridge.notify('Error: ' + (err.message || 'Unknown error'), 'error');
          }
        }
      );
    }
  }

  async function loadNotificationLog() {
    const loadingEl = $('log-loading');
    const errorEl = $('log-error');
    const emptyEl = $('log-empty');
    const tableWrap = $('log-table-wrap');
    const pagination = $('log-pagination');

    loadingEl.style.display = 'flex';
    errorEl.style.display = 'none';
    emptyEl.style.display = 'none';
    tableWrap.style.display = 'none';
    pagination.style.display = 'none';

    try {
      const res = await bridge.call('/admin/notification-log', {
        page: state.log.page,
        page_size: PAGE_SIZE,
        subscription_id: null
      });

      state.log.total = res.total;
      state.log.items = res.items;

      loadingEl.style.display = 'none';

      if (!res.items || res.items.length === 0) {
        emptyEl.style.display = 'block';
        return;
      }

      renderLogTable(res.items);
      tableWrap.style.display = '';

      const totalPages = Math.ceil(res.total / PAGE_SIZE);
      if (totalPages > 1) {
        const start = (state.log.page - 1) * PAGE_SIZE + 1;
        const end = Math.min(state.log.page * PAGE_SIZE, res.total);
        $('log-page-info').textContent = `Showing ${start}–${end} of ${res.total}`;
        $('log-prev-btn').disabled = state.log.page <= 1;
        $('log-next-btn').disabled = state.log.page >= totalPages;
        pagination.style.display = 'flex';
      }
    } catch (e) {
      loadingEl.style.display = 'none';
      errorEl.style.display = 'block';
      errorEl.textContent = 'Failed to load notification log: ' + (e.message || 'Unknown error');
    }
  }

  function renderLogTable(items) {
    const tbody = $('log-tbody');
    tbody.innerHTML = '';
    items.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="log-email truncate" title="${item.email}">${item.email}</span></td>
        <td>${item.variant_id}</td>
        <td><span style="font-size:var(--p-font-size-300);color:var(--p-color-text-secondary)">${item.subscription_id}</span></td>
        <td style="font-size:var(--p-font-size-300)">${formatDate(item.sent_at)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Tab switching
  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      state.currentTab = tab;
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $('tab-subscriptions').style.display = tab === 'subscriptions' ? '' : 'none';
      $('tab-notifications').style.display = tab === 'notifications' ? '' : 'none';
      if (tab === 'notifications' && state.log.items.length === 0) {
        loadNotificationLog();
      }
    });
  });

  // Filters
  $('apply-filter-btn').addEventListener('click', () => {
    state.subs.page = 1;
    state.subs.status = $('filter-status').value;
    const pid = parseInt($('filter-product').value, 10);
    state.subs.productId = isNaN(pid) ? null : pid;
    loadSubscriptions();
  });

  $('clear-filter-btn').addEventListener('click', () => {
    $('filter-status').value = '';
    $('filter-product').value = '';
    state.subs.page = 1;
    state.subs.status = '';
    state.subs.productId = null;
    loadSubscriptions();
  });

  // Pagination - Subscriptions
  $('subs-prev-btn').addEventListener('click', () => {
    if (state.subs.page > 1) {
      state.subs.page--;
      loadSubscriptions();
    }
  });
  $('subs-next-btn').addEventListener('click', () => {
    const totalPages = Math.ceil(state.subs.total / PAGE_SIZE);
    if (state.subs.page < totalPages) {
      state.subs.page++;
      loadSubscriptions();
    }
  });

  // Pagination - Log
  $('log-prev-btn').addEventListener('click', () => {
    if (state.log.page > 1) {
      state.log.page--;
      loadNotificationLog();
    }
  });
  $('log-next-btn').addEventListener('click', () => {
    const totalPages = Math.ceil(state.log.total / PAGE_SIZE);
    if (state.log.page < totalPages) {
      state.log.page++;
      loadNotificationLog();
    }
  });

  // Refresh
  $('refresh-btn').addEventListener('click', () => {
    loadStats();
    if (state.currentTab === 'subscriptions') {
      loadSubscriptions();
    } else {
      loadNotificationLog();
    }
  });

  // Initial load
  loadStats();
  loadSubscriptions();
}
```

