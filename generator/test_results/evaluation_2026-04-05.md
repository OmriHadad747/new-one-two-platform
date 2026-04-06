# Generator Output Evaluation — 2026-04-05

Two runs evaluated:
- `2026-04-05T23-44-53` — Notify Me When Back In Stock (`storefront_backend_admin`)
- `2026-04-05T23-48-31` — Image Store Optimization (`cron_admin`)

---

## Run 1: Notify Me When Back In Stock

**Status:** SUCCESS | **Time:** 231s | **Validation:** passed (25ms)

### What worked
- Field contracts across all 7 call paths are perfectly consistent (widget/admin ↔ handler)
- GraphQL used correctly: `inventoryItem(id: gid://shopify/InventoryItem/${id}) → variant.legacyResourceId` — the exact pattern we added guidance for
- Atomic subscriber claim via `UPDATE ... RETURNING` prevents double-notification under concurrent webhooks
- Inventory state table with baseline-establishment and 0→N transition detection is correct
- Batch product fetch in `/subscribers` (deduplicates IDs, chunks at 250) — no N+1
- RLS on all three tables, proper unique constraints

### Bugs

#### 1. `notify_once_per_subscriber` config flag is fetched but never enforced (functional)

The webhook handler fetches `notify_once_per_subscriber` from `bis_config` but silently discards it — no variable is assigned, no branching logic uses it. The claim query unconditionally filters `AND notified_at IS NULL`, which hard-codes "notify once" behavior regardless of config. The toggle in the admin Settings tab does nothing at runtime.

The `false` case (re-notify on every restock) requires either: clearing `notified_at` before the claim, or using a separate `notified_count` approach. Neither is implemented.

**Fix direction:** When `notify_once_per_subscriber === false`, the claim query should include previously-notified subscribers (drop the `notified_at IS NULL` condition or reset it first). The codeSpec agent should be instructed that config values fetched must be used in actual branching logic, not just selected.

#### 2. Guest users cannot see "already subscribed" state on return visits (UX)

The widget `/status` check uses `customer_id` to identify the subscriber, but guests have no `customer_id`. The handler returns `{ alreadySubscribed: false }` for any call where `!customerId`. A guest who already subscribed will see the form again on their next visit.

The re-submit is handled correctly (ON CONFLICT DO NOTHING → `alreadySubscribed: true`), so no data duplication occurs. But the preemptive status check is useless for the majority of storefront visitors who are not logged in.

**Fix direction:** For guest status checks, fall back to `customer_email` if available (e.g., from a cookie or local storage stored after subscribe), or accept that status checks are only meaningful for logged-in customers and skip the call when `!customerId`.

#### 3. Dead code in admin_ui.js

Line ~875:
```js
container.getElementById ? null : null;
```
Harmless but looks like a half-written conditional that was never completed. Should be removed.

### Minor observations
- `updated_at` column in `back_in_stock_subscriptions` is declared but never written after INSERT (only `notified_at` is updated). The column is present but stale.
- `notify_once_per_subscriber` is never read in the webhook path even though it's selected in the SQL.

---

## Run 2: Image Store Optimization

**Status:** SUCCESS | **Time:** 124s | **Validation:** passed (13ms)

### What worked
- Staged upload → `productCreateMedia` GraphQL flow is architecturally correct
- GID format correct: `gid://shopify/Product/${productId}`
- Resize logic correct: `fit: 'inside', withoutEnlargement: true` preserves aspect ratio and doesn't upscale
- Fire-and-forget `/run` admin path (returns immediately, optimization runs in background)
- Admin UI stat cards + log table are clean and functional

### Bugs

#### 1. Original image deletion is broken — images will accumulate (critical)

After uploading the optimized version, the handler attempts:
```js
await ctx.shopify.post(`/products/${productId}/images/${imageId}/delete.json`, {});
```
The Shopify REST image delete endpoint requires HTTP DELETE, not POST. `ctx.shopify.post` sends a POST, which returns a 404 or method-not-allowed. The comment in the code acknowledges the problem: *"Note: The harness uses ctx.shopify.post for all mutations including DELETE"* — but this is an incorrect assumption about the harness surface.

Result: every optimization run uploads a new optimized image but leaves the original intact. Products accumulate duplicate images on every run.

