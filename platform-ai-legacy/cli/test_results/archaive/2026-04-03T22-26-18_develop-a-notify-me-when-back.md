# Feature Generator — Run Result

**Date:** 2026-04-03 22:26:18  
**Status:** ✅ SUCCESS  
**Total:** 150568ms  
**Prompt:** Develop a Notify Me When Back In Stock Shopify app.

## Pipeline

| Agent       | Status | Time       | Notes |
|-------------|--------|------------|-------|
| Product     | ✓      | 3577ms     | archetype=?  trigger=? |
| Architect   | ✓      | 19732ms    | complexity=high  topics=['inventory_levels/update']  cron=—  stateMachine=yes |
| CodeSpec    | ✓      | 48650ms    | webhook=39 steps  cron=0 steps  widget=32 steps  functions=3 |
| CodeGen     | ✓      | 63521ms    | attempt 1  handler ✓  migration ✓  widget_js ✓ |
| Explanation | ✓      | 15067ms    |  |

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
  "desiredOutcome": "Customers can sign up for restock alerts on out-of-stock products, and automatically receive an email notification when the item becomes available again.",
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
        "description": "Widget GET: fetch variant details to resolve inventory_item_id from variantId (server-side resolution only)",
        "protocol": "rest",
        "method": "GET",
        "path": "/admin/api/2026-01/variants/{variantId}.json",
        "bodyExample": null
      },
      {
        "step": 2,
        "description": "Webhook handler: fetch inventory level for the updated inventory_item_id + location to confirm quantity > 0",
        "protocol": "rest",
        "method": "GET",
        "path": "/admin/api/2026-01/inventory_levels.json?inventory_item_ids={inventoryItemId}",
        "bodyExample": null
      },
      {
        "step": 3,
        "description": "Webhook handler: fetch product and variant details (title, image, URL) to populate notification email",
        "protocol": "graphql",
        "operationType": "query",
        "operationHint": "inventoryItem(id: $inventoryItemId) { variant { id title product { id title handle featuredImage { url } } } }"
      },
      {
        "step": 4,
        "description": "Admin dashboard GET: fetch subscriber rows from DB \u2014 no Shopify call needed, DB-only read"
      }
    ]
  },
  "implementationSpec": {
    "complexity": "high",
    "stateMachine": {
      "needsStateTracking": true,
      "trackedEntity": "last_known_available column (BOOLEAN NULLABLE) on restock_subscriptions table, keyed by tenant_id + inventory_item_id",
      "unknownSentinel": "null",
      "skipWhenUnknown": true,
      "skipRationale": "If we have never observed the inventory state for a given item, we cannot confirm an out-to-in-stock transition and must skip to avoid false notifications on first webhook receipt."
    },
    "platformGaps": [],
    "cronBatching": null,
    "migrationGuidance": "Create table restock_subscriptions with columns: id UUID PK, tenant_id UUID NOT NULL, inventory_item_id BIGINT NOT NULL, variant_id BIGINT NOT NULL, product_id BIGINT NOT NULL, customer_id BIGINT (nullable \u2014 guests have no Shopify customer ID), customer_email TEXT NOT NULL, last_known_available BOOLEAN NULL (null = never observed), notified_at TIMESTAMPTZ NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(). Apply CONSTRAINT uq_restock_sub UNIQUE (tenant_id, inventory_item_id, customer_email) to deduplicate signups and enable ON CONFLICT DO NOTHING. Add index on (tenant_id, inventory_item_id) for fast webhook fan-out lookup. last_known_available NULL means sentinel \u2014 never observed; do NOT default to FALSE.",
    "widgetGuidance": "Show a simple 'Notify Me' email form only when the variant is out of stock (detected via host.storefront()); on submission display 'You'll be notified when this is back in stock' \u2014 never imply the email was sent immediately since notification is deferred to the restock webhook.",
    "storefrontReads": [
      {
        "path": "/variants/${variantId}.js",
        "dataUsed": "variant.available (boolean) \u2014 widget reads this to conditionally render the Notify Me form only when the selected variant is out of stock"
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
              "customerEmail": "example@example.com",
              "productTitle": "Example Product",
              "variantTitle": "Size M / Blue",
              "inventoryItemId": 0,
              "variantId": 0,
              "notifiedAt": null,
              "createdAt": "2024-01-01T00:00:00Z"
            }
          ]
        }
      },
      {
        "method": "POST",
        "path": "/subscribers/delete",
        "responseShape": {
          "deleted": true
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
      "// ENTRY: topic = inventory_levels/update",
      "const { inventory_item_id, location_id, available } = ctx.payload",
      "if !ctx.payload.inventory_item_id: return  // required field missing",
      "// STEP 1: Confirm quantity > 0 via REST (source of truth for available quantity)",
      "invLevelsResp = GET /admin/api/2026-01/inventory_levels.json?inventory_item_ids=${inventory_item_id}",
      "if !invLevelsResp.inventory_levels || invLevelsResp.inventory_levels.length === 0: return  // no levels found",
      "storeWideTotal = sum of level.available across all entries in invLevelsResp.inventory_levels",
      "isNowAvailable = storeWideTotal > 0",
      "// STEP 2: Load all subscriber rows for this tenant + inventory_item_id",
      "subRows = SELECT id, customer_email, customer_id, variant_id, product_id, last_known_available, notified_at FROM restock_subscriptions WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventory_item_id}",
      "if subRows.length === 0: return  // no subscribers for this item \u2014 nothing to act on",
      "// STEP 3: Determine prior state from first row (all rows share same inventory_item_id, so last_known_available is consistent at tenant+item level)",
      "// Use the first row's last_known_available as the representative prior state for this inventory_item_id",
      "prevAvailable = subRows[0].last_known_available",
      "// STEP 4: Unconditionally update last_known_available for all subscriber rows for this tenant + inventory_item_id",
      "UPDATE restock_subscriptions SET last_known_available = ${isNowAvailable} WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventory_item_id}",
      "// STEP 5: Sentinel guard \u2014 if we have never observed state before, skip notifications",
      "if prevAvailable === null: return  // sentinel \u2014 cannot confirm out-to-in-stock transition without prior observation",
      "// STEP 6: Transition guard \u2014 only notify on out-to-in-stock transition",
      "if prevAvailable === true: return  // was already in stock \u2014 not a restock transition",
      "if isNowAvailable === false: return  // still out of stock \u2014 no transition",
      "// At this point: prevAvailable === false AND isNowAvailable === true \u2192 confirmed restock",
      "// STEP 7: Fetch product/variant details via GraphQL for email content",
      "gqlResp = GraphQL query: inventoryItem(id: 'gid://shopify/InventoryItem/${inventory_item_id}') { variant { id title product { id title handle featuredImage { url } } } }",
      "if !gqlResp.inventoryItem || !gqlResp.inventoryItem.variant: return  // variant not found or deleted",
      "variantNode = gqlResp.inventoryItem.variant",
      "productNode = variantNode.product",
      "variantTitle = variantNode.title",
      "productTitle = productNode.title",
      "productHandle = productNode.handle",
      "productFeaturedImageUrl = productNode.featuredImage?.url ?? null",
      "// crash here leaves state updated but notifications unsent \u2014 cron path is the backstop (no cron scheduled; webhook is sole delivery path, idempotency via notified_at)",
      "// STEP 8: Claim unsent notifications atomically for this inventory_item_id (only rows not yet notified)",
      "claimed = UPDATE restock_subscriptions SET notified_at = NOW() WHERE tenant_id = ${ctx.tenantId} AND inventory_item_id = ${inventory_item_id} AND notified_at IS NULL RETURNING id, customer_email",
      "if claimed.length === 0: return  // already notified \u2014 idempotency guard",
      "// STEP 9: Emit notification email for each claimed row",
      "for each row in claimed:",
      "  emit email to row.customer_email with data: { productTitle, variantTitle, productHandle, productFeaturedImageUrl }",
      "  // email template constructs product URL from productHandle e.g. /products/${productHandle}"
    ],
    "cronPath": [],
    "widgetPath": [
      "// === STOREFRONT READ (no backend call needed) ===",
      "widget: handle = location.pathname.match(/\\/products\\/([^/?#]+)/)?.[1]",
      "widget: variantId = new URLSearchParams(location.search).get('variant')",
      "widget calls host.storefront('/variants/' + variantId + '.js') \u2192 variantData  // only when variantId is non-null",
      "widget: if variantId is null, call host.storefront('/products/' + handle + '.js') \u2192 productData, then variantData = productData.variants[0]",
      "widget: isOutOfStock = !variantData.available",
      "widget: productId = String(variantData.product_id)",
      "widget: render 'Notify Me' email form only when isOutOfStock === true",
      "// === path /status ===",
      "path /status: widget reads customerId from host.context (null for guests)",
      "path /status: widget calls host.call('/status', { variantId, productId, customerId })",
      "path /status: handler: const { variantId, productId, customerId } = ctx.widgetBody",
      "path /status: handler: if !variantId: return { alreadySubscribed: false }  // required field missing",
      "path /status: handler: if customerId is null: return { alreadySubscribed: false }  // guest \u2014 cannot pre-identify",
      "path /status: handler: statusRows = SELECT id FROM restock_subscriptions WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variantId} AND customer_id = ${customerId} LIMIT 1",
      "path /status: handler: alreadySubscribed = statusRows.length > 0",
      "path /status: handler returns { alreadySubscribed: bool }; widget reads result.alreadySubscribed to hide form if already signed up",
      "// === path /signup ===",
      "path /signup: widget captures customerEmail from form input",
      "path /signup: widget reads customerId from host.context (null for guests)",
      "path /signup: widget calls host.call('/signup', { customerEmail, variantId, productId, customerId })",
      "path /signup: handler: const { customerEmail, variantId, productId, customerId } = ctx.widgetBody",
      "path /signup: handler: if !customerEmail || !variantId || !productId: return { success: false, alreadySubscribed: false }  // required fields missing",
      "path /signup: handler: validate customerEmail is a valid email format; if invalid return { success: false, alreadySubscribed: false }",
      "path /signup: handler: fetch variant to resolve inventory_item_id \u2014 GET /admin/api/2026-01/variants/${variantId}.json",
      "path /signup: handler: if !response.variant: return { success: false, alreadySubscribed: false }  // variant not found or deleted",
      "path /signup: handler: inventoryItemId = response.variant.inventory_item_id",
      "path /signup: handler: INSERT INTO restock_subscriptions (id, tenant_id, inventory_item_id, variant_id, product_id, customer_id, customer_email, last_known_available, notified_at, created_at) VALUES (gen_random_uuid(), ${ctx.tenantId}, ${inventoryItemId}, ${variantId}, ${productId}, ${customerId ?? NULL}, ${customerEmail}, NULL, NULL, NOW()) ON CONFLICT (tenant_id, inventory_item_id, customer_email) DO NOTHING RETURNING id",
      "path /signup: handler: alreadySubscribed = insertResult.length === 0  // conflict means duplicate",
      "path /signup: handler returns { success: true, alreadySubscribed: false } on new insert, { success: true, alreadySubscribed: true } on duplicate; widget checks result.alreadySubscribed before result.success",
      "path /signup: widget: if result.alreadySubscribed === true: display 'You are already signed up for notifications on this item'",
      "path /signup: widget: if result.alreadySubscribed === false && result.success === true: display 'You\\'ll be notified when this is back in stock'"
    ],
    "adminPath": [
      "// === path /subscribers (GET \u2014 list all subscribers) ===",
      "path /subscribers: admin panel calls bridge.call('/subscribers') with no body",
      "path /subscribers: handler: verify ctx.trigger === 'admin'",
      "path /subscribers: handler: rows = SELECT id, customer_email, variant_id, inventory_item_id, notified_at, created_at FROM restock_subscriptions WHERE tenant_id = ${ctx.tenantId} ORDER BY created_at DESC LIMIT 200",
      "path /subscribers: handler: if rows.length === 0: return { total: 0, rows: [] }",
      "path /subscribers: handler: collect distinct product_id values from rows; batch-fetch product+variant data from Shopify \u2014 GET /admin/api/2026-01/products.json?ids=<comma-separated-product-ids>&fields=id,title,variants \u2014 split into chunks of 250",
      "path /subscribers: handler: build productMap<product_id, productTitle> and variantMap<variant_id, variantTitle> from the batch response",
      "path /subscribers: handler: for each row in rows: resolve productTitle = productMap[row.product_id] ?? 'Unknown Product'; variantTitle = variantMap[row.variant_id] ?? 'Unknown Variant'",
      "path /subscribers: handler returns { total: rows.length, rows: [{ id, customerEmail: customer_email, productTitle, variantTitle, inventoryItemId: inventory_item_id, variantId: variant_id, notifiedAt: notified_at, createdAt: created_at }] }; panel renders table",
      "// === path /subscribers/delete (POST \u2014 delete a subscriber row) ===",
      "path /subscribers/delete: admin panel calls bridge.call('/subscribers/delete', { id }) where id is the UUID of the row to delete",
      "path /subscribers/delete: handler: verify ctx.trigger === 'admin'",
      "path /subscribers/delete: handler: const { id } = ctx.widgetBody",
      "path /subscribers/delete: handler: if !id: return { deleted: false }  // required field missing",
      "path /subscribers/delete: handler: deleteResult = DELETE FROM restock_subscriptions WHERE tenant_id = ${ctx.tenantId} AND id = ${id} RETURNING id",
      "path /subscribers/delete: handler: if deleteResult.length === 0: return { deleted: false }  // row not found or already deleted",
      "path /subscribers/delete: handler returns { deleted: true }; panel removes row from table"
    ],
    "functions": [
      {
        "name": "resolveInventoryItemId",
        "steps": [
          "Accept variantId as argument",
          "resp = GET /admin/api/2026-01/variants/${variantId}.json",
          "if !resp.variant: return null  // variant not found or deleted",
          "return resp.variant.inventory_item_id"
        ]
      },
      {
        "name": "batchFetchProductVariantMap",
        "steps": [
          "Accept productIds (array of BIGINT) as argument",
          "if productIds.length === 0: return { productMap: {}, variantMap: {} }",
          "Split productIds into chunks of 250",
          "productMap = {}; variantMap = {}",
          "for each chunk: resp = GET /admin/api/2026-01/products.json?ids=<comma-joined chunk>&fields=id,title,variants",
          "if !resp.products: continue",
          "for each product in resp.products: productMap[product.id] = product.title",
          "for each variant in product.variants: variantMap[variant.id] = variant.title",
          "return { productMap, variantMap }"
        ]
      },
      {
        "name": "emitRestockEmail",
        "steps": [
          "Accept customerEmail, productTitle, variantTitle, productHandle, productFeaturedImageUrl as arguments",
          "Construct email payload with fields: { to: customerEmail, subject: productTitle + ' is back in stock', data: { productTitle, variantTitle, productHandle, productFeaturedImageUrl } }",
          "// email template constructs product URL from productHandle: /products/${productHandle}",
          "Dispatch email via configured email provider"
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
    try {
      // ── WIDGET PATH ──────────────────────────────────────────────────────────
      if (ctx.trigger === 'widget') {
        const path = ctx.widgetPath;

        if (path === '/status') {
          const { variantId, productId, customerId } = ctx.widgetBody || {};
          if (!variantId) return { alreadySubscribed: false };
          if (!customerId) return { alreadySubscribed: false };
          const statusRows = await ctx.db`
            SELECT id FROM restock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
              AND variant_id = ${variantId}
              AND customer_id = ${customerId}
            LIMIT 1
          `;
          return { alreadySubscribed: statusRows.length > 0 };
        }

        if (path === '/signup') {
          const { customerEmail, variantId, productId, customerId } = ctx.widgetBody || {};
          if (!customerEmail || !variantId || !productId) {
            return { success: false, alreadySubscribed: false };
          }
          // Validate email format
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(customerEmail)) {
            return { success: false, alreadySubscribed: false };
          }
          // Resolve inventory_item_id from variantId
          let inventoryItemId;
          try {
            const varResp = await ctx.shopify.get(`/variants/${variantId}.json`);
            if (!varResp.variant) return { success: false, alreadySubscribed: false };
            inventoryItemId = varResp.variant.inventory_item_id;
          } catch (err) {
            ctx.logger.error({ err, variantId }, 'Failed to fetch variant for signup');
            return { success: false, alreadySubscribed: false };
          }
          // Insert with conflict guard
          const insertResult = await ctx.db`
            INSERT INTO restock_subscriptions
              (id, tenant_id, inventory_item_id, variant_id, product_id, customer_id,
               customer_email, last_known_available, notified_at, created_at)
            VALUES
              (gen_random_uuid(), ${ctx.tenantId}, ${inventoryItemId}, ${variantId},
               ${productId}, ${customerId ?? null}, ${customerEmail},
               NULL, NULL, NOW())
            ON CONFLICT (tenant_id, inventory_item_id, customer_email) DO NOTHING
            RETURNING id
          `;
          const alreadySubscribed = insertResult.length === 0;
          return { success: true, alreadySubscribed };
        }

        return { error: 'unknown path' };
      }

      // ── ADMIN PATH ───────────────────────────────────────────────────────────
      if (ctx.trigger === 'admin') {
        const path = ctx.widgetPath;

        if (path === '/subscribers') {
          const rows = await ctx.db`
            SELECT id, customer_email, variant_id, product_id, inventory_item_id,
                   notified_at, created_at
            FROM restock_subscriptions
            WHERE tenant_id = ${ctx.tenantId}
            ORDER BY created_at DESC
            LIMIT 200
          `;
          if (rows.length === 0) return { total: 0, rows: [] };

          // Batch-fetch product/variant data
          const productIds = [...new Set(rows.map(r => String(r.product_id)))];
          const productMap = {};
          const variantMap = {};
          const PRODUCT_BATCH = 250;
          for (let i = 0; i < productIds.length; i += PRODUCT_BATCH) {
            const chunk = productIds.slice(i, i + PRODUCT_BATCH);
            let resp;
            try {
              resp = await ctx.shopify.get(
                `/products.json?ids=${chunk.join(',')}&fields=id,title,variants`
              );
            } catch (err) {
              ctx.logger.error({ err }, 'Failed to fetch products for admin subscribers');
              continue;
            }
            if (!resp.products) continue;
            for (const product of resp.products) {
              productMap[String(product.id)] = product.title;
              for (const variant of (product.variants || [])) {
                variantMap[String(variant.id)] = variant.title;
              }
            }
          }

          const resultRows = rows.map(row => ({
            id: row.id,
            customerEmail: row.customer_email,
            productTitle: productMap[String(row.product_id)] || 'Unknown Product',
            variantTitle: variantMap[String(row.variant_id)] || 'Unknown Variant',
            inventoryItemId: row.inventory_item_id,
            variantId: row.variant_id,
            notifiedAt: row.notified_at,
            createdAt: row.created_at,
          }));

          return { total: resultRows.length, rows: resultRows };
        }

        if (path === '/subscribers/delete') {
          const { id } = ctx.widgetBody || {};
          if (!id) return { deleted: false };
          const deleteResult = await ctx.db`
            DELETE FROM restock_subscriptions
            WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
            RETURNING id
          `;
          if (deleteResult.length === 0) return { deleted: false };
          ctx.logger.info({ id }, 'Deleted restock subscription');
          return { deleted: true };
        }

        return { error: 'unknown path' };
      }

      // ── WEBHOOK PATH: inventory_levels/update ────────────────────────────────
      ctx.logger.info({ trigger: ctx.trigger, inventory_item_id: ctx.payload.inventory_item_id }, 'inventory_levels/update received');

      const { inventory_item_id } = ctx.payload;
      if (!inventory_item_id) {
        ctx.logger.warn('Missing inventory_item_id in payload — skipping');
        return;
      }

      // STEP 1: Confirm store-wide quantity via REST
      let storeWideTotal = 0;
      let invLevelsResp;
      try {
        invLevelsResp = await ctx.shopify.get(
          `/inventory_levels.json?inventory_item_ids=${inventory_item_id}`
        );
      } catch (err) {
        ctx.logger.error({ err, inventory_item_id }, 'Failed to fetch inventory levels');
        return;
      }
      if (!invLevelsResp.inventory_levels || invLevelsResp.inventory_levels.length === 0) {
        ctx.logger.info({ inventory_item_id }, 'No inventory levels found — skipping');
        return;
      }
      for (const level of invLevelsResp.inventory_levels) {
        storeWideTotal += (level.available || 0);
      }
      const isNowAvailable = storeWideTotal > 0;

      // STEP 2: Load subscriber rows for this inventory_item_id
      const subRows = await ctx.db`
        SELECT id, customer_email, customer_id, variant_id, product_id, last_known_available, notified_at
        FROM restock_subscriptions
        WHERE tenant_id = ${ctx.tenantId}
          AND inventory_item_id = ${inventory_item_id}
      `;
      if (subRows.length === 0) {
        ctx.logger.info({ inventory_item_id }, 'No subscribers for this inventory item — skipping');
        return;
      }

      // STEP 3: Determine prior state
      const prevAvailable = subRows[0].last_known_available;

      // STEP 4: Unconditionally update last_known_available for all rows
      await ctx.db`
        UPDATE restock_subscriptions
        SET last_known_available = ${isNowAvailable}
        WHERE tenant_id = ${ctx.tenantId}
          AND inventory_item_id = ${inventory_item_id}
      `;

      // STEP 5: Sentinel guard — never observed before
      if (prevAvailable === null) {
        ctx.logger.info({ inventory_item_id }, 'First observation — baseline set, skipping notifications');
        return;
      }

      // STEP 6: Transition guard
      if (prevAvailable === true) {
        ctx.logger.info({ inventory_item_id }, 'Was already in stock — not a restock transition');
        return;
      }
      if (!isNowAvailable) {
        ctx.logger.info({ inventory_item_id }, 'Still out of stock — no transition');
        return;
      }

      ctx.logger.info({ inventory_item_id }, 'Out-to-in-stock transition confirmed — fetching product details');

      // STEP 7: Fetch product/variant details via GraphQL
      let gqlResp;
      try {
        gqlResp = await ctx.shopify.graphql(
          `query GetInventoryItem($id: ID!) {
            inventoryItem(id: $id) {
              variant {
                id
                title
                product {
                  id
                  title
                  handle
                  featuredImage {
                    url
                  }
                }
              }
            }
          }`,
          { id: `gid://shopify/InventoryItem/${inventory_item_id}` }
        );
      } catch (err) {
        ctx.logger.error({ err, inventory_item_id }, 'GraphQL query for inventoryItem failed');
        return;
      }

      if (!gqlResp.inventoryItem || !gqlResp.inventoryItem.variant) {
        ctx.logger.warn({ inventory_item_id }, 'Variant not found in GraphQL response — skipping');
        return;
      }

      const variantNode = gqlResp.inventoryItem.variant;
      const productNode = variantNode.product;
      const variantTitle = variantNode.title;
      const productTitle = productNode.title;
      const productHandle = productNode.handle;
      const productFeaturedImageUrl = productNode.featuredImage ? productNode.featuredImage.url : null;

      // STEP 8: Atomically claim unsent notifications
      const claimed = await ctx.db`
        UPDATE restock_subscriptions
        SET notified_at = NOW()
        WHERE tenant_id = ${ctx.tenantId}
          AND inventory_item_id = ${inventory_item_id}
          AND notified_at IS NULL
        RETURNING id, customer_email
      `;

      if (claimed.length === 0) {
        ctx.logger.info({ inventory_item_id }, 'All notifications already claimed — idempotency guard');
        return;
      }

      ctx.logger.info({ inventory_item_id, claimedCount: claimed.length }, 'Sending restock notifications');

      // STEP 9: Emit notification emails
      for (const row of claimed) {
        try {
          await ctx.email.send({
            to: row.customer_email,
            subject: `${productTitle} is back in stock`,
            data: { productTitle, variantTitle, productHandle, productFeaturedImageUrl },
          });
        } catch (err) {
          ctx.logger.error({ err, customerEmail: row.customer_email }, 'Failed to send restock email');
        }
      }

    } catch (err) {
      ctx.logger.error({ err }, 'Unhandled error in restock handler');
    }
  }
};
```

### migration.sql

```sql
CREATE TABLE restock_subscriptions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL,
  inventory_item_id   BIGINT      NOT NULL,
  variant_id          BIGINT      NOT NULL,
  product_id          BIGINT      NOT NULL,
  customer_id         BIGINT,
  customer_email      TEXT        NOT NULL,
  last_known_available BOOLEAN,
  notified_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_restock_sub UNIQUE (tenant_id, inventory_item_id, customer_email)
);

