# Generator Pivot Plan

A two-track architectural pivot for the app-generation pipeline. The goal is a
step change in **functional correctness** of generated apps and a meaningful
reduction in **generation cost**, achieved by moving complexity out of LLM
prompts and into deterministic platform code and shared types.

> **Source of the analysis below**
> The bugs, token counts, and retry patterns referenced in this document were
> measured on this branch (`claude/fetch-and-switch-branch-Crro8`): the
> post-split generator state with separate `a_product_agent`, `c_hld_agent`,
> `e_hld_v_agent`, `g_ops_picker_agent`, `i_lld_agent`, `k_lld_v_agent`,
> `m_pre_codegen_agent`, `o_codegen_agent`, `q_codegen_v_agent`,
> `s_revision_agent`, `u_explenation_agent`. File-path references in this
> document use this branch's layout (`platform-ai/`, `platform-back/`,
> `platform-shopify-admin/`, `platform-shopify-app/`).

---

## 1. Why this plan exists

Adding more agents has stopped moving the quality needle. A representative
generation (a bundle-with-tiered-discount app) shows:

- **Token cost is concentrated in two agents.** LLD ~278k input / 90k output;
  codegen validator ~328k input / 68k output. Together ~58% of the run.
- **Retries are whack-a-mole.** LLD ran 4 attempts: attempt 2 was a Pydantic
  failure on a `dict[str, str]` body containing `null`; attempts 3 and 4 each
  introduced *new* findings the prior attempt did not have. Codegen backend
  ran 3 attempts with the same drift pattern.
- **A validator actively regressed the code.** `codegen_v` claimed
  `payload.variant_gids` could be absent and the codegen agent's "fix" was an
  early-return that disabled the entire variant-deletion-detection feature.
  The Shopify webhook catalog explicitly documents `variant_gids` as
  `nullable: false` — the validator was wrong and made the output worse.
- **Three end-to-end-broken paths shipped from the generation.**
  - The admin UI never actually populates a bundle's item pool. It sends
    `variant_external_ids: []` to the save route; the backend's JSONB insert
    produces zero rows. The bundle item pool is uninhabitable through the UI.
  - The `products/update` webhook handler reads `payload.variant_gids` but
    immediately early-returns if it isn't present, and the `products/delete`
    topic is not subscribed at all. Variant-deletion auto-disable is
    unreachable in production.
  - The cart-add path passes a synthesised discount code
    (`BUNDLE-XXXX-1000`) to `cartCreate`. No such Shopify discount was
    created. The discount silently does not apply.

The validator layer caught a number of localised type/null bugs but missed
all three of the above — they are **contract-level** bugs that span files and
Shopify protocols, not single-file syntax bugs. More layers of
LLM-judging-LLM will not close that gap; each new layer shares the same blind
spot.

---

## 2. The two-track pivot

### Track A — Scaffold-first codegen

Replace the JSON-LLD intermediate representation with **actual TypeScript
files emitted by the LLD agent**. The LLD becomes a codebase architect: it
lays out the file tree, writes a header docstring inside each file
describing what that file owns, and emits the shared types file
(`src/types/contracts.ts`) with the request/response interfaces of every
route, every webhook payload shape, every cross-file boundary.

Downstream codegen agents stop translating JSON. Each one is given:

- the public-surface bundle from the platform template (cached, ~25k tokens)
- the LLD-emitted scaffold (cached after attempt 1)
- the header docstring of the one file it owns
- the typed imports it must satisfy

…and its job is reduced to "implement the body of this file so it compiles
against the types." The agent cannot accidentally invent a field, send the
wrong shape, or drift from a peer file's contract — the type system forbids it.

### Track B — Shopify protocol helpers in the platform

For every common Shopify pattern the agents currently re-implement from
primitives, expose a single typed helper in the platform SDK that absorbs
the entire protocol. The agent's only valid path to perform the pattern is
to call that helper. The helper enforces the prerequisite ordering, the
idempotency, the error handling, the API-version compatibility.

Examples of patterns that today require multi-step LLM-reasoning and
frequently regress:

- "apply tiered discount to cart" — requires discount-create before
  cart-apply
- "detect variant deletion from products/update webhook" — requires the
  `variant_gids` diff vs the stored bundle items, with subtle empty/missing
  handling
