# Platform-Wide GID Format Helper — Implementation Plan

## Goal

Eliminate manual `gid://shopify/<Type>/<id>` string interpolation by
shipping `gid()` and `parseGid()` helpers. The LLD prompt drops R11
(GID format) and R12 (String() normalization on Map keys) — the helper
makes both structural.

## Why now

Every shopify_query / shopify_mutation recipe today writes:

```
compute        expression: "`gid://shopify/Order/${rawId}`"
                bindResultTo: "orderGid"
shopify_query  variables: { id: "$orderGid" }
```

And on the way back (when joining bulk-fetched nodes against DB rows):

```
compute   "String(node.id)"   // R12 — both sides of Map key
```

Boilerplate, easy to forget, silent-failure-prone (R11/R12 were added
because the model dropped them and the resulting bugs were hard to
notice — Shopify IDs as numbers vs strings caused silent lookup misses).
A pure-function helper makes the format mistake-proof.

## Specification

### Helper API

```ts
import { gid, parseGid, GidError } from "../lib/gid.js";

// Build a GID from a type + id (string | number | bigint):
const orderGid = gid("Order", orderId);
// → "gid://shopify/Order/12345"

// Parse a GID:
const { type, id } = parseGid("gid://shopify/Order/12345");
// → { type: "Order", id: "12345" }

// R12 idiom — normalise a Shopify id-shaped value to a string-keyed Map:
const key = parseGid(node.id).id;
```

### Behavior

- `gid(type, id)` — `id` accepts `string | number | bigint`; coerced
  via `String()`.
- `gid` validates `type` against `^[A-Z][A-Za-z0-9_]+$` (rejects
  unsafe interpolation, empty string, types with separators).
- `gid` validates `id` is non-empty and matches `^\d+$` after
  stringification (Shopify IDs are numeric).
- `parseGid(s)` strict-matches `^gid:\/\/shopify\/([A-Z][A-Za-z0-9_]+)\/(\d+)$`.
  Throws `GidError` on:
  - missing `gid://shopify/` prefix
  - any extra path/query/fragment
  - non-numeric id
  - lowercase or punctuated type
- Pure synchronous functions; no DB / network / mutable state.

### TypeScript signature

```ts
export class GidError extends Error {}

export function gid(type: string, id: string | number | bigint): string;
export function parseGid(value: string): { type: string; id: string };
```

## Edge cases

| Case | Handling |
|---|---|
| `gid("Order", "12345")` (string id) | Works — passthrough. |
| `gid("Order", 12345)` (number id) | Works — String() applied. |
| `gid("Order", 12345n)` (bigint id) | Works — String() applied. |
| `gid("Order/Bad", id)` (type with separator) | Throws GidError — type regex rejects. |
| `gid("", id)` | Throws GidError. |
| `gid("order", id)` (lowercase type) | Throws GidError — Shopify types are PascalCase. |
| `gid("Order", null)` | Throws GidError ("id required"). |
| `gid("Order", "abc")` (non-numeric id) | Throws GidError — Shopify IDs are numeric. |
| `gid("Order", -1)` | Throws GidError — sign unexpected. |
| `parseGid("12345")` (raw id, not a GID) | Throws GidError. |
| `parseGid("gid://shopify/Order/12345?variant=foo")` | Throws — strict pattern. |
| `parseGid("gid://shopify/Order/12345#frag")` | Throws — strict pattern. |
| `parseGid("gid://shopify/order/12345")` (lowercase type) | Throws — type regex. |
| Custom Shopify types (`Metafield`, `ProductVariant`, `LineItem`, …) | All match the generic regex; helper doesn't hardcode types. |
| Numeric ID > 2^53 | `parseGid` returns `id` as a string; never coerced. Caller uses `BigInt(id)` if numeric arithmetic needed. |
| Type name is one we've never seen (Shopify adds a new resource) | Generic regex passes; no list maintenance needed. |
| Repeated calls with same args | Pure function — no caching needed. |

## Reliability layers

1. **No HLD signal** — every Shopify-touching app needs this. Helper
   is universally available; no JIT injection needed.
2. **No JIT contract** — the helper is too small for prose; the
   per-step snippets carry the usage example.
