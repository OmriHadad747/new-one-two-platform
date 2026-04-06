# Feature Generator — Run Result

**Date:** 2026-04-03 23:37:25  
**Status:** ✅ SUCCESS  
**Total:** 208911ms  
**Prompt:** Develop a Notify Me When Back In Stock Shopify app.

## Pipeline

| Agent       | Status | Time       | Notes |
|-------------|--------|------------|-------|
| Product     | ✓      | 3180ms     | archetype=?  trigger=? |
| Architect   | ✓      | 23178ms    | complexity=high  topics=['inventory_levels/update']  cron=—  stateMachine=yes |
| CodeSpec    | ✓      | 45748ms    | webhook=47 steps  cron=0 steps  widget=34 steps  functions=1 |
| CodeGen     | ✓      | 56143ms    | attempt 2  handler ✓  migration ✓  widget_js ✓  admin_ui ✓ |
| Explanation | ✓      | 8247ms     |  |

## Product Spec

```json
{
  "triggerTypes": [
    "webhook",
    "widget"
  ],
  "resources": [
    "inventory",
    "products",
    "customers"
  ],
  "desiredOutcome": "Customers can subscribe to out-of-stock products and automatically receive an email notification when the product is restocked.",
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
    "cronSchedule": null,
    "operations": [
      {
        "step": 1,
        "description": "Webhook handler: fetch inventory item to resolve variant_id from inventory_item_id",
        "protocol": "rest",
        "method": "GET",
        "path": "/admin/api/2026-01/inventory_items/{inventory_item_id}.json",
        "bodyExample": null
      },
      {
        "step": 2,
        "description": "Webhook handler: fetch variant to resolve product_id and get variant title/option details for notification email",
        "protocol": "rest",
        "method": "GET",
        "path": "/admin/api/2026-01/variants/{variant_id}.json",
        "bodyExample": null
      },
      {
        "step": 3,
        "description": "Webhook handler: fetch product to get title and image for notification email",
        "protocol": "rest",
        "method": "GET",
        "path": "/admin/api/2026-01/products/{product_id}.json",
        "bodyExample": null
      },
      {
        "step": 4,
        "description": "Widget /signup handler: fetch variant to resolve inventory_item_id server-side before inserting subscription",
        "protocol": "rest",
        "method": "GET",
        "path": "/admin/api/2026-01/variants/{variant_id}.json",
        "bodyExample": null
      },
      {
        "step": 5,
        "description": "Admin /subscribers handler: no Shopify call needed \u2014 read subscription rows from DB",
        "protocol": "rest",
        "method": "GET",
        "path": "/admin/api/2026-01/products.json?ids={comma_separated_product_ids}",
        "bodyExample": null
      }
    ]
  },
  "implementationSpec": {
    "complexity": "high",
    "stateMachine": {
      "needsStateTracking": true,
      "trackedEntity": "inventory_level column `previous_quantity` (INTEGER, nullable) on the `back_in_stock_subscriptions` table tracks last observed inventory quantity per variant_id",
      "unknownSentinel": "null",
      "skipWhenUnknown": true,
      "skipRationale": "Without a previously observed quantity we cannot confirm the item was out-of-stock before the update, so we must skip to avoid false-positive notifications on first webhook receipt."
    },
    "platformGaps": [],
    "cronBatching": null,
    "migrationGuidance": "Create table `back_in_stock_subscriptions` with columns: id UUID PK, tenant_id UUID NOT NULL, variant_id BIGINT NOT NULL, product_id BIGINT NOT NULL, inventory_item_id BIGINT NOT NULL, customer_id BIGINT (nullable \u2014 guest visitors have no customer ID), customer_email TEXT NOT NULL, notified_at TIMESTAMPTZ (nullable \u2014 null means not yet notified), created_at TIMESTAMPTZ NOT NULL DEFAULT now(). Add CONSTRAINT uq_bisubs_tenant_variant_email UNIQUE (tenant_id, variant_id, customer_email) to enable ON CONFLICT DO NOTHING inserts. Index on (tenant_id, variant_id, notified_at) for fast fan-out queries on restock. Separately, create table `back_in_stock_inventory_state` with columns: tenant_id UUID NOT NULL, inventory_item_id BIGINT NOT NULL, previous_quantity INTEGER (nullable \u2014 null = never observed), updated_at TIMESTAMPTZ; CONSTRAINT uq_bis_invstate_tenant_item UNIQUE (tenant_id, inventory_item_id). State column MUST be NULLABLE (null = never observed). All Shopify entity ID columns use BIGINT, never UUID.",
    "widgetGuidance": "Display the 'Notify Me' form only when the selected variant is out of stock (available === false from storefront JS); after submission show a static confirmation message ('You'll be notified when this is back in stock') rather than implying the email was sent immediately.",
    "storefrontReads": [
      {
        "path": "/variants/${variantId}.js",
        "dataUsed": "variant.available (boolean) \u2014 widget reads this to decide whether to show the Notify Me form; variantId is resolved from location.search (?variant=)"
      }
    ],
    "widgetApiCatalog": [
      {
        "method": "POST",
        "path": "/signup",
        "responseShape": {
          "success": true,
          "alreadySubscribed": false
        }
      },
      {
        "method": "GET",
        "path": "/status",
        "responseShape": {
          "alreadySubscribed": false
        }
      }
    ],
    "adminApiCatalog": [
      {
        "method": "GET",
        "path": "/subscribers",
        "responseShape": {
          "total": 0,
          "rows": [
            {
              "id": "uuid",
              "variantId": 0,
              "productId": 0,
              "productTitle": "",
              "variantTitle": "",
              "customerEmail": "",
              "customerId": 0,
              "notifiedAt": null,
              "createdAt": ""
            }
          ]
        }
      },
      {
        "method": "GET",
        "path": "/config/get",
        "responseShape": {
          "emailSubject": "",
          "emailBodyTemplate": ""
        }
      },
      {
        "method": "POST",
        "path": "/config/save",
        "responseShape": {
          "success": true
        }
      }
    ]
  }
}
```

## CodeSpec

