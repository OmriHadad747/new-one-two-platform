# Feature Generator — Run Result

**Date:** 2026-04-01 13:19:46  
**Status:** ❌ FAILED  
**Total:** 205078ms  
**Prompt:** Develop a Notify Me When Back In Stock Shopify app.

## Pipeline

| Agent       | Status | Time       | Notes |
|-------------|--------|------------|-------|
| Intent      | ✓      | 4000ms     | archetype=storefront_ui  trigger=both |
| Architect   | ✓      | 29605ms    | topics=['inventory_levels/update']  cron=*/15 * * * *  stateMachine=yes |
| CodeSpec    | ✓      | 51099ms    | webhook=33 steps  cron=24 steps  widget=36 steps  functions=3 |
| CodeGen     | ✓      | 38491ms    | attempt 3  handler ✓  migration ✓  widget_js ✓  errors: ['handler', 'widget_js'] |
| Explanation | —      | —          |  |

## Intent

```json
{
  "triggerType": "both",
  "resources": [
    "inventory",
    "products",
    "customers"
  ],
  "desiredOutcome": "Customers can sign up to receive an email notification when an out-of-stock product variant comes back in stock, and the system automatically sends those notifications when inventory is replenished.",
  "complexity": "high",
  "cronSchedule": "*/15 * * * *",
  "appArchetype": "storefront_ui"
}
```

## Architect Plan