3. **LLD prompt slim:** drop R11 (~6 lines) and R12 (~3 lines).
   Replace with one sentence: "Use `gid()` from `../lib/gid.js` to
   build Shopify GIDs; use `parseGid().id` to normalise Shopify ID
   values to strings before storing or using as Map keys."
4. **Per-step snippets updated:** [platform_runtime_examples.py](platform-ai/subagents/lld_agent/platform_runtime_examples.py)'s
   `shopify_graphql`, `shopify_graphql_paginate`, `shopify_bulk_query`,
   `shopify_mutation`, `shopify_storefront` rewritten to use `gid()`
   instead of inline `\`gid://shopify/...\`` template literals.

## Safety

- Pure, synchronous, no side effects.
- Strict regex validation rejects malformed input loudly.
- Type-input regex prevents prompt-injection-style construction
  (`gid(userControlledType, id)` — type is validated even when sourced
  from a webhook payload).
- Numeric IDs returned as strings → no Number(id) precision loss for
  IDs > 2^53.

## Implementation phases

### Phase 1 — Helper + tests

**Files to author:**
- `platform-back/templates/handler/src/lib/gid.ts` — `gid`, `parseGid`,
  `GidError`.
- `platform-back/templates/handler/__tests__/gid.test.ts` — round-trip
  Order/Product/Metafield/Customer/ProductVariant; type validation
  (lowercase, separator, empty); id validation (string, number, bigint,
  non-numeric, negative, null); parseGid malformed-input rejection
  (raw id, query string, fragment, lowercase type).

### Phase 2 — Update existing snippets + LLD prompt

- [platform_runtime_examples.py](platform-ai/subagents/lld_agent/platform_runtime_examples.py):
  rewrite the five Shopify snippets (`shopify_graphql`,
  `shopify_graphql_paginate`, `shopify_bulk_query`, `shopify_mutation`,
  `shopify_storefront`) to use `gid()`.
- [lld_agent/prompt.py](platform-ai/subagents/lld_agent/prompt.py): drop
  R11 + R12; consolidate into one rule pointing at the helper.

### Phase 3 — Documentation (deferred)

`docs/GID_HELPER.md` if/when documentation lands generally.

## Sequencing

```
Phase 1 (helper + tests) ─────┐
                              ▼
                    Phase 2 (rewrite snippets + LLD prompt slim)
                              │
                              ▼
                    Phase 3 (docs, when needed)
```

Phase 2 can land in the same PR as Phase 1 — they're tightly coupled
and small.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| LLD continues to write inline `gid://shopify/...` despite the rule | Per-step snippets show the new pattern verbatim; codegen translates verbatim. If the LLD writes inline, the codegen still emits valid TS — just doesn't get the helper's validation. Adding a regex validator on compute expressions is overkill (false positives, low harm). |
| New Shopify type lands that doesn't match the generic regex | Regex is `[A-Z][A-Za-z0-9_]+` — accepts every Shopify type observed to date. Future types: same shape unless Shopify changes conventions. |
| ID > 2^53 silently coerced to a number elsewhere | `parseGid` returns `id` as `string` — no Number() coercion. Callers needing arithmetic use BigInt explicitly. Documented. |
| Caller passes user-controlled `type` to `gid()` | Type-input regex rejects unsafe input. Cannot inject path segments. |
| `gid` accepts a numeric `id` but writes it via String() — could lose precision if upstream already coerced | Pre-coerce via String() at the helper boundary; warn callers via doc to pass strings or bigints when crossing 2^53. |

## Success metrics

- Zero inline `\`gid://shopify/...\`` template literals in generated
  recipes after Phase 2 (audit existing test outputs / fresh
  generations).
- Zero `String(node.id)` compute steps that exist solely to normalise
  Shopify IDs (replaced by `parseGid(node.id).id` in the rare case
  Map-key normalisation is needed).
- LLD prompt token count drops by ~12 lines on every call (R11 + R12 +
  compute step's GID example).

## Estimated scope

| Phase | Effort |
|---|---|
| 1. Helper + tests | 0.25 day |
| 2. Snippet rewrites + LLD prompt slim | 0.25 day |
| 3. Docs (deferred) | 0.25 day (when needed) |
| **Total (Phases 1+2)** | **0.5 working day** |

Smallest of the three; could bundle with Workflow or Shopify-Loop in
one PR.