**Fix direction:** Use the GraphQL `productDeleteMedia` mutation instead, which takes the media GID. The handler already has the product GID. After `productCreateMedia` succeeds and returns the new `media[0].id`, the original image's GID (`gid://shopify/MediaImage/${imageId}`) should be deleted via:
```graphql
mutation ProductDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
  productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
    deletedMediaIds
    mediaUserErrors { field message }
  }
}
```
The harness_contract.py and architect/codespec prompts need to make clear that image/media deletion must go through GraphQL, not REST POST.

#### 2. Pagination silently stops on stores with ≥250 products

The handler reads the `Link` header via `response._headers['link']`. If the harness doesn't expose response headers on the ctx.shopify.get() response object (which is likely — the ctx returns only the parsed JSON body), `linkHeader` is `undefined`, the code falls to:
```js
if (response.products.length < 250) hasNextPage = false;
else hasNextPage = false; // Can't paginate without link header
```
Both branches stop. Any store with 250 or more products is silently truncated after the first page.

**Fix direction:** Use cursor-based pagination via GraphQL `products` query (which supports `after: $cursor` and returns `pageInfo.hasNextPage`) instead of relying on REST Link headers. The codespec agent should be guided to prefer GraphQL for paginated product scans.

#### 3. No rate limiting between images — will hit API rate limits on large stores

There is no delay between processing each image. Each iteration does: 1 HTTP download, 1 GraphQL `stagedUploadsCreate`, 1 HTTP upload, 1 GraphQL `productCreateMedia`, 1 GraphQL `productDeleteMedia` (if fixed). For a store with 500 images this is ~2500 API calls fired as fast as possible. The generator even wrote a `sleep()` function for this purpose but never used it (the busy-wait implementation is also wrong — it blocks the event loop).

The code comment says: *"The spec says 'await delay(500ms)' but we cannot use setTimeout."* This is a false constraint — `setTimeout` is available in the Node.js handler runtime.

**Fix direction:** Add a simple `await new Promise(r => setTimeout(r, 200))` between images. The harness_contract.py should clarify that `setTimeout` / `Promise`-based delays are available in the handler runtime.

#### 4. No concurrency guard on `/run` — parallel runs are possible

The `/run` admin path fires `runOptimization()` as fire-and-forget. Multiple clicks or multiple cron firings can launch concurrent runs that process the same images simultaneously. The `ON CONFLICT ... DO UPDATE` in `upsertOptimization` handles DB races, but parallel Shopify API calls for the same image IDs will cause duplicate media uploads.

**Fix direction:** Use the DB to gate concurrent runs — insert a `job_state` row with a lock on start, or check `MAX(optimized_at)` age before proceeding.

### Minor observations
- The busy-wait `sleep()` function (lines 154–164) should be removed entirely — it blocks the event loop and is never called.
- `updated_at` column in `image_optimizations` is declared but never updated (same pattern as Run 1).
- The `/log` endpoint hardcodes `LIMIT 100` server-side but the admin UI also slices to 50 client-side — inconsistent and confusing. Should be consistent.
- `mimeType` detection in `downloadAndInspectImage` only distinguishes png vs jpeg. WebP, GIF, AVIF images will all get `image/jpeg` MIME type, then be converted to JPEG on resize. Acceptable but worth noting.

---

## Cross-cutting issues to fix in the generator

| Issue | Affects | Fix location |
|-------|---------|--------------|
| Config values fetched but not used in branching | BIS notify_once | codeSpec prompt: "every config field selected must appear in a conditional" |
| No HTTP DELETE method in ctx → GraphQL must be used for deletions | Image optimizer | `harness_contract.py`: add note that DELETE operations must use GraphQL mutations (productDeleteMedia, fileDelete, etc.) |
| REST pagination via Link headers is unreliable | Image optimizer | `architect_agent.py` / `codespec_agent.py`: for full-catalog scans, require GraphQL cursor pagination |
| `setTimeout` false constraint | Image optimizer | `harness_contract.py`: clarify that `setTimeout`, `Promise`, and `Buffer` are available in the handler runtime |
| No concurrency guard for long-running background jobs | Image optimizer | architect/codespec: for fire-and-forget `/run` patterns, include a "running" lock in DB |
