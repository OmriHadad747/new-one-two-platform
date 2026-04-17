"""
Webhook-path handler patterns.

Injected by handler_agent.py's JIT into the USER prompt when
``shopifyPlan.webhookTopics`` is non-empty. Covers idempotency, atomic
side-effect claiming with RETURNING, tenant scoping, and the bulk-prefetch
discipline for webhook handlers that enrich multiple records.
"""

HARNESS_SECTION_WEBHOOK = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WEBHOOK PATTERNS — this handler subscribes to at-least-once delivery webhooks:

Rule: INSERT operations triggered by a webhook must guard against replay:
  ✅ await ctx.db`INSERT INTO t (...) VALUES (...) ON CONFLICT (tenant_id, key) DO NOTHING`
  ❌ Plain INSERT — fails or duplicates on webhook replay

Rule: When performing a side effect (notification, tag update, log emission) based on DB
state, atomically claim the work with RETURNING — THEN act on the returned rows.
NEVER emit first and mark after; a crash between those two steps causes double-execution.
  ✅ const claimed = await ctx.db`
       UPDATE my_table SET notified_at = NOW()
       WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${ids}) AND notified_at IS NULL
       RETURNING id, customer_email, customer_first_name
     `
     if (claimed.length === 0) return  // already processed — do not proceed
     for (const row of claimed) { /* emit/log side effect using row data */ }
  ❌ fetch rows → emit side effects → mark as done   (crash window between emit and mark)
  ❌ UPDATE without RETURNING + length check          (allows double-execution on replay)

Rule: Every SELECT in the webhook path MUST be scoped to ctx.tenantId AND to the specific
  entity from the payload. Never query all pending rows across all tenants or all entities.
  ✅ WHERE tenant_id = ${ctx.tenantId} AND variant_id = ${variantId}
  ❌ WHERE notified_at IS NULL  // missing tenant_id scope — cross-tenant data leak

Rule: When the webhook handler must enrich data for multiple items found in the DB
(e.g. fetching product details to compose notification emails after a state transition),
apply the same pre-fetch discipline as the cron path — batch ALL Shopify calls before
any loop, never per-item:
  ✅ // 1. Query DB for pending items — include all IDs needed for batch lookup
     const pending = await ctx.db`SELECT DISTINCT variant_id, product_id FROM ... WHERE ...`
     // 2. Collect distinct Shopify entity IDs
     const productIds = [...new Set(pending.map(r => String(r.product_id)))]
     // 3. Batch-fetch Shopify data (max 250 per call for products)
     const infoMap = {}
     for (let i = 0; i < productIds.length; i += 250) {
       const chunk = productIds.slice(i, i + 250)
       const { products } = await ctx.shopify.get(
         `/products.json?ids=${chunk.join(',')}&fields=id,title,handle,variants`
       )
       for (const p of products)
         for (const v of p.variants)
           infoMap[String(v.id)] = { variantTitle: v.title, productTitle: p.title, productHandle: p.handle }
     }
     // 4. Process loop — zero Shopify calls
     for (const row of pending) {
       const info = infoMap[String(row.variant_id)]
       if (!info) continue
       // claim rows and send notifications using info
     }
  ❌ for (const id of ids) { await ctx.shopify.get(`/variants/${id}.json`) }  // N sequential calls
  NOTE: All foreign-key IDs needed for batch lookup (e.g. product_id) MUST be stored
  in the DB table — SELECT them alongside the primary entity ID.
"""