- "resolve all variants belonging to a product" — required because the
  Shopify resource picker exposes products separately from variants

Each becomes a one-line call against a typed helper.

### Why the two tracks compose

- **Types are the inter-agent contract.** Cross-file misalignment fails
  `tsc`, which is precise, machine-readable, and never hallucinates.
- **Helpers are the only valid path to a Shopify protocol.** The agent
  cannot fabricate a discount code because there is no typed entry point
  that accepts one — the only typed path is `ensureBundleTierDiscount(...)`.
- **`tsc --noEmit` replaces the LLM validator layer.** The retry signal is
  the compiler's error output, not another LLM's prose. No whack-a-mole.

---

## 3. Proof-of-concept scope (this branch's work)

The proof is intentionally narrow: regenerate the **bundle-with-tiered-
discount** app correctly, using the smallest set of helpers that closes the
specific failure modes observed in its prior generation. Once that works
end-to-end, the same pattern extends to the next app archetype.

### 3.1 Helpers to implement (and only these)

Built under `platform-back/templates/handler/src/lib/shopify/` (extending
the existing `platform-back/templates/handler/src/lib/shopify.ts` with a
directory of focused submodules). Each helper is fully typed, idempotent,
and has its own unit tests under `platform-back/templates/handler/__tests__/`.

#### `shopify.discounts.ensureBundleTierDiscount`

```ts
type EnsureBundleTierDiscountInput = {
  bundleId: string;            // stable platform UUID — used to build the discount key
  tier: { minimumItemCount: number; discountRate: number }; // discount_rate is bps
  eligibleVariantIds: string[]; // Shopify decimal variant IDs the discount applies to
};

type EnsureBundleTierDiscountResult = {
  discountNodeId: string;      // gid://shopify/DiscountNode/...
  discountCode: string | null; // populated only if the helper chose code-based; null for automatic
  createdNow: boolean;         // true iff we created on this call (telemetry/log purposes)
};

namespace shopify.discounts {
  async function ensureBundleTierDiscount(
    input: EnsureBundleTierDiscountInput,
  ): Promise<EnsureBundleTierDiscountResult>;
}
```

Internally:
- Computes a deterministic discount key from `(bundleId, tier.minimumItemCount, tier.discountRate)`.
- Looks up the existing discount node by key (via `codeDiscountNodeByCode` or
  `automaticDiscountNode` + saved-search; final API choice decided during
  implementation).
- If found and up-to-date → returns existing node.
- If found but stale → calls the appropriate `discount*Update` mutation.
- If absent → calls the appropriate `discount*Create` mutation and activates.
- Handles `userErrors` and retries on transient Shopify failures.

**Closes:** the fabricated `BUNDLE-XXXX-1000` discount code bug. The agent's
generated cart-add route now calls this helper and uses its returned
identifier, with no opportunity to invent a string.

#### `shopify.products.resolveVariantsForProducts`

```ts
type ResolveVariantsInput = {
  productIds: string[];        // Shopify decimal product IDs
  options?: { activeOnly?: boolean; perProductLimit?: number };
};

type ResolvedVariant = {
  variantId: string;
  productId: string;
  available: boolean;
};

namespace shopify.products {
  async function resolveVariantsForProducts(
    input: ResolveVariantsInput,
  ): Promise<ResolvedVariant[]>;
}
```

Internally:
- Issues a single `nodes(ids: $ids)` query with a `ProductVariant` connection
  fragment to expand each product to its variants.
- Paginates per product where `perProductLimit` allows.
- Returns flat `(variantId, productId, available)` triples.

**Closes:** the admin-UI bug where the merchant picker collects products and
the request body shipped empty `variant_external_ids`. Under the new flow
the admin UI sends `productIds: string[]`; the backend route calls the
helper and writes both `bundle_items.variant_external_id` and
`bundle_items.product_external_id`. The agent cannot send an empty array
that survives — the route's typed input no longer has parallel arrays.

#### `shopify.webhooks.defineHandler` (typed per topic)