```json
{
  "codeSpec": {
    "webhookPath": [
      "// ENTRY: inventory_levels/update webhook fires with payload { inventory_item_id, available, location_id, ... }",
      "const { inventory_item_id, available } = ctx.payload",
      "if (!ctx.payload.inventory_item_id): return  // required field missing",
      "// PHASE 1: Upsert inventory state (establish baseline unconditionally)",
      "stateRows = SELECT previous_quantity FROM back_in_stock_inventory_state WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventory_item_id}",
      "if stateRows.length === 0: previousQuantity = null  // never observed",
      "if stateRows.length > 0: previousQuantity = stateRows[0].previous_quantity",
      "// Upsert the new observed quantity BEFORE any early-exit logic",
      "UPSERT INTO back_in_stock_inventory_state (tenant_id, inventory_item_id, previous_quantity, updated_at) VALUES (${ctx.tenantId}, ${inventory_item_id}, ${available}, NOW()) ON CONFLICT ON CONSTRAINT uq_bis_invstate_tenant_item DO UPDATE SET previous_quantity = ${available}, updated_at = NOW()",
      "// PHASE 2: Transition guard \u2014 skip if no prior observation",
      "if previousQuantity === null: return  // sentinel \u2014 cannot confirm transition without prior observation",
      "// PHASE 3: Check if this is a restock transition (was 0, now > 0)",
      "if previousQuantity > 0: return  // was already in stock \u2014 not a restock event",
      "if available <= 0: return  // still out of stock \u2014 nothing to notify",
      "// PHASE 4: Resolve variant_id from inventory_item_id via Shopify Admin API",
      "inventoryItemResponse = ctx.shopify.get('/admin/api/2026-01/inventory_items/' + inventory_item_id + '.json')",
      "if !inventoryItemResponse.inventory_item: return  // entity not found or deleted",
      "const variant_id = inventoryItemResponse.inventory_item.variant_id",
      "if !variant_id: return  // required field missing",
      "// PHASE 5: Resolve product_id and variant details via Shopify Admin API",
      "variantResponse = ctx.shopify.get('/admin/api/2026-01/variants/' + variant_id + '.json')",
      "if !variantResponse.variant: return  // entity not found or deleted",
      "const product_id = variantResponse.variant.product_id",
      "const variantTitle = variantResponse.variant.title",
      "if !product_id: return  // required field missing",
      "// PHASE 6: Resolve product details (title, handle, image) for notification email",
      "productResponse = ctx.shopify.get('/admin/api/2026-01/products/' + product_id + '.json')",
      "if !productResponse.product: return  // entity not found or deleted",
      "const productTitle = productResponse.product.title",
      "const productHandle = productResponse.product.handle",
      "const productImageSrc = productResponse.product.image ? productResponse.product.image.src : null",
      "// PHASE 7: Find all unnotified subscribers for this variant scoped to this tenant",
      "subscriberRows = SELECT id, customer_email, customer_id, variant_id, product_id FROM back_in_stock_subscriptions WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variant_id} AND notified_at IS NULL",
      "if subscriberRows.length === 0: return  // no subscribers waiting \u2014 nothing to notify",
      "// PHASE 8: Claim notifications atomically before emitting",
      "// crash here leaves state updated but notifications unsent \u2014 cron path is the backstop",
      "claimed = UPDATE back_in_stock_subscriptions SET notified_at = NOW() WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variant_id} AND notified_at IS NULL RETURNING id, customer_email, customer_id",
      "if claimed.length === 0: return  // already notified by concurrent process \u2014 idempotency guard",
      "// PHASE 9: Read email config for this tenant",
      "configRows = SELECT email_subject, email_body_template FROM back_in_stock_config WHERE tenant_id = ${ctx.tenantId}",
      "const emailSubject = configRows.length > 0 ? configRows[0].email_subject : 'Good news! {{productTitle}} is back in stock'",
      "const emailBodyTemplate = configRows.length > 0 ? configRows[0].email_body_template : 'Hi, {{productTitle}} ({{variantTitle}}) is back in stock. Visit the store to purchase it.'",
      "// PHASE 10: Emit notification email for each claimed subscriber",
      "for each row in claimed:",
      "  resolvedSubject = interpolate(emailSubject, { productTitle, variantTitle })",
      "  resolvedBody = interpolate(emailBodyTemplate, { productTitle, variantTitle })",
      "  ctx.email.send({ to: row.customer_email, subject: resolvedSubject, body: resolvedBody, data: { productHandle, variantId: variant_id } })"
    ],
    "cronPath": [],
    "widgetPath": [
      "// \u2500\u2500 STOREFRONT READ (no backend call needed) \u2500\u2500",
      "path /status (storefront pre-check): widget: variantId = new URLSearchParams(location.search).get('variant')",
      "path /status (storefront pre-check): widget calls host.storefront('/variants/' + variantId + '.js') \u2192 variantData",
      "path /status (storefront pre-check): widget: isOutOfStock = variantData.available === false",
      "path /status (storefront pre-check): widget: if isOutOfStock is false, hide the Notify Me form entirely and stop",
      "path /status (storefront pre-check): widget: productId = String(variantData.product_id)",
      "// \u2500\u2500 path /status \u2500\u2500 check if already subscribed (backend call needed for DB lookup)",
      "path /status: widget: customerId = host.context().customerId  // null for guests",
      "path /status: widget calls host.call('/status', { variantId, customerId })",
      "path /status: handler: const { variantId, customerId } = ctx.widgetBody",
      "path /status: handler: if !variantId: return { alreadySubscribed: false }  // required field missing",
      "path /status: handler: if customerId is null: return { alreadySubscribed: false }  // guest \u2014 cannot pre-identify",
      "path /status: handler: statusRows = SELECT id FROM back_in_stock_subscriptions WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variantId} AND customer_id = ${customerId} LIMIT 1",
      "path /status: handler: alreadySubscribed = statusRows.length > 0",
      "path /status: handler returns { alreadySubscribed: bool }; widget reads result.alreadySubscribed \u2014 if true, show 'You are already subscribed' message and hide form",
      "// \u2500\u2500 path /signup \u2500\u2500",
      "path /signup: widget: customerEmail = value of email input field captured by widget form",
      "path /signup: widget: variantId = new URLSearchParams(location.search).get('variant')",
      "path /signup: widget: productId = String(variantData.product_id)  // resolved from prior storefront read",
      "path /signup: widget: customerId = host.context().customerId  // null for guests",
      "path /signup: widget calls host.call('/signup', { customerEmail, variantId, productId, customerId })",
      "path /signup: handler: const { customerEmail, variantId, productId, customerId } = ctx.widgetBody",
      "path /signup: handler: if !customerEmail: return { success: false, alreadySubscribed: false }  // required field missing",
      "path /signup: handler: if !variantId: return { success: false, alreadySubscribed: false }  // required field missing",
      "path /signup: handler: if !productId: return { success: false, alreadySubscribed: false }  // required field missing",
      "path /signup: handler: fetch variant server-side to resolve inventory_item_id",
      "path /signup: handler: variantResponse = ctx.shopify.get('/admin/api/2026-01/variants/' + variantId + '.json')",
      "path /signup: handler: if !variantResponse.variant: return { success: false, alreadySubscribed: false }  // variant not found",
      "path /signup: handler: const inventoryItemId = variantResponse.variant.inventory_item_id",
      "path /signup: handler: attempt INSERT INTO back_in_stock_subscriptions (id, tenant_id, variant_id, product_id, inventory_item_id, customer_id, customer_email, notified_at, created_at) VALUES (uuid(), ${ctx.tenantId}, ${variantId}, ${productId}, ${inventoryItemId}, ${customerId}, ${customerEmail}, NULL, NOW()) ON CONFLICT ON CONSTRAINT uq_bisubs_tenant_variant_email DO NOTHING RETURNING id",
      "path /signup: handler: insertedRows = result of above INSERT",
      "path /signup: handler: if insertedRows.length === 0: return { success: true, alreadySubscribed: true }  // duplicate \u2014 already subscribed",
      "path /signup: handler: return { success: true, alreadySubscribed: false }  // new subscription created",
      "path /signup: widget checks result.alreadySubscribed BEFORE result.success \u2014 if alreadySubscribed show 'You are already subscribed'; else if success show 'You\\'ll be notified when this is back in stock'"
    ],
    "adminPath": [
      "// \u2500\u2500 path /subscribers \u2500\u2500",
      "path /subscribers: admin panel calls bridge.call('/subscribers') with no body",
      "path /subscribers: handler: check ctx.trigger === 'admin'",
      "path /subscribers: handler: rows = SELECT id, variant_id, product_id, customer_email, customer_id, notified_at, created_at FROM back_in_stock_subscriptions WHERE tenant_id = ${ctx.tenantId} ORDER BY created_at DESC LIMIT 50",
      "path /subscribers: handler: if rows.length === 0: return { total: 0, rows: [] }",
      "path /subscribers: handler: collect distinct product_id values from rows into productIdList",
      "path /subscribers: handler: split productIdList into chunks of 250",
      "path /subscribers: handler: for each chunk, call ctx.shopify.get('/admin/api/2026-01/products.json?ids=' + chunk.join(',') + '&fields=id,title,variants') \u2192 accumulate into productList",
      "path /subscribers: handler: build productMap<product_id, { productTitle, variantMap<variant_id, variantTitle> }> from productList \u2014 for each product, iterate product.variants to populate variantMap",
      "path /subscribers: handler: for each row in rows: lookup productEntry = productMap[row.product_id]; set productTitle = productEntry?.productTitle ?? ''; set variantTitle = productEntry?.variantMap[row.variant_id] ?? ''",
      "path /subscribers: handler: build responseRows = rows.map(row => { id: row.id, variantId: row.variant_id, productId: row.product_id, productTitle, variantTitle, customerEmail: row.customer_email, customerId: row.customer_id, notifiedAt: row.notified_at, createdAt: row.created_at })",
      "path /subscribers: handler returns { total: responseRows.length, rows: responseRows }; panel renders table",
      "// \u2500\u2500 path /config/get \u2500\u2500",
      "path /config/get: admin panel calls bridge.call('/config/get') with no body",
      "path /config/get: handler: check ctx.trigger === 'admin'",
      "path /config/get: handler: configRows = SELECT email_subject, email_body_template FROM back_in_stock_config WHERE tenant_id = ${ctx.tenantId} LIMIT 1",
      "path /config/get: handler: if configRows.length === 0: return { emailSubject: 'Good news! {{productTitle}} is back in stock', emailBodyTemplate: 'Hi, {{productTitle}} ({{variantTitle}}) is back in stock. Visit the store to purchase it.' }  // defaults",
      "path /config/get: handler returns { emailSubject: configRows[0].email_subject, emailBodyTemplate: configRows[0].email_body_template }; panel populates config form fields",
      "// \u2500\u2500 path /config/save \u2500\u2500",
      "path /config/save: admin panel calls bridge.call('/config/save', { emailSubject, emailBodyTemplate })",
      "path /config/save: handler: check ctx.trigger === 'admin'",
      "path /config/save: handler: const { emailSubject, emailBodyTemplate } = ctx.widgetBody",
      "path /config/save: handler: if !emailSubject: return { success: false }  // required field missing",
      "path /config/save: handler: if !emailBodyTemplate: return { success: false }  // required field missing",
      "path /config/save: handler: UPSERT INTO back_in_stock_config (tenant_id, email_subject, email_body_template, updated_at) VALUES (${ctx.tenantId}, ${emailSubject}, ${emailBodyTemplate}, NOW()) ON CONFLICT (tenant_id) DO UPDATE SET email_subject = ${emailSubject}, email_body_template = ${emailBodyTemplate}, updated_at = NOW()",
      "path /config/save: handler returns { success: true }; panel shows save confirmation"
    ],
    "functions": [
      {
        "name": "interpolate",
        "steps": [
          "accept template string and data object as arguments",
          "for each key in data object: replace all occurrences of '{{' + key + '}}' in template with data[key] ?? ''",
          "return the resulting string"
        ]
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
  handler: async function(ctx) {
    function interpolate(template, data) {
      let result = template;
      for (const key of Object.keys(data)) {
        const value = data[key] != null ? data[key] : '';
        result = result.split('{{' + key + '}}').join(value);
      }
      return result;
    }

    try {
      // ── ADMIN trigger ──
      if (ctx.trigger === 'admin') {
        if (ctx.widgetPath === '/subscribers') {
          const rows = await ctx.db`
            SELECT id, variant_id, product_id, customer_email, customer_id, notified_at, created_at
            FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY created_at DESC
            LIMIT 50
          `;

          if (rows.length === 0) {
            return { total: 0, rows: [] };
          }

          const productIdList = [...new Set(rows.map(r => String(r.product_id)))];
          const productMap = new Map();

          const PRODUCT_BATCH = 250;
          for (let i = 0; i < productIdList.length; i += PRODUCT_BATCH) {
            const chunk = productIdList.slice(i, i + PRODUCT_BATCH);
            const { products } = await ctx.shopify.get(
              `/products.json?ids=${chunk.join(',')}&fields=id,title,variants`
            );
            for (const p of (products || [])) {
              const variantMap = new Map();
              for (const v of (p.variants || [])) {
                variantMap.set(String(v.id), v.title);
              }
              productMap.set(String(p.id), { productTitle: p.title, variantMap });
            }
          }

          const responseRows = rows.map(row => {
            const productEntry = productMap.get(String(row.product_id));
            const productTitle = productEntry ? productEntry.productTitle : '';
            const variantTitle = productEntry ? (productEntry.variantMap.get(String(row.variant_id)) || '') : '';
            return {
              id: row.id,
              variantId: row.variant_id,
              productId: row.product_id,
              productTitle,
              variantTitle,
              customerEmail: row.customer_email,
              customerId: row.customer_id,
              notifiedAt: row.notified_at,
              createdAt: row.created_at
            };
          });

          return { total: responseRows.length, rows: responseRows };
        }

        if (ctx.widgetPath === '/config/get') {
          const configRows = await ctx.db`
            SELECT email_subject, email_body_template
            FROM back_in_stock_config
            WHERE tenant_id = ${ctx.tenantId}
            LIMIT 1
          `;

          if (configRows.length === 0) {
            return {
              emailSubject: 'Good news! {{productTitle}} is back in stock',
              emailBodyTemplate: 'Hi, {{productTitle}} ({{variantTitle}}) is back in stock. Visit the store to purchase it.'
            };
          }

          return {
            emailSubject: configRows[0].email_subject,
            emailBodyTemplate: configRows[0].email_body_template
          };
        }

        if (ctx.widgetPath === '/config/save') {
          const { emailSubject, emailBodyTemplate } = ctx.widgetBody || {};

          if (!emailSubject) return { success: false };
          if (!emailBodyTemplate) return { success: false };

          await ctx.db`
            INSERT INTO back_in_stock_config (tenant_id, email_subject, email_body_template, updated_at)
            VALUES (${ctx.tenantId}, ${emailSubject}, ${emailBodyTemplate}, NOW())
            ON CONFLICT (tenant_id) DO UPDATE
              SET email_subject = ${emailSubject},
                  email_body_template = ${emailBodyTemplate},
                  updated_at = NOW()
          `;

          ctx.logger.info({ path: '/config/save' }, 'Config saved');
          return { success: true };
        }

        return { error: 'unknown path' };
      }

      // ── WIDGET trigger ──
      if (ctx.trigger === 'widget') {
        if (ctx.widgetPath === '/status') {
          const { variantId, customerId } = ctx.widgetBody || {};

          if (!variantId) return { alreadySubscribed: false };
          if (!customerId) return { alreadySubscribed: false };

          const statusRows = await ctx.db`
            SELECT id FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variantId}
              AND customer_id = ${customerId}
            LIMIT 1
          `;

          return { alreadySubscribed: statusRows.length > 0 };
        }

        if (ctx.widgetPath === '/signup') {
          const { customerEmail, variantId, productId, customerId } = ctx.widgetBody || {};

          if (!customerEmail) return { success: false, alreadySubscribed: false };
          if (!variantId) return { success: false, alreadySubscribed: false };
          if (!productId) return { success: false, alreadySubscribed: false };

          let variantResponse;
          try {
            variantResponse = await ctx.shopify.get(`/variants/${variantId}.json`);
          } catch (err) {
            ctx.logger.error({ err, variantId }, 'Failed to fetch variant');
            return { success: false, alreadySubscribed: false };
          }

          if (!variantResponse.variant) return { success: false, alreadySubscribed: false };
          const inventoryItemId = variantResponse.variant.inventory_item_id;

          const insertedRows = await ctx.db`
            INSERT INTO back_in_stock_subscriptions
              (id, tenant_id, variant_id, product_id, inventory_item_id, customer_id, customer_email, notified_at, created_at)
            VALUES
              (gen_random_uuid(), ${ctx.tenantId}, ${variantId}, ${productId}, ${inventoryItemId}, ${customerId || null}, ${customerEmail}, NULL, NOW())
            ON CONFLICT ON CONSTRAINT uq_bisubs_tenant_variant_email DO NOTHING
            RETURNING id
          `;

          if (insertedRows.length === 0) return { success: true, alreadySubscribed: true };
          return { success: true, alreadySubscribed: false };
        }

        return { error: 'unknown path' };
      }

      // ── WEBHOOK trigger ──
      const { inventory_item_id, available } = ctx.payload;

      ctx.logger.info({ trigger: ctx.trigger, inventory_item_id, available }, 'inventory_levels/update received');

      if (!inventory_item_id) {
        ctx.logger.warn('Missing inventory_item_id — skipping');
        return;
      }

      // PHASE 1: Read previous state
      const stateRows = await ctx.db`
        SELECT previous_quantity FROM back_in_stock_inventory_state
        WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventory_item_id}
      `;

      const previousQuantity = stateRows.length > 0 ? stateRows[0].previous_quantity : null;

      // PHASE 1b: Upsert new state unconditionally
      await ctx.db`
        INSERT INTO back_in_stock_inventory_state (tenant_id, inventory_item_id, previous_quantity, updated_at)
        VALUES (${ctx.tenantId}, ${inventory_item_id}, ${available}, NOW())
        ON CONFLICT ON CONSTRAINT uq_bis_invstate_tenant_item DO UPDATE
          SET previous_quantity = ${available}, updated_at = NOW()
      `;

      // PHASE 2: Transition guard
      if (previousQuantity === null) {
        ctx.logger.info({ inventory_item_id }, 'First observation — baseline set, skipping notification');
        return;
      }

      // PHASE 3: Restock transition check
      if (previousQuantity > 0) {
        ctx.logger.info({ inventory_item_id, previousQuantity }, 'Already in stock — not a restock event');
        return;
      }

      if (available <= 0) {
        ctx.logger.info({ inventory_item_id, available }, 'Still out of stock — nothing to notify');
        return;
      }

      // PHASE 4: Resolve variant_id
      let inventoryItemResponse;
      try {
        inventoryItemResponse = await ctx.shopify.get(`/inventory_items/${inventory_item_id}.json`);
      } catch (err) {
        ctx.logger.error({ err, inventory_item_id }, 'Failed to fetch inventory item');
        return;
      }

      if (!inventoryItemResponse.inventory_item) {
        ctx.logger.warn({ inventory_item_id }, 'Inventory item not found');
        return;
      }

      const variant_id = inventoryItemResponse.inventory_item.variant_id;
      if (!variant_id) {
        ctx.logger.warn({ inventory_item_id }, 'No variant_id on inventory item');
        return;
      }

      // PHASE 5: Resolve product_id and variant details
      let variantResponse;
      try {
        variantResponse = await ctx.shopify.get(`/variants/${variant_id}.json`);
      } catch (err) {
        ctx.logger.error({ err, variant_id }, 'Failed to fetch variant');
        return;
      }

      if (!variantResponse.variant) {
        ctx.logger.warn({ variant_id }, 'Variant not found');
        return;
      }

      const product_id = variantResponse.variant.product_id;
      const variantTitle = variantResponse.variant.title;

      if (!product_id) {
        ctx.logger.warn({ variant_id }, 'No product_id on variant');
        return;
      }

      // PHASE 6: Resolve product details
      let productResponse;
      try {
        productResponse = await ctx.shopify.get(`/products/${product_id}.json`);
      } catch (err) {
        ctx.logger.error({ err, product_id }, 'Failed to fetch product');
        return;
      }

      if (!productResponse.product) {
        ctx.logger.warn({ product_id }, 'Product not found');
        return;
      }

      const productTitle = productResponse.product.title;
      const productHandle = productResponse.product.handle;

      // PHASE 7: Check subscribers
      const subscriberRows = await ctx.db`
        SELECT id, customer_email, customer_id, variant_id, product_id
        FROM back_in_stock_subscriptions
        WHERE tenant_id = ${ctx.tenantId}
          AND variant_id = ${variant_id}
          AND notified_at IS NULL
      `;

      if (subscriberRows.length === 0) {
        ctx.logger.info({ variant_id }, 'No unnotified subscribers — skipping');
        return;
      }

      // PHASE 8: Atomically claim notifications
      const claimed = await ctx.db`
        UPDATE back_in_stock_subscriptions
        SET notified_at = NOW()
        WHERE tenant_id = ${ctx.tenantId}
          AND variant_id = ${variant_id}
          AND notified_at IS NULL
        RETURNING id, customer_email, customer_id
      `;

      if (claimed.length === 0) {
        ctx.logger.info({ variant_id }, 'No rows claimed — already processed by concurrent handler');
        return;
      }

      ctx.logger.info({ variant_id, claimed: claimed.length }, 'Claimed subscribers for notification');

      // PHASE 9: Load email config
      const configRows = await ctx.db`
        SELECT email_subject, email_body_template
        FROM back_in_stock_config
        WHERE tenant_id = ${ctx.tenantId}
        LIMIT 1
      `;

      const emailSubject = configRows.length > 0
        ? configRows[0].email_subject
        : 'Good news! {{productTitle}} is back in stock';
      const emailBodyTemplate = configRows.length > 0
        ? configRows[0].email_body_template
        : 'Hi, {{productTitle}} ({{variantTitle}}) is back in stock. Visit the store to purchase it.';

      // PHASE 10: Send notifications
      for (const row of claimed) {
        const resolvedSubject = interpolate(emailSubject, { productTitle, variantTitle });
        const resolvedBody = interpolate(emailBodyTemplate, { productTitle, variantTitle });
        await ctx.email.send({
          to: row.customer_email,
          subject: resolvedSubject,
          data: { productTitle, variantTitle, productHandle, variantId: variant_id, body: resolvedBody }
        });
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
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL,
  variant_id        BIGINT      NOT NULL,
  product_id        BIGINT      NOT NULL,
  inventory_item_id BIGINT      NOT NULL,
  customer_id       BIGINT,
  customer_email    TEXT        NOT NULL,
  notified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bisubs_tenant_variant_email UNIQUE (tenant_id, variant_id, customer_email)
);

ALTER TABLE back_in_stock_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY back_in_stock_subscriptions_tenant_isolation ON back_in_stock_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_bis_subs_tenant_variant_notified
  ON back_in_stock_subscriptions (tenant_id, variant_id, notified_at);

CREATE TABLE back_in_stock_inventory_state (
  tenant_id         UUID        NOT NULL,
  inventory_item_id BIGINT      NOT NULL,
  previous_quantity INTEGER,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bis_invstate_tenant_item UNIQUE (tenant_id, inventory_item_id)
);

ALTER TABLE back_in_stock_inventory_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY back_in_stock_inventory_state_tenant_isolation ON back_in_stock_inventory_state
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE TABLE back_in_stock_config (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL,
  email_subject       TEXT,
  email_body_template TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE back_in_stock_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY back_in_stock_config_tenant_isolation ON back_in_stock_config
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_bis_config_tenant
  ON back_in_stock_config (tenant_id);
```