ALTER TABLE restock_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY restock_subscriptions_tenant_isolation ON restock_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_restock_subscriptions_tenant_inventory
  ON restock_subscriptions (tenant_id, inventory_item_id);

CREATE INDEX idx_restock_subscriptions_tenant_variant_customer
  ON restock_subscriptions (tenant_id, variant_id, customer_id);
```

### widget.js

```javascript
export function mount(container, host) {
  container.innerHTML = `
    <div id="restock-widget" style="font-family: sans-serif; margin: 16px 0;">
      <div id="restock-loading" style="color: #888; font-size: 14px;">Checking availability...</div>
      <div id="restock-form-area" style="display:none;"></div>
      <div id="restock-message" style="display:none;"></div>
    </div>
  `;

  const loadingEl = container.querySelector('#restock-loading');
  const formArea = container.querySelector('#restock-form-area');
  const messageEl = container.querySelector('#restock-message');

  function showMessage(text, color) {
    loadingEl.style.display = 'none';
    formArea.style.display = 'none';
    messageEl.style.display = 'block';
    messageEl.style.color = color || '#333';
    messageEl.style.fontSize = '14px';
    messageEl.textContent = text;
  }

  function showForm(variantId, productId) {
    loadingEl.style.display = 'none';
    formArea.style.display = 'block';

    formArea.innerHTML = `
      <p style="margin: 0 0 10px; font-size: 15px; font-weight: 600; color: #333;">This item is currently out of stock.</p>
      <p style="margin: 0 0 12px; font-size: 14px; color: #555;">Sign up to be notified when it's back in stock.</p>
      <form id="restock-signup-form" style="display: flex; flex-direction: column; gap: 10px; max-width: 360px;">
        <input
          type="email"
          name="customerEmail"
          placeholder="Enter your email address"
          required
          style="padding: 10px 12px; font-size: 14px; border: 1px solid #ccc; border-radius: 4px; outline: none; box-sizing: border-box; width: 100%;"
        />
        <button
          type="submit"
          style="padding: 10px 16px; font-size: 14px; font-weight: 600; background-color: #1a1a1a; color: #fff; border: none; border-radius: 4px; cursor: pointer;"
        >Notify Me</button>
        <div id="restock-form-error" style="display:none; color: #c0392b; font-size: 13px;"></div>
      </form>
    `;

    const form = container.querySelector('#restock-signup-form');
    const errorEl = container.querySelector('#restock-form-error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const submitBtn = form.querySelector('button[type="submit"]');
      errorEl.style.display = 'none';
      errorEl.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Signing up...';

      const data = host.getFormData(form);
      const customerEmail = (data.customerEmail || '').trim();
      const customerId = host.context.customerId;

      if (!customerEmail) {
        errorEl.textContent = 'Please enter a valid email address.';
        errorEl.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Notify Me';
        return;
      }

      try {
        const result = await host.call('/signup', {
          customerEmail,
          variantId,
          productId,
          customerId,
        });

        if (result.alreadySubscribed === true) {
          showMessage('You are already signed up for notifications on this item.', '#555');
        } else if (result.alreadySubscribed === false && result.success === true) {
          showMessage("You'll be notified when this is back in stock.", '#2d6a2d');
        } else {
          errorEl.textContent = 'Something went wrong. Please try again.';
          errorEl.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Notify Me';
        }
      } catch (err) {
        errorEl.textContent = 'Something went wrong. Please try again.';
        errorEl.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Notify Me';
      }
    });
  }

  async function init() {
    const handle = location.pathname.match(/\/products\/([^/?#]+)/)?.[1];

    if (!handle) {
      loadingEl.style.display = 'none';
      return;
    }

    let variantData;

    try {
      const variantId = new URLSearchParams(location.search).get('variant');

      if (variantId) {
        variantData = await host.storefront('/variants/' + variantId + '.js');
      } else {
        const productData = await host.storefront('/products/' + handle + '.js');
        variantData = productData.variants[0];
      }
    } catch (err) {
      loadingEl.style.display = 'none';
      return;
    }

    if (!variantData) {
      loadingEl.style.display = 'none';
      return;
    }

    const isOutOfStock = !variantData.available;
    const variantId = String(variantData.id);
    const productId = String(variantData.product_id);

    if (!isOutOfStock) {
      loadingEl.style.display = 'none';
      return;
    }

    const customerId = host.context.customerId;

    try {
      const statusResult = await host.call('/status', {
        variantId,
        productId,
        customerId,
      });

      if (statusResult.alreadySubscribed === true) {
        showMessage('You are already signed up for notifications on this item.', '#555');
        return;
      }
    } catch (err) {
      // If status check fails, still show the form
    }

    showForm(variantId, productId);
  }

  init();
}
```


## Explanation

{'merchantFacing': 'This feature adds a "Notify Me" button to any product that\'s out of stock. When a shopper visits one of your product pages and sees an item they want is unavailable, they can enter their email address and tap the button to sign up for a restock alert. Their request is saved automatically, and no manual tracking on your part is needed.\n\nAs soon as that product\'s inventory is updated and stock becomes available again, the shopper will automatically receive an email letting them know the item is back. This happens in real time — the moment you (or your supplier) restocks the item in your store, the notification goes out without you having to do a thing. You can also view a list of all current subscribers for any product directly from your app\'s admin dashboard.\n\nNote: Sending the actual email notification requires an email service such as Klaviyo or SendGrid to be connected to your store. Without one of these, the sign-up widget will still collect customer interest, but the automated emails will not be delivered.', 'technical': {'webhookTopics': ['inventory_levels/update'], 'dbTables': ['restock_subscriptions'], 'estimatedMonthlyExecutions': 200, 'estimatedMonthlyCost': '$0.002'}}