```ts
type WebhookHandlerSpec<Topic extends KnownTopic> =
  Topic extends "products/update"        ? ProductsUpdateHandlerSpec    :
  Topic extends "inventory_levels/update"? InventoryLevelsUpdateSpec    :
  Topic extends "orders/paid"            ? OrdersPaidHandlerSpec        :
  never;

interface ProductsUpdateHandlerSpec {
  // Called when a variant present in a prior delivery is no longer in the
  // current payload's variant_gids list. The helper does the diff against a
  // caller-supplied "previously-known variants for this product" function.
  onVariantDeleted?: (ctx: VariantDeletedCtx) => Promise<void>;
  onVariantAdded?:   (ctx: VariantAddedCtx)   => Promise<void>;
  loadKnownVariants: (productId: string) => Promise<string[]>;
}

interface InventoryLevelsUpdateSpec {
  // shopify client is pre-constructed by the helper from the shop-domain
  // header that the webhook delivery always carries — the agent never deals
  // with shop-domain extraction.
  onAvailabilityChanged: (ctx: {
    inventoryItemId: string;
    available: number;
    shopify: ShopifyClient;
  }) => Promise<void>;
}

interface OrdersPaidHandlerSpec {
  // The helper performs the dedup write against `processed_webhooks`
  // BEFORE invoking the body. The body runs at most once per (topic,
  // delivery_id).
  onPaid: (ctx: { order: OrdersPaidPayload }) => Promise<void>;
}

namespace shopify.webhooks {
  function defineHandler<Topic extends KnownTopic>(
    topic: Topic,
    spec: WebhookHandlerSpec<Topic>,
  ): WebhookHandlerExport;
}
```

Each `WebhookHandlerSpec` is a discriminated type. The agent cannot subscribe
to `inventory_levels/update` and then read `payload.line_items` — the spec
shape only exposes inventory-relevant context.

**Closes:**
- `payload.__shopDomain` invented field — the inventory spec provides a
  ready-built `shopify` client. The agent has no reason to extract shop
  domain.
- `variant_gids` regression — the products/update spec exposes
  `onVariantDeleted` / `onVariantAdded` callbacks. The diff logic lives in
  the helper. The agent does not have to reason about empty vs missing
  arrays.
- order idempotency boilerplate — `OrdersPaidHandlerSpec` does the dedup
  write inside the helper, before invoking the body. The agent does not
  write `ON CONFLICT DO NOTHING` boilerplate.

### 3.2 What the LLD-emitted scaffold looks like for the bundle app