```json
{
  "shopifyPlan": {
    "webhookTopics": [
      "inventory_levels/update"
    ],
    "cronSchedule": "*/15 * * * *",
    "operations": [
      {
        "step": 1,
        "description": "Webhook handler: read previous inventory state for this inventory_item_id from DB (state tracking)",
        "type": "query",
        "method": "GET",
        "path": null,
        "bodyExample": null
      },
      {
        "step": 2,
        "description": "Webhook handler: write new inventory state for this inventory_item_id to DB",
        "type": "mutation",
        "method": "POST",
        "path": null,
        "bodyExample": null
      },
      {
        "step": 3,
        "description": "Webhook handler: if transition from <=0 to >0, fetch all inventory levels for this inventory_item_id across all locations to confirm store-wide stock is positive",
        "type": "query",
        "method": "GET",
        "path": "/admin/api/2026-01/inventory_levels.json?inventory_item_ids={inventory_item_id}",
        "bodyExample": null
      },
      {
        "step": 4,
        "description": "Webhook handler: fetch the variant associated with this inventory_item_id to get product_id, variant title, price, and product handle for notification email",
        "type": "query",
        "method": "GET",
        "path": "/admin/api/2026-01/variants/{id}.json",
        "bodyExample": null
      },
      {
        "step": 5,
        "description": "Webhook handler: fetch the product to get title, image, and handle for notification email",
        "type": "query",
        "method": "GET",
        "path": "/admin/api/2026-01/products/{product_id}.json",
        "bodyExample": null
      },
      {
        "step": 6,
        "description": "Cron job: fetch all inventory levels for pending inventory_item_ids in bulk (batch up to 50 ids per request)",
        "type": "query",
        "method": "GET",
        "path": "/admin/api/2026-01/inventory_levels.json?inventory_item_ids={comma_separated_ids}",
        "bodyExample": null
      },
      {
        "step": 7,
        "description": "Cron job: fetch product data (including variants) for product_ids associated with replenished inventory items, to get title, image, handle, and variant details for email",
        "type": "query",
        "method": "GET",
        "path": "/admin/api/2026-01/products.json?ids={comma_separated_product_ids}",
        "bodyExample": null
      },
      {
        "step": 8,
        "description": "Widget signup: resolve inventory_item_id server-side from the submitted variant_id",
        "type": "query",
        "method": "GET",
        "path": "/admin/api/2026-01/variants/{variant_id}.json",
        "bodyExample": null
      }
    ]
  },
  "implementationSpec": {
    "stateMachine": {
      "needsStateTracking": true,
      "trackedEntity": "inventory_state.last_known_available (INTEGER NULLABLE) keyed on (tenant_id, inventory_item_id) \u2014 tracks the last observed available quantity summed across all locations",
      "unknownSentinel": "null",
      "skipWhenUnknown": true,
      "skipRationale": "Without a prior observed state we cannot confirm a zero-to-positive transition, so we skip notification on first-ever webhook receipt to avoid false positives."
    },
    "platformGaps": [],
    "cronBatching": {
      "required": true,
      "batchEndpoint": "/admin/api/2026-01/inventory_levels.json?inventory_item_ids=<comma-ids>",
      "batchParam": "inventory_item_ids",
      "maxBatchSize": 50,
      "advice": "Before the per-subscriber loop, query DB for all distinct inventory_item_ids with pending subscribers, batch-fetch their inventory levels (max 50 per request), sum available across locations per inventory_item_id into a Map, then batch-fetch product data via /products.json?ids=<comma-product-ids> (max 250) and build a variantId\u2192{productTitle, variantTitle, image, handle, price} lookup map \u2014 the loop body makes zero Shopify API calls."
    },
    "migrationGuidance": "Create a `back_in_stock_subscriptions` table with columns: id UUID PK, tenant_id UUID NOT NULL, variant_id BIGINT NOT NULL, inventory_item_id BIGINT NOT NULL, product_id BIGINT NOT NULL, customer_id BIGINT (nullable \u2014 guests have no Shopify customer ID), customer_email TEXT NOT NULL, subscribed_at TIMESTAMPTZ NOT NULL DEFAULT now(), notified_at TIMESTAMPTZ (nullable \u2014 null means not yet notified), CONSTRAINT uq_bis_tenant_variant_email UNIQUE (tenant_id, variant_id, customer_email). Create an `inventory_state` table with columns: id UUID PK, tenant_id UUID NOT NULL, inventory_item_id BIGINT NOT NULL, last_known_available INTEGER (NULLABLE \u2014 null = never observed), updated_at TIMESTAMPTZ NOT NULL, CONSTRAINT uq_invstate_tenant_item UNIQUE (tenant_id, inventory_item_id). Index back_in_stock_subscriptions on (tenant_id, inventory_item_id) WHERE notified_at IS NULL for efficient cron queries.",
    "widgetGuidance": "Display the signup form only when the variant's available quantity is 0 or false (read from host.storefront()); after submission show a confirmation message like 'You'll be notified when this is back in stock' rather than 'Email sent' since delivery is async.",
    "storefrontReads": [
      {
        "path": "/products/${handle}.js",
        "dataUsed": "variant.available and variant.inventory_quantity \u2014 widget reads current stock status to decide whether to show the 'Notify Me' form; extracts product handle from location.pathname and variant id from location.search or the page's variant selector"
      }
    ],
    "widgetApiCatalog": [
      {
        "method": "POST",
        "path": "/subscribe",
        "responseShape": {
          "success": true,
          "alreadySubscribed": false
        }
      },
      {
        "method": "GET",
        "path": "/subscription-status",
        "responseShape": {
          "isSubscribed": false
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
      "// Topic: inventory_levels/update",
      "step 1: const { inventory_item_id, location_id, available, updated_at } = ctx.payload",
      "step 2: if !inventory_item_id: return  // required field missing",
      "step 3: stateRows = SELECT last_known_available FROM inventory_state WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventory_item_id}",
      "step 4: if stateRows.length === 0: prevAvailable = null  // never observed before",
      "step 5: if stateRows.length > 0: prevAvailable = stateRows[0].last_known_available",
      "step 6: levelsResp = GET /admin/api/2026-01/inventory_levels.json?inventory_item_ids=${inventory_item_id} via ctx.shopify",
      "step 7: if !levelsResp.inventory_levels: return  // unexpected API response",
      "step 8: storeWideTotal = sum levelsResp.inventory_levels[*].available for all rows with inventory_item_id = ${inventory_item_id}",
      "step 9: UPSERT INTO inventory_state (id, tenant_id, inventory_item_id, last_known_available, updated_at) VALUES (uuid(), ${ctx.tenantId}, ${inventory_item_id}, ${storeWideTotal}, NOW()) ON CONFLICT (tenant_id, inventory_item_id) DO UPDATE SET last_known_available = ${storeWideTotal}, updated_at = NOW()",
      "// crash here leaves state updated but notifications unsent \u2014 cron path is the backstop",
      "step 10: if prevAvailable === null: return  // sentinel \u2014 cannot confirm transition without prior observation",
      "step 11: if prevAvailable > 0: return  // was already in stock, not a zero-to-positive transition",
      "step 12: if storeWideTotal <= 0: return  // still out of stock, no transition",
      "// confirmed transition from <=0 to >0 \u2014 proceed to notify subscribers",
      "step 13: variantResp = GET /admin/api/2026-01/variants/${inventory_item_id_to_variant_id}.json \u2014 first fetch the variant by querying DB: variantRows = SELECT DISTINCT variant_id, product_id FROM back_in_stock_subscriptions WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventory_item_id} AND notified_at IS NULL",
      "step 14: if variantRows.length === 0: return  // no pending subscribers for this inventory item",
      "step 15: variantId = variantRows[0].variant_id",
      "step 16: productId = variantRows[0].product_id",
      "step 17: variantResp = GET /admin/api/2026-01/variants/${variantId}.json via ctx.shopify",
      "step 18: if !variantResp.variant: return  // variant not found or deleted",
      "step 19: variant = variantResp.variant  // fields: id, title, price, product_id, inventory_item_id",
      "step 20: productResp = GET /admin/api/2026-01/products/${productId}.json via ctx.shopify",
      "step 21: if !productResp.product: return  // product not found or deleted",
      "step 22: product = productResp.product  // fields: id, title, handle, image",
      "step 23: productTitle = product.title",
      "step 24: productHandle = product.handle",
      "step 25: productImageSrc = product.image ? product.image.src : null",
      "step 26: variantTitle = variant.title",
      "step 27: variantPrice = variant.price",
      "step 28: claimed = UPDATE back_in_stock_subscriptions SET notified_at = NOW() WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventory_item_id} AND notified_at IS NULL RETURNING id, customer_email, variant_id, product_id",
      "step 29: if claimed.length === 0: return  // already notified \u2014 idempotency guard",
      "step 30: for each row in claimed: emit notification email to row.customer_email with data { productTitle, productHandle, productImageSrc, variantTitle, variantPrice, productHandle, variantId: row.variant_id, productId: row.product_id }"
    ],
    "cronPath": [
      "// Cron schedule: */15 * * * *",
      "step 1: pendingRows = SELECT DISTINCT inventory_item_id, variant_id, product_id FROM back_in_stock_subscriptions WHERE tenant_id = ${ctx.tenantId} AND notified_at IS NULL",
      "step 2: if pendingRows.length === 0: return  // no pending subscribers",
      "step 3: distinctInventoryItemIds = collect unique inventory_item_id values from pendingRows",
      "step 4: inventoryMap = new Map<inventory_item_id, storeWideTotal>",
      "step 5: split distinctInventoryItemIds into chunks of 50",
      "step 6: for each chunk: levelsResp = GET /admin/api/2026-01/inventory_levels.json?inventory_item_ids=${chunk.join(',')} via ctx.shopify",
      "step 7: for each level in levelsResp.inventory_levels: inventoryMap[level.inventory_item_id] += level.available  // sum across locations",
      "step 8: replenishedInventoryItemIds = filter distinctInventoryItemIds where inventoryMap[id] > 0",
      "step 9: if replenishedInventoryItemIds.length === 0: return  // nothing replenished",
      "step 10: distinctProductIds = collect unique product_id values from pendingRows where inventory_item_id is in replenishedInventoryItemIds",
      "step 11: variantMap = new Map<variant_id, { productTitle, variantTitle, productHandle, productImageSrc, variantPrice }>",
      "step 12: split distinctProductIds into chunks of 250",
      "step 13: for each chunk: productsResp = GET /admin/api/2026-01/products.json?ids=${chunk.join(',')}&fields=id,title,handle,image,variants via ctx.shopify",
      "step 14: for each product in productsResp.products: for each variant in product.variants: variantMap[variant.id] = { productTitle: product.title, variantTitle: variant.title, productHandle: product.handle, productImageSrc: product.image ? product.image.src : null, variantPrice: variant.price }",
      "step 15: for each replenishedInventoryItemId in replenishedInventoryItemIds:",
      "step 15a:   pendingVariantRow = pendingRows.find(r => r.inventory_item_id === replenishedInventoryItemId)",
      "step 15b:   if !pendingVariantRow: continue  // no matching row",
      "step 15c:   variantId = pendingVariantRow.variant_id",
      "step 15d:   enrichment = variantMap[variantId]",
      "step 15e:   if !enrichment: continue  // product/variant data not found",
      "step 15f:   claimed = UPDATE back_in_stock_subscriptions SET notified_at = NOW() WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${replenishedInventoryItemId} AND notified_at IS NULL RETURNING id, customer_email, variant_id, product_id",
      "step 15g:   if claimed.length === 0: continue  // already notified \u2014 idempotency guard",
      "step 15h:   for each row in claimed: emit notification email to row.customer_email with data { productTitle: enrichment.productTitle, productHandle: enrichment.productHandle, productImageSrc: enrichment.productImageSrc, variantTitle: enrichment.variantTitle, variantPrice: enrichment.variantPrice, variantId: row.variant_id, productId: row.product_id }"
    ],
    "widgetPath": [
      "path /subscribe: widget reads handle from location.pathname.match(/\\/products\\/([^/?#]+)/)?.[1]",
      "path /subscribe: widget reads variantId from new URLSearchParams(location.search).get('variant')",
      "path /subscribe: widget calls host.storefront('/products/' + handle + '.js') \u2192 productData",
      "path /subscribe: widget: if !productData: do not render widget",
      "path /subscribe: widget: variant = variantId ? productData.variants.find(v => String(v.id) === String(variantId)) ?? productData.variants[0] : productData.variants[0]",
      "path /subscribe: widget: isOutOfStock = !variant.available",
      "path /subscribe: widget: productId = String(productData.id)",
      "path /subscribe: widget: variantId = String(variant.id)",
      "path /subscribe: widget: if isOutOfStock is false: do not render the 'Notify Me' form",
      "path /subscribe: widget: if isOutOfStock is true: render email input form with submit button labeled 'Notify Me'",
      "path /subscribe: widget: on form submit, capture customerEmail from email input field",
      "path /subscribe: widget calls host.call('/subscribe', { customerEmail, variantId, productId })",
      "path /subscribe: handler: const { customerEmail, variantId, productId } = ctx.widgetBody",
      "path /subscribe: handler: if !customerEmail or !variantId or !productId: return { success: false, alreadySubscribed: false }  // missing required fields",
      "path /subscribe: handler: variantResp = GET /admin/api/2026-01/variants/${variantId}.json via ctx.shopify",
      "path /subscribe: handler: if !variantResp.variant: return { success: false, alreadySubscribed: false }  // variant not found",
      "path /subscribe: handler: inventoryItemId = variantResp.variant.inventory_item_id",
      "path /subscribe: handler: resolvedProductId = variantResp.variant.product_id",
      "path /subscribe: handler: attempt INSERT INTO back_in_stock_subscriptions (id, tenant_id, variant_id, inventory_item_id, product_id, customer_id, customer_email, subscribed_at) VALUES (uuid(), ${ctx.tenantId}, ${variantId}, ${inventoryItemId}, ${resolvedProductId}, null, ${customerEmail}, NOW()) ON CONFLICT (tenant_id, variant_id, customer_email) DO NOTHING RETURNING id",
      "path /subscribe: handler: if inserted.length === 0: return { success: true, alreadySubscribed: true }  // duplicate subscription",
      "path /subscribe: handler: return { success: true, alreadySubscribed: false }",
      "path /subscribe: widget checks result.alreadySubscribed before result.success \u2014 if result.alreadySubscribed: show 'You are already signed up for notifications on this product'; else if result.success: show 'You will be notified when this is back in stock'",
      "path /subscription-status: widget reads handle from location.pathname.match(/\\/products\\/([^/?#]+)/)?.[1]",
      "path /subscription-status: widget reads variantId from new URLSearchParams(location.search).get('variant')",
      "path /subscription-status: widget reads customerId from host.context (null for guests)",
      "path /subscription-status: widget calls host.call('/subscription-status', { variantId, customerId })",
      "path /subscription-status: handler: const { variantId, customerId } = ctx.widgetBody",
      "path /subscription-status: handler: if !variantId: return { isSubscribed: false }  // missing required field",
      "path /subscription-status: handler: if customerId is null: return { isSubscribed: false }  // guest \u2014 cannot pre-identify",
      "path /subscription-status: handler: customerResp = GET /admin/api/2026-01/customers/${customerId}.json via ctx.shopify",
      "path /subscription-status: handler: if !customerResp.customer: return { isSubscribed: false }  // customer not found",
      "path /subscription-status: handler: customerEmail = customerResp.customer.email",
      "path /subscription-status: handler: statusRows = SELECT id FROM back_in_stock_subscriptions WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variantId} AND customer_email = ${customerEmail} AND notified_at IS NULL",
      "path /subscription-status: handler: if statusRows.length === 0: return { isSubscribed: false }",
      "path /subscription-status: handler: return { isSubscribed: true }",
      "path /subscription-status: widget reads result.isSubscribed \u2014 if true: show 'You are signed up for notifications on this variant'; if false: show the 'Notify Me' form if variant is out of stock"
    ],
    "functions": [
      {
        "name": "sumInventoryLevels",
        "steps": [
          "step 1: accept levels as array of { inventory_item_id, location_id, available }",
          "step 2: resultMap = new Map<inventory_item_id, number> initialized to 0 for each unique inventory_item_id",
          "step 3: for each level in levels: resultMap[level.inventory_item_id] += level.available",
          "step 4: return resultMap"
        ]
      },
      {
        "name": "emitBackInStockEmail",
        "steps": [
          "step 1: accept { customerEmail, productTitle, productHandle, productImageSrc, variantTitle, variantPrice, variantId, productId }",
          "step 2: compose email subject: `${productTitle} is back in stock!`",
          "step 3: compose email body with product image (if productImageSrc is not null), product title, variant title, price, and a call-to-action link using data fields { productHandle, variantId } \u2014 do NOT construct a full URL here; pass productHandle and variantId as template data fields for the email template to construct the storefront URL",
          "step 4: send transactional email to customerEmail using the app's email service with the composed subject and body",
          "step 5: log success or error for the send attempt"
        ]
      },
      {
        "name": "buildVariantMapFromProducts",
        "steps": [
          "step 1: accept productsArray as array of product objects each with fields: id, title, handle, image, variants[]",
          "step 2: variantMap = new Map<variant_id, { productTitle, variantTitle, productHandle, productImageSrc, variantPrice }>",
          "step 3: for each product in productsArray: productTitle = product.title; productHandle = product.handle; productImageSrc = product.image ? product.image.src : null",
          "step 4: for each variant in product.variants: variantMap[variant.id] = { productTitle, variantTitle: variant.title, productHandle, productImageSrc, variantPrice: variant.price }",
          "step 5: return variantMap"
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
  cronSchedule: '*/15 * * * *',
  handler: async function(ctx) {
    try {
      // ── Helper functions ──────────────────────────────────────────────────

      function sumInventoryLevels(levels) {
        const resultMap = new Map();
        for (const level of levels) {
          const key = String(level.inventory_item_id);
          resultMap.set(key, (resultMap.get(key) || 0) + (level.available || 0));
        }
        return resultMap;
      }

      async function emitBackInStockEmail({ customerEmail, productTitle, productHandle, productImageSrc, variantTitle, variantPrice, variantId, productId }) {
        try {
          await ctx.email.send({
            to: customerEmail,
            subject: `${productTitle} is back in stock!`,
            data: { productTitle, productHandle, productImageSrc, variantTitle, variantPrice, variantId, productId }
          });
        } catch (err) {
          ctx.logger.error({ customerEmail, variantId, err: err.message }, 'Failed to send back-in-stock email');
        }
      }

      function buildVariantMapFromProducts(productsArray) {
        const variantMap = new Map();
        for (const product of productsArray) {
          const productTitle = product.title;
          const productHandle = product.handle;
          const productImageSrc = product.image ? product.image.src : null;
          for (const variant of (product.variants || [])) {
            variantMap.set(String(variant.id), {
              productTitle,
              variantTitle: variant.title,
              productHandle,
              productImageSrc,
              variantPrice: variant.price
            });
          }
        }
        return variantMap;
      }

      // ── Widget path ───────────────────────────────────────────────────────

      if (ctx.trigger === 'widget') {
        if (ctx.widgetPath === '/subscribe') {
          const { customerEmail, variantId, productId } = ctx.widgetBody || {};
          if (!customerEmail || !variantId || !productId) {
            return { success: false, alreadySubscribed: false };
          }

          let variantResp;
          try {
            variantResp = await ctx.shopify.get(`/variants/${variantId}.json`);
          } catch (err) {
            ctx.logger.error({ variantId, err: err.message }, 'Failed to fetch variant for /subscribe');
            return { success: false, alreadySubscribed: false };
          }

          if (!variantResp || !variantResp.variant) {
            return { success: false, alreadySubscribed: false };
          }

          const inventoryItemId = variantResp.variant.inventory_item_id;
          const resolvedProductId = variantResp.variant.product_id;

          const inserted = await ctx.db`
            INSERT INTO back_in_stock_subscriptions
              (id, tenant_id, variant_id, inventory_item_id, product_id, customer_id, customer_email, subscribed_at)
            VALUES
              (gen_random_uuid(), ${ctx.tenantId}, ${variantId}, ${inventoryItemId}, ${resolvedProductId}, null, ${customerEmail}, NOW())
            ON CONFLICT (tenant_id, variant_id, customer_email) DO NOTHING
            RETURNING id
          `;

          if (inserted.length === 0) {
            return { success: true, alreadySubscribed: true };
          }
          return { success: true, alreadySubscribed: false };
        }

        if (ctx.widgetPath === '/subscription-status') {
          const { variantId, customerId } = ctx.widgetBody || {};
          if (!variantId) {
            return { isSubscribed: false };
          }
          if (!customerId) {
            return { isSubscribed: false };
          }

          let customerResp;
          try {
            customerResp = await ctx.shopify.get(`/customers/${customerId}.json`);
          } catch (err) {
            ctx.logger.error({ customerId, err: err.message }, 'Failed to fetch customer for /subscription-status');
            return { isSubscribed: false };
          }

          if (!customerResp || !customerResp.customer) {
            return { isSubscribed: false };
          }

          const customerEmail = customerResp.customer.email;

          const statusRows = await ctx.db`
            SELECT id FROM back_in_stock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variantId}
              AND customer_email = ${customerEmail}
              AND notified_at IS NULL
          `;

          if (statusRows.length === 0) {
            return { isSubscribed: false };
          }
          return { isSubscribed: true };
        }

        return { error: 'unknown path' };
      }

      // ── Cron path ─────────────────────────────────────────────────────────

      if (ctx.trigger === 'cron') {
        ctx.logger.info({ trigger: ctx.trigger }, 'Back-in-stock cron started');

        const pendingRows = await ctx.db`
          SELECT DISTINCT inventory_item_id, variant_id, product_id
          FROM back_in_stock_subscriptions
          WHERE tenant_id = ${ctx.tenantId}
            AND notified_at IS NULL
        `;

        if (pendingRows.length === 0) {
          ctx.logger.info('No pending subscribers — cron exit');
          return;
        }

        const distinctInventoryItemIds = [...new Set(pendingRows.map(r => String(r.inventory_item_id)))];

        const inventoryMap = new Map();
        const INV_BATCH = 50;
        for (let i = 0; i < distinctInventoryItemIds.length; i += INV_BATCH) {
          const chunk = distinctInventoryItemIds.slice(i, i + INV_BATCH);
          let levelsResp;
          try {
            levelsResp = await ctx.shopify.get(`/inventory_levels.json?inventory_item_ids=${chunk.join(',')}`);
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'Failed to fetch inventory levels in cron');
            continue;
          }
          for (const level of (levelsResp.inventory_levels || [])) {
            const key = String(level.inventory_item_id);
            inventoryMap.set(key, (inventoryMap.get(key) || 0) + (level.available || 0));
          }
        }

        const replenishedInventoryItemIds = distinctInventoryItemIds.filter(id => (inventoryMap.get(id) || 0) > 0);

        if (replenishedInventoryItemIds.length === 0) {
          ctx.logger.info('No replenished inventory items — cron exit');
          return;
        }

        const replenishedSet = new Set(replenishedInventoryItemIds);
        const distinctProductIds = [...new Set(
          pendingRows
            .filter(r => replenishedSet.has(String(r.inventory_item_id)))
            .map(r => String(r.product_id))
        )];

        const PRODUCT_BATCH = 250;
        const allProducts = [];
        for (let i = 0; i < distinctProductIds.length; i += PRODUCT_BATCH) {
          const chunk = distinctProductIds.slice(i, i + PRODUCT_BATCH);
          let productsResp;
          try {
            productsResp = await ctx.shopify.get(`/products.json?ids=${chunk.join(',')}&fields=id,title,handle,image,variants`);
          } catch (err) {
            ctx.logger.error({ err: err.message }, 'Failed to fetch products in cron');
            continue;
          }
          allProducts.push(...(productsResp.products || []));
        }

        const variantMap = buildVariantMapFromProducts(allProducts);

        for (const replenishedInventoryItemId of replenishedInventoryItemIds) {
          const pendingVariantRow = pendingRows.find(r => String(r.inventory_item_id) === replenishedInventoryItemId);
          if (!pendingVariantRow) continue;

          const variantId = String(pendingVariantRow.variant_id);
          const enrichment = variantMap.get(variantId);
          if (!enrichment) {
            ctx.logger.warn({ variantId, replenishedInventoryItemId }, 'No enrichment data found for variant in cron');
            continue;
          }

          const claimed = await ctx.db`
            UPDATE back_in_stock_subscriptions
            SET notified_at = NOW()
            WHERE tenant_id = ${ctx.tenantId}
              AND inventory_item_id = ${replenishedInventoryItemId}
              AND notified_at IS NULL
            RETURNING id, customer_email, variant_id, product_id
          `;

          if (claimed.length === 0) {
            ctx.logger.info({ replenishedInventoryItemId }, 'Already notified — cron skip');
            continue;
          }

          ctx.logger.info({ replenishedInventoryItemId, claimed: claimed.length }, 'Claimed rows for notification in cron');

          for (const row of claimed) {
            await emitBackInStockEmail({
              customerEmail: row.customer_email,
              productTitle: enrichment.productTitle,
              productHandle: enrichment.productHandle,
              productImageSrc: enrichment.productImageSrc,
              variantTitle: enrichment.variantTitle,
              variantPrice: enrichment.variantPrice,
              variantId: String(row.variant_id),
              productId: String(row.product_id)
            });
          }
        }

        return;
      }

      // ── Webhook path ──────────────────────────────────────────────────────

      ctx.logger.info({ trigger: ctx.trigger, inventory_item_id: ctx.payload.inventory_item_id }, 'inventory_levels/update webhook received');

      const { inventory_item_id, location_id, available, updated_at } = ctx.payload;

      if (!inventory_item_id) {
        ctx.logger.warn('Missing inventory_item_id in payload — exit');
        return;
      }

      const stateRows = await ctx.db`
        SELECT last_known_available
        FROM inventory_state
        WHERE tenant_id = ${ctx.tenantId}
          AND inventory_item_id = ${inventory_item_id}
      `;

      let prevAvailable = null;
      if (stateRows.length > 0) {
        prevAvailable = stateRows[0].last_known_available;
      }

      let levelsResp;
      try {
        levelsResp = await ctx.shopify.get(`/inventory_levels.json?inventory_item_ids=${inventory_item_id}`);
      } catch (err) {
        ctx.logger.error({ inventory_item_id, err: err.message }, 'Failed to fetch inventory levels in webhook');
        return;
      }

      if (!levelsResp || !levelsResp.inventory_levels) {
        ctx.logger.warn({ inventory_item_id }, 'Unexpected inventory levels API response — exit');
        return;
      }

      const levelsSumMap = sumInventoryLevels(levelsResp.inventory_levels);
      const storeWideTotal = levelsSumMap.get(String(inventory_item_id)) || 0;

      await ctx.db`
        INSERT INTO inventory_state (id, tenant_id, inventory_item_id, last_known_available, updated_at)
        VALUES (gen_random_uuid(), ${ctx.tenantId}, ${inventory_item_id}, ${storeWideTotal}, NOW())
        ON CONFLICT (tenant_id, inventory_item_id)
        DO UPDATE SET last_known_available = ${storeWideTotal}, updated_at = NOW()
      `;

      if (prevAvailable === null) {
        ctx.logger.info({ inventory_item_id }, 'First observation — baseline set, no notification');
        return;
      }

      if (prevAvailable > 0) {
        ctx.logger.info({ inventory_item_id, prevAvailable }, 'Was already in stock — no transition');
        return;
      }

      if (storeWideTotal <= 0) {
        ctx.logger.info({ inventory_item_id, storeWideTotal }, 'Still out of stock — no transition');
        return;
      }

      ctx.logger.info({ inventory_item_id, prevAvailable, storeWideTotal }, 'Transition from out-of-stock to in-stock detected');

      const variantRows = await ctx.db`
        SELECT DISTINCT variant_id, product_id
        FROM back_in_stock_subscriptions
        WHERE tenant_id = ${ctx.tenantId}
          AND inventory_item_id = ${inventory_item_id}
          AND notified_at IS NULL
      `;

      if (variantRows.length === 0) {
        ctx.logger.info({ inventory_item_id }, 'No pending subscribers for this inventory item — exit');
        return;
      }

      const variantId = variantRows[0].variant_id;
      const productId = variantRows[0].product_id;

      let variantResp;
      try {
        variantResp = await ctx.shopify.get(`/variants/${variantId}.json`);
      } catch (err) {
        ctx.logger.error({ variantId, err: err.message }, 'Failed to fetch variant in webhook');
        return;
      }

      if (!variantResp || !variantResp.variant) {
        ctx.logger.warn({ variantId }, 'Variant not found or deleted — exit');
        return;
      }

      const variant = variantResp.variant;

      let productResp;
      try {
        productResp = await ctx.shopify.get(`/products/${productId}.json`);
      } catch (err) {
        ctx.logger.error({ productId, err: err.message }, 'Failed to fetch product in webhook');
        return;
      }

      if (!productResp || !productResp.product) {
        ctx.logger.warn({ productId }, 'Product not found or deleted — exit');
        return;
      }

      const product = productResp.product;
      const productTitle = product.title;
      const productHandle = product.handle;
      const productImageSrc = product.image ? product.image.src : null;
      const variantTitle = variant.title;
      const variantPrice = variant.price;

      const claimed = await ctx.db`
        UPDATE back_in_stock_subscriptions
        SET notified_at = NOW()
        WHERE tenant_id = ${ctx.tenantId}
          AND inventory_item_id = ${inventory_item_id}
          AND notified_at IS NULL
        RETURNING id, customer_email, variant_id, product_id
      `;

      if (claimed.length === 0) {
        ctx.logger.info({ inventory_item_id }, 'Already notified — idempotency guard');
        return;
      }

      ctx.logger.info({ inventory_item_id, claimed: claimed.length }, 'Claimed rows for notification in webhook');

      for (const row of claimed) {
        await emitBackInStockEmail({
          customerEmail: row.customer_email,
          productTitle,
          productHandle,
          productImageSrc,
          variantTitle,
          variantPrice,
          variantId: String(row.variant_id),
          productId: String(row.product_id)
        });
      }

    } catch (err) {
      ctx.logger.error({ err: err.message }, 'Unhandled error in back-in-stock handler');
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE inventory_state (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  inventory_item_id    BIGINT NOT NULL,
  last_known_available INTEGER,
  updated_at           TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_invstate_tenant_item UNIQUE (tenant_id, inventory_item_id)
);

ALTER TABLE inventory_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_state_tenant_isolation ON inventory_state
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE TABLE back_in_stock_subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  variant_id        BIGINT NOT NULL,
  inventory_item_id BIGINT NOT NULL,
  product_id        BIGINT NOT NULL,
  customer_id       BIGINT,
  customer_email    TEXT NOT NULL,
  subscribed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bis_tenant_variant_email UNIQUE (tenant_id, variant_id, customer_email)
);

ALTER TABLE back_in_stock_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY back_in_stock_subscriptions_tenant_isolation ON back_in_stock_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_bis_tenant_inventory_item_pending
  ON back_in_stock_subscriptions (tenant_id, inventory_item_id)
  WHERE notified_at IS NULL;

CREATE INDEX idx_bis_tenant_variant_email
  ON back_in_stock_subscriptions (tenant_id, variant_id, customer_email);
```