### widget.js

```javascript
export function mount(container, host) {
  let variantData = null;
  let variantId = null;
  let productId = null;

  const styles = `
    .bis-widget {
      font-family: inherit;
      margin: 16px 0;
    }
    .bis-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 400px;
    }
    .bis-form input[type="email"] {
      padding: 10px 14px;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 14px;
      width: 100%;
      box-sizing: border-box;
    }
    .bis-form input[type="email"]:focus {
      outline: none;
      border-color: #555;
    }
    .bis-btn {
      padding: 10px 20px;
      background: #222;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-size: 14px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .bis-btn:hover {
      background: #444;
    }
    .bis-btn:disabled {
      background: #999;
      cursor: not-allowed;
    }
    .bis-message {
      font-size: 14px;
      padding: 10px 0;
    }
    .bis-message.success {
      color: #2a7a2a;
    }
    .bis-message.info {
      color: #555;
    }
    .bis-message.error {
      color: #c0392b;
    }
    .bis-label {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 2px;
      color: #333;
    }
    .bis-hidden {
      display: none;
    }
  `;

  const styleEl = container.ownerDocument
    ? container.ownerDocument.createElement('style')
    : null;

  if (styleEl) {
    styleEl.textContent = styles;
    container.appendChild(styleEl);
  }

  const root = document.createElement('div');
  root.className = 'bis-widget';
  container.appendChild(root);

  function render(html) {
    root.innerHTML = html;
  }

  function showNothing() {
    root.innerHTML = '';
  }

  function showLoading() {
    render('<div class="bis-message info">Checking availability...</div>');
  }

  function showAlreadySubscribed() {
    render('<div class="bis-message info">You are already subscribed.</div>');
  }

  function showSuccess() {
    render('<div class="bis-message success">You\'ll be notified when this is back in stock.</div>');
  }

  function showError(msg) {
    render('<div class="bis-message error">' + (msg || 'Something went wrong. Please try again.') + '</div>');
  }

  function showForm(prefillEmail) {
    const emailVal = prefillEmail || '';
    root.innerHTML = `
      <form class="bis-form" id="bis-form">
        <div class="bis-label">Notify me when back in stock</div>
        <input
          type="email"
          name="email"
          placeholder="Enter your email address"
          value="${emailVal}"
          required
          autocomplete="email"
        />
        <button type="submit" class="bis-btn" id="bis-submit-btn">Notify Me</button>
        <div id="bis-form-message"></div>
      </form>
    `;

    const form = root.querySelector('#bis-form');
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      handleSubmit(form);
    });
  }

  async function handleSubmit(form) {
    const btn = root.querySelector('#bis-submit-btn');
    const msgEl = root.querySelector('#bis-form-message');
    const formData = host.getFormData(form);
    const customerEmail = (formData.email || '').trim();

    if (!customerEmail) {
      if (msgEl) {
        msgEl.className = 'bis-message error';
        msgEl.textContent = 'Please enter a valid email address.';
      }
      return;
    }

    if (btn) btn.disabled = true;
    if (msgEl) {
      msgEl.className = 'bis-message info';
      msgEl.textContent = 'Submitting...';
    }

    try {
      const customerId = host.context.customerId;
      const result = await host.call('/signup', {
        customerEmail,
        variantId,
        productId,
        customerId,
      });

      if (result.alreadySubscribed) {
        showAlreadySubscribed();
      } else if (result.success) {
        showSuccess();
      } else {
        if (btn) btn.disabled = false;
        if (msgEl) {
          msgEl.className = 'bis-message error';
          msgEl.textContent = 'Unable to subscribe. Please try again.';
        }
      }
    } catch (err) {
      if (btn) btn.disabled = false;
      if (msgEl) {
        msgEl.className = 'bis-message error';
        msgEl.textContent = 'An error occurred. Please try again.';
      }
    }
  }

  async function init() {
    showLoading();

    variantId = new URLSearchParams(location.search).get('variant');

    if (!variantId) {
      showNothing();
      return;
    }

    let variantResult;
    try {
      variantResult = await host.storefront('/variants/' + variantId + '.js');
    } catch (err) {
      showNothing();
      return;
    }

    variantData = variantResult;
    const isOutOfStock = variantData.available === false;

    if (!isOutOfStock) {
      showNothing();
      return;
    }

    productId = String(variantData.product_id);

    const customerId = host.context.customerId;

    let statusResult;
    try {
      statusResult = await host.call('/status', { variantId, customerId });
    } catch (err) {
      statusResult = { alreadySubscribed: false };
    }

    if (statusResult && statusResult.alreadySubscribed) {
      showAlreadySubscribed();
      return;
    }

    showForm('');
  }

  init();
}
```

