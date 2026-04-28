"""
gotchas.py — per-operation Shopify GraphQL pitfall registry.

Cross-cutting Shopify discipline (GIDs, userErrors, pagination, throttling)
is taught in `subagents/prompts/capabilities/shopify_graphql.py`. THIS file
captures the OP-SPECIFIC failure modes — things you can't generalise from
the cross-cutting rules: response-shape interfaces requiring narrowing,
async/polling completion semantics, deprecated fields, paired-endpoint
requirements, payload-shape mismatches that `tsc` cannot catch because the
template's `shopify.graphql()` returns `Promise<unknown>` (see
[platform-back/templates/handler/src/lib/shopify.ts](../../platform-back/templates/handler/src/lib/shopify.ts)).

Why this exists. The image-optimizer generation
(2026-04-28T20-38-51_automatically-optimize-and-store-product-images) shipped
a bundle that crashed at deploy / first run with three Shopify-specific bugs:
`fileCreate` response shape (handler read `image.url` directly off the union
return type without narrowing), `productUpdate.media.originalSource` passed
the staged-upload URL instead of the persisted file URL, and the staged URL
TTL caused broken admin-log thumbnails after 15 minutes. None of these were
catchable by static analysis (the GraphQL parser couldn't tell the model how
the response shape worked at runtime), and the architect prompt couldn't
generalise the rule. The registry below is the structural fix: per-op
teaching, JIT-injected when the architect declares the op.

How it's used. JIT-appended next to the approved-ops list in
`subagents/jit/handler.py`. Each op the architect declares in
`appContracts.shopifyGraphqlOperations.{admin,storefront}` is looked up; if
this file has gotchas for the op, they ship into the handler prompt under a
"Per-op pitfalls" header. Ops not in the registry are silently skipped — the
cross-cutting prompt is sufficient for ops with no documented pitfalls.

Ground truth. The 2026-04 schema in
`platform-ai/catalogs/shopify_admin/2026-04/schema.graphql` is the
authoritative source for response shapes, nullability, and field
deprecation. Quoted strings in the entries below (e.g. "Returns `null` until
`status` is `READY`") are copied verbatim from the schema's GraphQL
`description` annotations. When the schema bumps versions, re-verify each
entry against the new descriptions before relying on the wording.

Verification rounds.
  2026-04-28 round 1: registry seeded from schema descriptions + training
    data on the 2026-04 schema. ~22 ops, hand-written.
  2026-04-28 round 2: each high-stake claim cross-checked against the
    matching `https://shopify.dev/docs/api/admin-graphql/2026-04/mutations/<op>`
    page (the URLs are embedded in the schema descriptions). Corrections:
    dropped unverified specifics (~15-min staged-URL TTL, "S3 vs GCS"
    distinction, several speculative error-code names — those that weren't
    confirmed by either schema or docs were softened to "read the
    <ErrorCode> enum from the schema"). Additions found in docs: the
    `productCreateMedia` is now DEPRECATED ("Use productUpdate or
    productSet instead"); `inventoryAdjustQuantities` REQUIRES an
    `idempotencyKey` as of 2026-04 (per the `@idempotent` schema
    directive); `productSet` uses REPLACE-ALL semantics on list fields
    (silent-data-loss class for handlers that send incomplete arrays);
    `metafieldsSet` is ATOMIC (one bad row aborts the batch) and supports
    `compareDigest` for compare-and-set concurrency; `bulkOperationRunQuery`
    has a 5-connection / 2-level-nesting cap. Verbatim quotes are flagged
    in entries with "(docs verbatim:" or "per the docs:".

Maintenance contract.
  - Add an entry when a generation produces a runtime/deploy bug whose
    root cause is per-op behaviour the model didn't know.
  - Each pitfall: ≤2 sentences, names the FAILURE MODE first, then the
    correct pattern. Do NOT restate cross-cutting rules already in the
    static prompt (GID format, userErrors check, pagination, throttling).
  - Entry order within a list is reading order — put the most
    catastrophic / most likely failure first.
  - Op-name keys match exactly what the architect writes in
    `shopifyGraphqlOperations` (camelCase root mutation/query name —
    `fileCreate`, `stagedUploadsCreate`, `productUpdate`). Do NOT include
    the schema type prefix.
  - When in doubt about a specific number / limit, omit it rather than
    fabricate. "Use the helper `shopify.bulkQuery`" is safer than
    "Cap is N rows."
"""