### widget.js

```javascript
export function mount(container, host) {
  const handle = location.pathname.match(/\/products\/([^/?#]+)/)?.[1];
  if (!handle) return;

  const variantIdFromUrl = new URLSearchParams(location.search).get('variant');
  const { customerId } = host.context;

  let resolvedVariantId = null;
  let resolvedProductId = null;
  let isSubscribed = false;

  function renderLoading() {
    container.innerHTML = '';
  }

  function renderNothing() {
    container.innerHTML = '';
  }

  function renderForm(alreadySubscribed = false, success = false) {
    container.innerHTML = '';

    if (alreadySubscribed) {
      const msg = document.createElement('p');
      msg.style.cssText = 'font-size:14px;color:#555;margin:8px 0;';
      msg.textContent = 'You are already signed up for notifications on this product.';
      container.appendChild(msg);
      return;
    }

    if (success) {
      const msg = document.createElement('p');
      msg.style.cssText = 'font-size:14px;color:#2e7d32;margin:8px 0;';
      msg.textContent = 'You will be notified when this is back in stock.';
      container.appendChild(msg);
      return;
    }

    if (isSubscribed) {
      const msg = document.createElement('p');
      msg.style.cssText = 'font-size:14px;color:#555;margin:8px 0;';
      msg.textContent = 'You are signed up for notifications on this variant.';
      container.appendChild(msg);
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:8px;max-width:400px;margin:8px 0;';

    const label = document.createElement('label');
    label.style.cssText = 'font-size:14px;color:#333;font-weight:500;';
    label.textContent = 'Get notified when this is back in stock:';

    const form = document.createElement('form');
    form.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.name = 'customerEmail';
    emailInput.placeholder = 'Enter your email';
    emailInput.required = true;
    emailInput.style.cssText = 'flex:1;min-width:180px;padding:8px 12px;border:1px solid #ccc;border-radius:4px;font-size:14px;';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.textContent = 'Notify Me';
    submitBtn.style.cssText = 'padding:8px 16px;background:#333;color:#fff;border:none;border-radius:4px;font-size:14px;cursor:pointer;white-space:nowrap;';

    const errorMsg = document.createElement('p');
    errorMsg.style.cssText = 'font-size:13px;color:#c62828;margin:0;display:none;width:100%;';

    form.appendChild(emailInput);
    form.appendChild(submitBtn);
    form.appendChild(errorMsg);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = host.getFormData(form);
      const customerEmail = data.customerEmail;

      if (!customerEmail) {
        errorMsg.textContent = 'Please enter a valid email address.';
        errorMsg.style.display = 'block';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
      errorMsg.style.display = 'none';

      try {
        const result = await host.call('/subscribe', {
          customerEmail,
          variantId: resolvedVariantId,
          productId: resolvedProductId,
        });

        if (result.alreadySubscribed) {
          renderForm(true, false);
        } else if (result.success) {
          renderForm(false, true);
        } else {
          errorMsg.textContent = 'Something went wrong. Please try again.';
          errorMsg.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Notify Me';
        }
      } catch (err) {
        errorMsg.textContent = 'Something went wrong. Please try again.';
        errorMsg.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Notify Me';
      }
    });

    wrapper.appendChild(label);
    wrapper.appendChild(form);
    container.appendChild(wrapper);
  }

  async function init() {
    let productData;
    try {
      productData = await host.storefront('/products/' + handle + '.js');
    } catch (e) {
      renderNothing();
      return;
    }

    if (!productData) {
      renderNothing();
      return;
    }

    const variant = variantIdFromUrl
      ? (productData.variants.find(v => String(v.id) === String(variantIdFromUrl)) ?? productData.variants[0])
      : productData.variants[0];

    const isOutOfStock = !variant.available;
    resolvedVariantId = String(variant.id);
    resolvedProductId = String(productData.id);

    if (!isOutOfStock) {
      renderNothing();
      return;
    }

    // Check subscription status
    try {
      const statusResult = await host.call('/subscription-status', {
        variantId: resolvedVariantId,
        customerId: customerId,
      });
      isSubscribed = statusResult.isSubscribed === true;
    } catch (e) {
      isSubscribed = false;
    }

    renderForm(false, false);
  }

  init();
}
```


## Error

```
validation failed after 3 attempts: {'handler': ["widget sends field(s) ['resolvedProductId', 'resolvedVariantId'] to '/subscribe' but handler destructures ['customerEmail', 'productId', 'variantId'] from ctx.widgetBody — field name mismatch. The codeSpec.widgetPath is the ground truth: align both sides to it.", "widget sends field(s) ['resolvedVariantId'] to '/subscription-status' but handler destructures ['customerId', 'variantId'] from ctx.widgetBody — field name mismatch. The codeSpec.widgetPath is the ground truth: align both sides to it."], 'widget_js': ["widget sends field(s) ['resolvedProductId', 'resolvedVariantId'] to '/subscribe' but handler destructures ['customerEmail', 'productId', 'variantId'] from ctx.widgetBody — field name mismatch. The codeSpec.widgetPath is the ground truth: align both sides to it.", "widget sends field(s) ['resolvedVariantId'] to '/subscription-status' but handler destructures ['customerId', 'variantId'] from ctx.widgetBody — field name mismatch. The codeSpec.widgetPath is the ground truth: align both sides to it."]}
```