Targeted directory layout of the **generated app** (illustrative — this is
what the LLD agent emits into a working directory, not a change to the
platform's own layout):

```
generated-app/
├── src/
│   ├── types/
│   │   └── contracts.ts          # LLD-emitted: every request/response interface
│   ├── routes/
│   │   ├── admin.ts              # header: "owns POST /bundles/{create,update,...}; uses types from ../types/contracts"
│   │   ├── widget.ts             # header: "owns POST /bundle/{validate,add-to-cart}; uses shopify.discounts.ensureBundleTierDiscount"
│   │   └── webhook-handlers.ts   # header: "exports webhookHandlers for products/update, inventory_levels/update, orders/paid via shopify.webhooks.defineHandler"
│   └── lib/
│       └── business/
│           └── bundles.ts        # header: "pure tier-evaluation logic, no IO; called from widget and webhook"
├── admin/
│   └── ui.ts                     # TypeScript admin UI; compiled to JS for delivery
├── widget/
│   └── widget.ts                 # TypeScript widget; compiled to JS for delivery
└── migrations/
    └── 0001_app.sql              # LLD-emitted
```

Each file starts with a header docstring authored by the LLD: what this
file owns, what it imports, what its public exports are, and any
file-specific implementation notes (e.g. "this route must call
`ensureBundleTierDiscount` before `cartCreate`"). The codegen agent for
that file sees only its own header plus the shared types, plus the
platform's public surface bundle. The body it writes must compile against
those constraints.

### 3.3 The retry loop, redesigned

```
1. LLD emits the scaffold + headers + types/contracts.ts.
2. Per-file codegen agents fill each body (run in parallel — they only
   read shared types, never each other's source).
3. `tsc --noEmit` runs over the assembled tree (template + generated).
4. If tsc errors: feed the specific errors back to ONLY the agents whose
   files produced them. No prose validator, no second LLM judging the
   first. Retry budget per file: 2 attempts.
5. If tsc passes: ship.
```

There is no `codegen_v_agent`. There is no `lld_v_agent`. The
`pre_codegen_alignment_agent`'s role is absorbed into the LLD's
types-file output.

---

## 4. Phased plan

### Phase 0 — Foundations (no behaviour change)

- Decide the exact target path for the helpers under
  `platform-back/templates/handler/src/lib/shopify/`. (Either extend the
  existing `shopify.ts` in place or split into a directory of submodules —
  decided during Phase 1.)
- Establish the test convention for helpers (one `__tests__/*.test.ts` per
  helper alongside the existing template tests; mock the Shopify GraphQL
  transport at the client level using the same harness as the existing
  `shopify.test.ts`).
- Stand up a CI gate that runs `tsc --noEmit` on a representative
  pre-existing generated app under
  `platform-ai/cli/test_results/<timestamp>_<slug>/` to confirm baseline
  cleanliness.

### Phase 1 — Bundle-app helpers (the proof)

Implement the five helpers in section 3.1, with full unit tests, behind the
existing `shopify.graphql` / `shopify.storefront` transports. Helpers are
added; nothing else is changed yet. After this phase a developer can
hand-write a bundle app using them, but the generator does not yet emit
calls to them.

### Phase 2 — LLD output pivot

- Change the LLD agent's contract: instead of an `LLDPlan` Pydantic object
  serialised to JSON, it emits a `GeneratedScaffold` consisting of a list
  of `{ path, header, body_placeholder }` entries plus the `types/contracts.ts`
  contents.
- The runner writes these files to a working directory. `body_placeholder`
  is filled in later.
- LLD validation switches from "Pydantic of `LLDPlan`" to "the
  scaffold's `types/contracts.ts` parses with `tsc --noEmit` standalone"
  (i.e. types compile). This is much cheaper than the current semantic
  validator pass.

### Phase 3 — Codegen pivot

- Each codegen agent (backend, admin_ui, widget, db) is reduced to a
  per-file generator. Its prompt is:
  - the platform public-surface bundle (cached)
  - the assembled `types/contracts.ts` (cached)
  - the LLD-emitted header for this one file
  - "produce only the implementation body; preserve the header verbatim"
- Parallelism is restored at the per-file level, not the per-artifact
  level.

### Phase 4 — Retire the LLM validators

- Delete `codegen_v_agent` and `lld_v_agent` from the pipeline.
- Delete the `pre_codegen_alignment_agent`'s prose-emit role; its rules
  move into the LLD's typed-contracts output.
- Replace the retry signal with `tsc --noEmit` errors fed back per-file.
- Delete the `retry_suffix` machinery that ships ~100KB of prior output
  on every retry.

### Phase 5 — Minimal graph gates for cross-file business rules

A small (target ≤ 10) set of deterministic checks for invariants that
types cannot express. Examples:

- Every `webhookHandlers` export key matches a topic the LLD declared in
  `shopifyIntegration.webhookTopics`.
- Every route declared in `httpRoutes` is implemented in the corresponding
  route file.
- No generated file imports from `platform-back/templates/handler/src/lib/**`
  internal paths — only from the public `shopify`, `db`, `paginate`,
  `money`, `config`, `workflow`, `platform` modules.

These gates are written in TypeScript / Python against the assembled
scaffold. They are not LLM agents.

### Phase 6 — Expand the helper catalogue (post-proof)

Once the bundle-app proof passes, the same pattern extends to the next
high-frequency archetypes (abandoned-cart recovery, post-purchase upsell,
review request, loyalty, subscriptions). Each archetype is roughly one
person-week of platform engineering for its helpers plus prompt updates.

---

## 5. What gets retired

Once Phases 2–5 land:

| Component | Status | Reason |
|---|---|---|
| `lld_v_agent` (LLM validator over LLD) | Deleted | Replaced by tsc on `types/contracts.ts` + minimal graph gates |
| `codegen_v_agent` (LLM validator over emitted code) | Deleted | Replaced by tsc over the assembled scaffold |
| `pre_codegen_alignment_agent` | Reduced to nil | Its prose-emit role becomes LLD's typed-contracts output |
| `retry_suffix` (echo full prior output) | Deleted | tsc errors are the retry signal; no need to echo prior output |
| `LLDPlan` Pydantic schema (JSON intermediate) | Replaced | Replaced by `GeneratedScaffold` (file tree + headers + types) |
| Cross-file regex validators (`platform-ai/subagents/o_codegen_agent/cross_admin_backend.py`, `cross_widget_backend.py`) | Reduced | Most cases caught by tsc; what remains becomes 2-3 small graph gates |

---

## 6. Success criteria

A regenerated bundle app — same merchant prompt as the analysed run —
passes all of:

1. **`tsc --noEmit` passes** on the assembled scaffold with zero retries
   from any per-file agent. (Stretch: zero retries on the first try.)
2. **Admin UI populates the item pool.** A merchant flow that picks
   products produces real `bundle_items` rows with both
   `variant_external_id` and `product_external_id` populated.
3. **Variant deletion auto-disable works.** Simulating a `products/update`
   webhook where a known variant is dropped from `variant_gids` marks the
   matching `bundle_items` row as `deleted` and triggers the bundle's
   health transition.
4. **Discount actually applies at checkout.** A cart-add call results in a
   live Shopify discount being applied — verified by inspecting the cart
   in a development store.
5. **Token cost drops measurably.** Target: total tokens per generation
   ≤ 50% of the analysed-run baseline. Cache hit ratio on cross-agent
   reusable prefixes ≥ 70%.
6. **No `codegen_v` regressions.** The variant_gids early-return class of
   regression is impossible to express under the new shape (the helper
   owns the diff).

---

## 7. Risks and open questions

### Risks

- **TypeScript everywhere.** Admin UI and widget become TypeScript at
  generation time (compiled to JS for delivery). Worth confirming that
  the Shopify Theme App Extension and Admin Extension build paths accept
  this without ceremony. Expected answer: yes, both already support TS.
- **Helper maintenance.** Each helper is a one-time investment but
  needs version-bumping when Shopify changes the underlying API. Single
  maintenance point, but a real one. Mitigation: version-pinned Shopify
  API string in helper code + periodic version-rev policy.
- **Long-tail apps.** Apps requesting novel Shopify behaviours that no
  helper covers will fall back to primitives. Acceptable so long as the
  generator surfaces the missing-helper gap clearly to the platform
  team instead of producing a non-functional app silently.
- **Migration cost.** Phases 2–4 are real refactor work. The pipeline
  must continue to function in the interim. Mitigation: gate the new
  shape behind a feature flag; run both shapes in parallel until parity.

### Open questions

- For helpers that wrap mutations with side effects (discount-create,
  webhook-dedup), what is the canonical telemetry / logging shape?
- Where does the `types/contracts.ts` LIVE on disk for the generated
  app — is it shipped to the merchant or stripped at build time?
- Should the LLD also emit the test scaffolds, or only the source files?
- For the bundle-app proof, do we target an automatic discount or a code
  discount? Both work; automatic is more elegant for "auto-apply" UX,
  code is more flexible. The helper hides the choice from the agent but
  the platform team picks one.

---

## 8. Appendix — concrete bug-to-helper mapping

For traceability, mapping the three end-to-end-broken paths from the prior
generation to the helpers that eliminate them:

| Prior bug | Helper that absorbs it | Why the bug becomes inexpressible |
|---|---|---|
| Admin UI sends `variant_external_ids: []` to `/bundles/items/save` | `shopify.products.resolveVariantsForProducts` | New route shape takes `productIds: string[]`; backend calls the helper. There is no field named `variant_external_ids` to send empty. |
| `products/update` handler reads phantom `payload.__shopDomain` | `shopify.webhooks.defineHandler<"inventory_levels/update">` | The spec exposes `shopify` as a pre-built client. The agent never sees a raw payload field and has no reason to invent one. |
| Cart-add passes fabricated `BUNDLE-XXXX-1000` discount code | `shopify.discounts.ensureBundleTierDiscount` | The only typed entry point that produces a discount is the helper. The agent cannot construct a `discountCode: string` literal — its type isn't `string`, it's the helper's return value. |

The retry-validator pattern would not have caught any of these reliably.
The helper pattern makes all three unreachable by construction.