from __future__ import annotations

from typing import Dict, Iterable, List


# ────────────────────────────────────────────────────────────────────────────
# Admin GraphQL operation gotchas
# ────────────────────────────────────────────────────────────────────────────

ADMIN_OP_GOTCHAS: Dict[str, List[str]] = {
    # ─── Files / media (the cluster that failed in 2026-04-28T20-38-51) ───
    "stagedUploadsCreate": [
        "Returns `stagedTargets: [StagedMediaUploadTarget]`. Per the docs: \"Send your files to the returned `url` using the provided `parameters` for authentication\" — then pass `target.resourceUrl` to `fileCreate`'s `originalSource`. The `parameters` array shape varies by resource type (file size is REQUIRED for `VIDEO` and `MODEL_3D` resources, optional for images); inspect, don't assume.",
        "Both `target.url` (upload destination) and `target.resourceUrl` (what fileCreate accepts) are described in the docs as \"secure, temporary upload URLs\" — short-lived. Do NOT pass either URL to ANY downstream Shopify mutation other than the immediately-following `fileCreate`. Do NOT store either in the DB. The persisted file URL only exists AFTER `fileCreate` runs and that file's `fileStatus` reaches `READY`.",
        "Filenames containing `/` are stripped by Shopify — `\"path/with/slashes.jpg\"` becomes just `\"slashes.jpg\"`. Pass clean filenames; otherwise the merchant sees mismatched names in the file library.",
        "`httpMethod` is read from the response (`StagedUploadHttpMethodType` is `PUT` or `POST` per the schema enum). The docs example shows POST, but the schema allows both — read it from each `target`, do not hardcode in the upload-request constructor.",
    ],
    "fileCreate": [
        "Returns `files: [File!]` — `File` is an INTERFACE union of `MediaImage`, `GenericFile`, `Video`, `Model3d`. To read concrete fields you MUST narrow with `... on MediaImage { id image { url } fileStatus mediaErrors { code message } }` (or the appropriate concrete type) inside the mutation selection set. Reading `files[0].image.url` directly without the inline fragment is undefined at runtime — `image` is not a field on the interface.",
        "MediaImage uploads complete asynchronously per the docs (\"Files are processed asynchronously. Check the fileStatus field to monitor processing completion\"). The schema-described `image: Image` field on MediaImage \"Returns null until status is READY\" — so to read the persistent CDN URL you must POLL `files(query: \"id:<gid>\")` until `fileStatus` is `READY`, or fail after a bounded timeout. Storing the staged-upload URL in the DB as the \"final URL\" produces broken thumbnails when the staged URL expires.",
        "The mutation-level `userErrors: [FilesUserError!]!` flags request-shape failures. PER-FILE outcomes live ON the returned File node — query `... on MediaImage { mediaErrors { code message } fileStatus }` (and the equivalent for Video/Model3d via `mediaErrors`) to detect files that uploaded but failed processing. A 200-OK mutation can return files with `fileStatus: FAILED`; without per-file checks those failures are silent.",
        "Maximum 250 files per batch. For larger batches, chunk the input. Duplicate filenames within a batch (or against existing files) are handled per the `duplicateResolutionMode` input — choose `APPEND_UUID`, `REPLACE`, or `RAISE_ERROR` deliberately rather than relying on the default.",
    ],
    "productCreateMedia": [
        "DEPRECATED in 2026-04. Shopify's docs say \"Use productUpdate or productSet instead\" — both accept a `media` input now and have stronger semantics. Use this op only when you must support API versions before media-on-product was available.",
        "When you DO use it: returns BOTH `mediaUserErrors: [MediaUserError!]!` (preferred — typed with discrete `code` enum) AND `userErrors: [UserError!]!` (the schema marks this @deprecated: \"Use mediaUserErrors instead.\"). Check `mediaUserErrors`, not `userErrors`, or you'll miss every media-specific failure.",
        "The `originalSource` on each CreateMediaInput must be a public URL Shopify can fetch — a freshly-staged-upload `resourceUrl` (from `stagedUploadsCreate`, used immediately) OR a public URL of an already-persisted file. Per the docs the mutation supports partial success (\"adds all valid files and returns errors for any invalid ones\"), so always iterate `mediaUserErrors` even when some media succeeded.",
        "Media attachment is asynchronous (the docs note: \"The media is asynchronously uploaded and associated with the product\"). Returned `media[]` may carry status `UPLOADED` or `PROCESSING` initially. Storefront visibility depends on `status: READY`. Mark handler-side rows as `pending` and let a downstream poll mark them `ready`.",
    ],

    # ─── Product mutations ────────────────────────────────────────────────
    "productUpdate": [
        "`product` is nullable in the response — when `userErrors[]` is non-empty the mutation failed and `product` is null. Always check `userErrors` first; never destructure `product.id` without a guard.",
        "Cannot update variants on this mutation. The docs say: \"Cannot update variants; use `productVariantsBulkUpdate` instead.\" Passing variant data here is silently ignored.",
        "Updating `media` here has the same constraint as `productCreateMedia`: `originalSource` must be a public URL Shopify can fetch (persisted file URL OR fresh staged-upload `resourceUrl`). Media upload is asynchronous (docs: \"The media is asynchronously uploaded and associated with the product\") — handler-side rows should be marked `pending` until storefront visibility is confirmed.",
        "Variant rate limit applies to large stores: per the docs, \"no more than 1,000 new product variants can be updated per day\" once a store exceeds 50,000 variants. Cron jobs that loop over a large catalog must respect this — surface 429-class throttling to the merchant rather than retrying indefinitely.",
    ],
    "productCreate": [
        "`product` is nullable on userError. Title uniqueness is NOT enforced — duplicate titles create separate products. If your handler treats title as a key, dedup BEFORE calling productCreate (query first, or use `productSet` upsert when you have a stable identifier).",
    ],
    "productSet": [
        "UPSERT-style mutation. The `identifier` arg is optional: omit it for create, pass it (with the resource's `id` GID) for update. The exact fields on `ProductSetIdentifiers` aren't enumerated in the public docs — read the schema (`input ProductSetIdentifiers`) for the authoritative shape rather than assuming `handle` / `customId` are accepted.",
        "REPLACE-ALL semantics on list fields. The docs flag this explicitly: collections, metafields, and variants use replace-all (the input list REPLACES the existing list); other fields are partial-update. Passing an incomplete `variants` array silently DROPS the omitted variants — silent data loss class. To partial-update variants, use `productVariantsBulkUpdate` instead.",
        "Variant cap: stores have a documented limit of 2,048 product variants per product. Exceeding this returns a userError; bulk imports must respect the cap.",
        "Async mode: `synchronous: false` returns a `ProductSetOperation` for polling instead of blocking on the mutation. Bulk operations ignore this flag — they always poll. Use sync for small product changes; use async (with explicit polling) for product imports of >50 variants.",
    ],

    # ─── Inventory ────────────────────────────────────────────────────────
    "inventoryAdjustQuantities": [
        "AS OF API 2026-04 THE IDEMPOTENCY KEY IS REQUIRED. The schema decorates this mutation with `@idempotent` — every call must include a stable `idempotencyKey` in the input or the mutation rejects. Use `crypto.randomUUID()` per logical operation (NOT per retry — a retry must reuse the same key to be idempotent).",
        "DELTA semantics: each adjustment modifies the quantity by a `delta` value rather than setting an absolute amount (per the docs: \"Each adjustment modifies the quantity by a delta value rather than setting an absolute amount.\"). For SET-to-absolute use `inventorySetOnHandQuantities` instead. Mixing the two produces apparent off-by-one bugs that look like race conditions.",
        "Returns its own typed `InventoryAdjustQuantitiesUserError` (with a `code` enum). The docs don't enumerate the codes; read `InventoryAdjustQuantitiesUserErrorCode` from the schema for the authoritative set. These codes are merchant-action-required (invalid items, negative resulting quantity, non-tracked items, etc.) — surface them; do not retry.",
        "Mutations are tied to `inventoryItem` GIDs (`gid://shopify/InventoryItem/...`), NOT ProductVariant or Product GIDs. Resolve `variant.inventoryItem.id` from a query first; passing a Variant GID will error.",
    ],
    "inventorySetOnHandQuantities": [
        "Sets absolute on-hand at the (inventoryItemId, locationId) PAIR. Always pass `locationId` explicitly; Shopify-side defaults vary across endpoint versions, and the silent-default failure mode writes the quantity to the wrong location in multi-location stores.",
    ],

    # ─── Metafields ───────────────────────────────────────────────────────
    "metafieldsSet": [
        "Up to 25 metafields per call (Shopify-enforced cap, confirmed in docs verbatim: \"Allows a maximum of 25 metafields to be set at a time\"). Chunk larger batches.",
        "ATOMIC operation per the docs: \"no changes are persisted if an error is encountered\" — one bad input row aborts the whole batch. Validate input rigorously up-front; don't rely on per-row partial success.",
        "`type` is strict and namespaced (`single_line_text_field`, `number_integer`, `json`, `list.product_reference`, `boolean`, etc.) and must match the metafield definition if one exists. Read the `MetafieldsSetUserErrorCode` enum from the schema for authoritative codes — never construct `type` strings dynamically without knowing the definition.",
        "`ownerId` is a GID for the resource (Product, ProductVariant, Order, Customer, Shop, etc. — the docs don't enumerate exhaustively). The `(ownerId, namespace, key)` triple must be unique. Re-calling on an existing triple is an UPSERT (overwrites `value`) — no need to query-then-write.",
        "For concurrent-safe writes (same metafield being updated by multiple handlers), pass `compareDigest` (available since 2024-07). Without it, last-write-wins; with it, mutations fail when the digest doesn't match the current value, letting you retry safely.",
    ],

    # ─── Bulk operations ──────────────────────────────────────────────────
    "bulkOperationRunQuery": [
        "Argument is a plain GraphQL QUERY, not a mutation. (For bulk-execution of mutations across many input rows, the SEPARATE `bulkOperationRunMutation` op exists — different shape, different staging requirements.)",
        "Result is a JSONL file at `currentBulkOperation.url` (or `partialDataUrl` for FAILED operations per the schema). Both URLs are valid for 7 days after completion (docs verbatim: \"Results remain available for seven days after completion.\"). Don't store the URL long-term — re-poll the operation if you need to re-read.",
        "Per-shop concurrency cap: ONE bulk query AND ONE bulk mutation can run at a time, per the docs (\"Apps can run one bulk query operation and one bulk mutation operation at a time per shop.\"). The platform's `shopify.bulkQuery` helper queues subsequent callers transparently; calling `bulkOperationRunQuery` directly bypasses that queue and risks `OPERATION_IN_PROGRESS` errors crashing unrelated cron runs. Use the helper.",
        "Connection-shape requirement: query must use `edges { node { ... } }` per the docs, with at most FIVE connections and a maximum nesting depth of TWO levels. Going deeper or wider returns a query-shape error before the operation starts.",
        "Avoid the `groupObjects` parameter unless required — the docs warn it \"slows operations and increases timeout likelihood.\" Default JSONL with `_link` / `__parentId` markers (which the helper handles) is faster.",
    ],
    "bulkOperationRunMutation": [
        "Used for large-scale per-row mutations. Input is a STAGED CSV/JSONL file uploaded via `stagedUploadsCreate` first — the mutation references the staged file by URL, not inline data. NO live progress feedback during execution; poll `currentBulkOperation` like you would for a query.",
        "Subject to the same per-shop concurrency cap as `bulkOperationRunQuery`: one bulk mutation in flight at a time. The pair (one query + one mutation) is independent — they can run concurrently.",
    ],

    # ─── Tagging ──────────────────────────────────────────────────────────
    "tagsAdd": [
        "Returns `node: Node` (interface). To read fields beyond `id` you must narrow with `... on <Type>` matching the GID you passed.",
        "Supported resources are documented exactly: Order, DraftOrder, Customer, Product, Article. Other GID types will error — verify before passing.",
        "Tag list is upserted (added to existing tags), NOT replaced. To replace, query existing tags and call `tagsRemove` for the diff in a separate mutation.",
    ],
    "tagsRemove": [
        "Idempotent — removing a tag that doesn't exist is not an error. Same `node: Node` interface return as `tagsAdd` and the same supported-resource set (Order, DraftOrder, Customer, Product, Article).",
    ],

    # ─── Discounts ────────────────────────────────────────────────────────
    "discountCodeBasicCreate": [
        "Returns `codeDiscountNode: DiscountCodeNode` and a typed `userErrors: [DiscountUserError!]!`. Read the `DiscountErrorCode` enum from the schema for the authoritative set of codes — surface them; don't retry on user-actionable errors.",
        "For automatically-applied discounts (no customer-entered code), use `discountAutomaticBasicCreate` instead — different shape, different mutation. Choose at architect-emit time based on whether the merchant wants a code field.",
        "Required scope: `write_discounts`. The architect must declare it in the access-scopes set or the mutation 401s at runtime.",
    ],

    # ─── Orders / order editing ───────────────────────────────────────────
    "orderEditBegin": [
        "Returns `orderEditSession` — a STAGING area, not a committed change. To finalize edits you MUST call `orderEditCommit` on the session ID. The session \"tracks all staged changes until you commit or abandon them\" (docs verbatim) — without commit the order is unchanged.",
        "`calculatedOrder` reflects PROPOSED edits with recalculated taxes/totals. Persist the `orderEditSession.id` alongside any handler-side edit log — every staging mutation in the workflow needs the same session id.",
    ],
    "orderEditCommit": [
        "Commits all staged edits in one transaction. The session is consumed after commit — further edits need a new `orderEditBegin`. Returns the updated `order` and `successMessages` (display-to-merchant text).",
    ],

    # ─── Customers ────────────────────────────────────────────────────────
    "customerUpdate": [
        "Returns `customer` (nullable on userError). Updating `email` may trigger Shopify-side merge logic if another customer has that email — read the `userErrors[].code` and handle accordingly. Apps must comply with Shopify's protected-customer-data requirements when updating PII.",
    ],
    "customerCreate": [
        "Minimum-fields rule per the docs: customers require AT LEAST ONE of `email`, `phone`, `firstName`, OR `lastName`. Calling with all four null fails validation with \"Customer must have a name, phone number or email address\".",
        "Email uniqueness is enforced per shop. Use the optimistic pattern (try create → catch the duplicate userError → look up by email) rather than SELECT-then-INSERT — the window between query and create is exploitable for concurrent requests.",
        "Apps must comply with Shopify's protected-customer-data requirements (an additional approval / configuration step on the Partner Dashboard) before creating customers in production.",
    ],

    # ─── Webhooks (mostly deployer-owned) ─────────────────────────────────
    "webhookSubscriptionCreate": [
        "Generally DEPLOYER-OWNED — the platform-back deployer registers webhooks at deploy time based on the architect's `webhookTopics`. If you find yourself calling this from a handler, you're probably duplicating the deployer's work and creating drift between the architect's plan and the runtime subscription set. Review the contract before shipping.",
    ],
}