### admin_ui.js

```javascript
export function mount(container, bridge) {
  // ── Styles ──
  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    .bis-panel {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      color: #202223;
      background: #f6f6f7;
      min-height: 100vh;
      padding: 24px;
    }

    .bis-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }

    .bis-title {
      font-size: 20px;
      font-weight: 600;
      color: #1a1a1a;
    }

    .bis-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 24px;
      border-bottom: 2px solid #e1e3e5;
    }

    .bis-tab {
      padding: 10px 20px;
      border: none;
      background: none;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      color: #6d7175;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
      transition: color 0.15s, border-color 0.15s;
    }

    .bis-tab:hover { color: #202223; }

    .bis-tab.active {
      color: #008060;
      border-bottom-color: #008060;
    }

    .bis-section {
      display: none;
    }

    .bis-section.active {
      display: block;
    }

    .bis-stat-row {
      display: flex;
      gap: 16px;
      margin-bottom: 24px;
    }

    .bis-stat-card {
      background: #fff;
      border: 1px solid #e1e3e5;
      border-radius: 8px;
      padding: 20px 24px;
      flex: 1;
    }

    .bis-stat-label {
      font-size: 12px;
      font-weight: 500;
      color: #6d7175;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }

    .bis-stat-value {
      font-size: 28px;
      font-weight: 700;
      color: #202223;
    }

    .bis-card {
      background: #fff;
      border: 1px solid #e1e3e5;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 24px;
    }

    .bis-card-header {
      padding: 16px 20px;
      border-bottom: 1px solid #e1e3e5;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .bis-card-title {
      font-size: 15px;
      font-weight: 600;
      color: #202223;
    }

    .bis-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border-radius: 6px;
      border: 1px solid #c9cccf;
      background: #fff;
      color: #202223;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }

    .bis-btn:hover { background: #f6f6f7; }

    .bis-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .bis-btn-primary {
      background: #008060;
      border-color: #008060;
      color: #fff;
    }

    .bis-btn-primary:hover { background: #006e52; border-color: #006e52; }

    .bis-table-wrap {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead th {
      background: #f6f6f7;
      padding: 10px 16px;
      text-align: left;
      font-size: 12px;
      font-weight: 600;
      color: #6d7175;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-bottom: 1px solid #e1e3e5;
      white-space: nowrap;
    }

    tbody tr {
      border-bottom: 1px solid #f1f1f1;
      transition: background 0.1s;
    }

    tbody tr:last-child { border-bottom: none; }
    tbody tr:hover { background: #fafafa; }

    tbody td {
      padding: 12px 16px;
      font-size: 13px;
      color: #202223;
      vertical-align: middle;
    }

    .bis-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }

    .bis-badge-success {
      background: #d4edda;
      color: #155724;
    }

    .bis-badge-pending {
      background: #fff3cd;
      color: #856404;
    }

    .bis-empty {
      padding: 48px 24px;
      text-align: center;
      color: #6d7175;
      font-size: 14px;
    }

    .bis-spinner {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px;
    }

    .bis-spinner-ring {
      width: 36px;
      height: 36px;
      border: 3px solid #e1e3e5;
      border-top-color: #008060;
      border-radius: 50%;
      animation: bis-spin 0.7s linear infinite;
    }

    @keyframes bis-spin {
      to { transform: rotate(360deg); }
    }

    .bis-error {
      background: #fef1f1;
      border: 1px solid #fca5a5;
      border-radius: 8px;
      padding: 16px 20px;
      color: #b91c1c;
      font-size: 14px;
      margin-bottom: 16px;
    }

    .bis-form {
      padding: 24px;
    }

    .bis-form-group {
      margin-bottom: 20px;
    }

    .bis-label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #202223;
      margin-bottom: 6px;
    }

    .bis-label span {
      color: #6d7175;
      font-weight: 400;
    }

    .bis-input {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid #c9cccf;
      border-radius: 6px;
      font-size: 14px;
      color: #202223;
      background: #fff;
      transition: border-color 0.15s;
    }

    .bis-input:focus {
      outline: none;
      border-color: #008060;
      box-shadow: 0 0 0 2px rgba(0,128,96,0.15);
    }

    textarea.bis-input {
      resize: vertical;
      min-height: 120px;
      font-family: inherit;
    }

    .bis-hint {
      margin-top: 6px;
      font-size: 12px;
      color: #6d7175;
    }

    .bis-form-actions {
      display: flex;
      justify-content: flex-end;
      padding: 16px 24px;
      border-top: 1px solid #e1e3e5;
    }

    .bis-text-muted {
      color: #6d7175;
      font-size: 12px;
    }

    .bis-truncate {
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;
  container.appendChild(style);

  // ── Root ──
  const root = document.createElement('div');
  root.className = 'bis-panel';
  container.appendChild(root);

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'bis-header';
  header.innerHTML = `<div class="bis-title">Back in Stock Notifications</div>`;
  root.appendChild(header);

  // ── Tabs ──
  const tabs = document.createElement('div');
  tabs.className = 'bis-tabs';
  tabs.innerHTML = `
    <button class="bis-tab active" data-tab="subscribers">Subscribers</button>
    <button class="bis-tab" data-tab="config">Email Configuration</button>
  `;
  root.appendChild(tabs);

  // ── Sections ──
  const subscribersSection = document.createElement('div');
  subscribersSection.className = 'bis-section active';
  subscribersSection.id = 'section-subscribers';
  root.appendChild(subscribersSection);

  const configSection = document.createElement('div');
  configSection.className = 'bis-section';
  configSection.id = 'section-config';
  root.appendChild(configSection);

  // ── Tab switching ──
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.bis-tab');
    if (!btn) return;
    const tabName = btn.dataset.tab;
    tabs.querySelectorAll('.bis-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    root.querySelectorAll('.bis-section').forEach(s => s.classList.remove('active'));
    root.querySelector(`#section-${tabName}`).classList.add('active');
  });

  // ─────────────────────────────────────────────
  // SUBSCRIBERS SECTION
  // ─────────────────────────────────────────────

  function renderSubscribersLoading() {
    subscribersSection.innerHTML = `
      <div class="bis-stat-row">
        <div class="bis-stat-card">
          <div class="bis-stat-label">Total Subscribers</div>
          <div class="bis-stat-value">—</div>
        </div>
        <div class="bis-stat-card">
          <div class="bis-stat-label">Notified</div>
          <div class="bis-stat-value">—</div>
        </div>
        <div class="bis-stat-card">
          <div class="bis-stat-label">Pending</div>
          <div class="bis-stat-value">—</div>
        </div>
      </div>
      <div class="bis-card">
        <div class="bis-card-header">
          <span class="bis-card-title">Subscriptions</span>
        </div>
        <div class="bis-spinner"><div class="bis-spinner-ring"></div></div>
      </div>
    `;
  }

  function renderSubscribersError(err) {
    subscribersSection.innerHTML = `
      <div class="bis-error">Failed to load subscribers: ${err && err.message ? err.message : 'Unknown error'}</div>
    `;
    const retryBtn = document.createElement('button');
    retryBtn.className = 'bis-btn';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', loadSubscribers);
    subscribersSection.appendChild(retryBtn);
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return dateStr; }
  }

  function renderSubscribers(data) {
    const { total, rows } = data;
    const notifiedCount = rows.filter(r => r.notifiedAt).length;
    const pendingCount = total - notifiedCount;

    subscribersSection.innerHTML = '';

    // Stat row
    const statRow = document.createElement('div');
    statRow.className = 'bis-stat-row';
    statRow.innerHTML = `
      <div class="bis-stat-card">
        <div class="bis-stat-label">Total Subscribers</div>
        <div class="bis-stat-value">${total}</div>
      </div>
      <div class="bis-stat-card">
        <div class="bis-stat-label">Notified</div>
        <div class="bis-stat-value">${notifiedCount}</div>
      </div>
      <div class="bis-stat-card">
        <div class="bis-stat-label">Pending</div>
        <div class="bis-stat-value">${pendingCount}</div>
      </div>
    `;
    subscribersSection.appendChild(statRow);

    // Card
    const card = document.createElement('div');
    card.className = 'bis-card';

    const cardHeader = document.createElement('div');
    cardHeader.className = 'bis-card-header';
    cardHeader.innerHTML = `<span class="bis-card-title">Subscriptions (showing up to 50)</span>`;

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'bis-btn';
    refreshBtn.innerHTML = `↻ Refresh`;
    refreshBtn.addEventListener('click', loadSubscribers);
    cardHeader.appendChild(refreshBtn);
    card.appendChild(cardHeader);

    if (!rows || rows.length === 0) {
      card.innerHTML += `<div class="bis-empty">No subscriptions found.</div>`;
    } else {
      const tableWrap = document.createElement('div');
      tableWrap.className = 'bis-table-wrap';

      const table = document.createElement('table');
      table.innerHTML = `
        <thead>
          <tr>
            <th>Email</th>
            <th>Product</th>
            <th>Variant</th>
            <th>Status</th>
            <th>Notified At</th>
            <th>Subscribed At</th>
          </tr>
        </thead>
      `;

      const tbody = document.createElement('tbody');
      rows.forEach(row => {
        const tr = document.createElement('tr');
        const status = row.notifiedAt
          ? `<span class="bis-badge bis-badge-success">Notified</span>`
          : `<span class="bis-badge bis-badge-pending">Pending</span>`;

        tr.innerHTML = `
          <td class="bis-truncate" title="${row.customerEmail || ''}">${row.customerEmail || '—'}</td>
          <td class="bis-truncate" title="${row.productTitle || ''}">${row.productTitle || <span class="bis-text-muted">#${row.productId}</span>}</td>
          <td>${row.variantTitle || `<span class="bis-text-muted">#${row.variantId}</span>`}</td>
          <td>${status}</td>
          <td class="bis-text-muted">${formatDate(row.notifiedAt)}</td>
          <td class="bis-text-muted">${formatDate(row.createdAt)}</td>
        `;
        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      tableWrap.appendChild(table);
      card.appendChild(tableWrap);
    }

    subscribersSection.appendChild(card);
  }

  function loadSubscribers() {
    renderSubscribersLoading();
    bridge.call('/subscribers')
      .then(data => renderSubscribers(data))
      .catch(err => renderSubscribersError(err));
  }

  // ─────────────────────────────────────────────
  // CONFIG SECTION
  // ─────────────────────────────────────────────

  function renderConfigLoading() {
    configSection.innerHTML = `
      <div class="bis-card">
        <div class="bis-card-header">
          <span class="bis-card-title">Email Settings</span>
        </div>
        <div class="bis-spinner"><div class="bis-spinner-ring"></div></div>
      </div>
    `;
  }

  function renderConfigError(err) {
    configSection.innerHTML = `
      <div class="bis-error">Failed to load configuration: ${err && err.message ? err.message : 'Unknown error'}</div>
    `;
    const retryBtn = document.createElement('button');
    retryBtn.className = 'bis-btn';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', loadConfig);
    configSection.appendChild(retryBtn);
  }

  function renderConfig(config) {
    configSection.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'bis-card';

    card.innerHTML = `
      <div class="bis-card-header">
        <span class="bis-card-title">Email Settings</span>
      </div>
      <div class="bis-form">
        <div class="bis-form-group">
          <label class="bis-label" for="cfg-subject">Email Subject</label>
          <input class="bis-input" id="cfg-subject" type="text" value="" placeholder="e.g. Good news! {{productTitle}} is back in stock" />
          <div class="bis-hint">Available variables: <code>{{productTitle}}</code>, <code>{{variantTitle}}</code></div>
        </div>
        <div class="bis-form-group">
          <label class="bis-label" for="cfg-body">Email Body Template</label>
          <textarea class="bis-input" id="cfg-body" placeholder="e.g. Hi, {{productTitle}} ({{variantTitle}}) is back in stock..."></textarea>
          <div class="bis-hint">Available variables: <code>{{productTitle}}</code>, <code>{{variantTitle}}</code>, <code>{{customerEmail}}</code></div>
        </div>
      </div>
      <div class="bis-form-actions">
        <button class="bis-btn bis-btn-primary" id="cfg-save-btn">Save Configuration</button>
      </div>
    `;

    configSection.appendChild(card);

    const subjectInput = configSection.querySelector('#cfg-subject');
    const bodyInput = configSection.querySelector('#cfg-body');
    const saveBtn = configSection.querySelector('#cfg-save-btn');

    subjectInput.value = config.emailSubject || '';
    bodyInput.value = config.emailBodyTemplate || '';

    saveBtn.addEventListener('click', () => {
      const emailSubject = subjectInput.value.trim();
      const emailBodyTemplate = bodyInput.value.trim();

      if (!emailSubject) {
        bridge.notify('Email subject is required.', 'error');
        subjectInput.focus();
        return;
      }

      if (!emailBodyTemplate) {
        bridge.notify('Email body template is required.', 'error');
        bodyInput.focus();
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      bridge.call('/config/save', { emailSubject, emailBodyTemplate })
        .then(result => {
          if (result && result.success) {
            bridge.notify('Configuration saved successfully.', 'success');
          } else {
            bridge.notify('Failed to save configuration. Please check all fields.', 'error');
          }
        })
        .catch(err => {
          bridge.notify('Error saving configuration: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
        })
        .finally(() => {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Configuration';
        });
    });
  }

  function loadConfig() {
    renderConfigLoading();
    bridge.call('/config/get')
      .then(data => renderConfig(data))
      .catch(err => renderConfigError(err));
  }

  // ── Initial load ──
  loadSubscribers();
  loadConfig();
}
```


## Explanation

{'merchantFacing': "With the Back-in-Stock Notifications feature, shoppers can sign up to be notified the moment a sold-out product becomes available again. A small, customizable widget automatically appears on your product pages when an item is out of stock, inviting customers to enter their email address and subscribe. Once they sign up, their request is saved so nothing gets missed — even if multiple variants go in and out of stock at different times.\n\nWhenever you restock a product — whether by receiving a new shipment or manually updating your inventory — the system detects the change right away. It then looks up everyone who subscribed for that specific product or variant and triggers an email notification letting them know it's back and ready to buy. The email includes the product name, image, and variant details so customers know exactly what's available. You can also view and manage your current subscriber list from your store's admin area.\n\nNote: This feature tracks subscriptions and detects restocks automatically, but sending the actual notification emails requires an email service such as Klaviyo or SendGrid to be connected to your store. Additionally, notifications are triggered by inventory quantity updates, so make sure your inventory is being tracked in Shopify for this feature to work correctly.", 'technical': {'webhookTopics': ['inventory_levels/update'], 'dbTables': ['back_in_stock_subscriptions', 'back_in_stock_inventory_state', 'back_in_stock_config'], 'estimatedMonthlyExecutions': 200, 'estimatedMonthlyCost': '$0.002'}}