# ────────────────────────────────────────────────────────────────────────────
# Storefront GraphQL operation gotchas
# ────────────────────────────────────────────────────────────────────────────

STOREFRONT_OP_GOTCHAS: Dict[str, List[str]] = {
    "cartLinesAdd": [
        "Returns `cart: Cart` with the recomputed line items. The new line's `id` is in `cart.lines.edges[].node.id` — Shopify generates it; never construct it client-side.",
        "Variant must be available for the buyer's market/locale. Adding an unavailable variant returns userErrors with code `INVALID_MERCHANDISE_LINE` and the cart is unchanged. Surface the error; don't retry.",
    ],
    "cartLinesUpdate": [
        "Quantity 0 is NOT a remove — use `cartLinesRemove` for removal. Setting quantity 0 here is a no-op (or sometimes a userError, depending on app config). Removal must be explicit.",
    ],
    "customerAccessTokenCreate": [
        "Returns `customerAccessToken: { accessToken, expiresAt }` (or `customerUserErrors`). Token expiry is set by Shopify (not configurable). Once `expiresAt` passes, requests fail with userError code `INVALID` — re-issue rather than refreshing (there is no refresh endpoint).",
    ],
}


# ────────────────────────────────────────────────────────────────────────────
# Public API
# ────────────────────────────────────────────────────────────────────────────

def gotchas_for_ops(op_names: Iterable[str], surface: str = "admin") -> str:
    """
    Render a markdown-ish block of per-op gotchas for the architect-approved
    op list. Returns "" when no declared op has registered gotchas — caller
    can append unconditionally without an empty header dangling.

    Parameters
    ----------
    op_names: iterable of op-name strings as written in the architect's
              `shopifyGraphqlOperations.<surface>` list. Order is preserved
              in the output (matches the prompt-cache contract: same
              architect plan → same prompt → same cache key).
    surface:  "admin" or "storefront" — selects the registry. Anything
              else returns "".

    Op names not in the registry are silently skipped — their behaviour is
    fully captured by the cross-cutting prompt.

    Output format:

      ── Per-op pitfalls (Shopify <surface>) ─────────────────────

      <opName>:
        - <pitfall 1>
        - <pitfall 2>

      <nextOpName>:
        ...
    """
    if surface == "admin":
        registry = ADMIN_OP_GOTCHAS
    elif surface == "storefront":
        registry = STOREFRONT_OP_GOTCHAS
    else:
        return ""

    blocks: List[str] = []
    seen: set = set()
    for name in op_names:
        if not isinstance(name, str) or name in seen:
            continue
        seen.add(name)
        items = registry.get(name)
        if not items:
            continue
        bullets = "\n".join(f"  - {p}" for p in items)
        blocks.append(f"{name}:\n{bullets}")

    if not blocks:
        return ""

    header = (
        f"── Per-op pitfalls (Shopify {surface}) ─────────────────────\n\n"
        "Per-operation behaviour the cross-cutting Shopify rules can't "
        "capture: response-shape interfaces requiring narrowing, async "
        "completion semantics, deprecated fields, paired-endpoint "
        "requirements. MUST-READ for any op listed below.\n\n"
    )
    return header + "\n\n".join(blocks)


def known_ops(surface: str = "admin") -> List[str]:
    """Return the sorted list of ops with registered gotchas for `surface`."""
    if surface == "admin":
        return sorted(ADMIN_OP_GOTCHAS.keys())
    if surface == "storefront":
        return sorted(STOREFRONT_OP_GOTCHAS.keys())
    return []
