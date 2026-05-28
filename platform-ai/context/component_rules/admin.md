# component_rules/admin.md

Conventions for the admin embedded panel — `scaffold/admin/ui.ts`. Read
this before writing any admin code.

## What the admin module is

A self-contained JavaScript ES module that runs inside a Shopify Admin
iframe. The Shopify shell calls:

```ts
panel.mount(container, bridge) // your only export
```

You render UI inside `container` and reach the outside world only
through `bridge`. Anything touching the DOM / network / storage outside
`container` and `bridge` is rejected by the sandbox.

## Output rules

- **Type the SDK** — this file IS type-checked. Annotate `bridge` with
  `AdminBridge`:

  ```ts
  import type { AdminBridge } from "@platform/admin-sdk";
  import type { ListBundlesResponse } from "../src/types/contracts.js";

  export function mount(container: HTMLElement, bridge: AdminBridge): void {
    // ...
  }
  ```

  `import type` is erased at build, so it does NOT violate the sandbox's
  no-runtime-import rule. **Never type `bridge` as `any`** — that disables
  the type-check and ships bugs; the gate rejects `bridge: any`. `bridge.call`
  returns `Promise<unknown>` — cast each result to the matching response type
  from `contracts.ts`. For a picked resource, a variant's gid is
  `variants[i].id`; there is no `product_id` on a `PickedResource` (tsc
  rejects it).
- **Imports — type-only, two sources allowed**: the SDK
  (`@platform/admin-sdk`) and the shared contracts
  (`../src/types/contracts.js`) for request/response/row types. IMPORT the
  contract types — do NOT re-declare them inline (inline copies drift from
  the backend). No runtime imports.
- **Single runtime export**: `export function mount(...)`. No default
  export, no other named exports.
- **Vanilla DOM only**: no React, no JSX, no framework.
- **No** `setInterval`, `eval`, `new Function`. `setTimeout` only for
  short debounce/throttle (≤500ms literal) OR documented async polling.
- **No hardcoded URLs**: backend access via `bridge.call` only.

## The `bridge` API

```ts
bridge.context = {
  shop:     string,    // "example.myshopify.com" — display only
  appId:    string,    // platform app UUID — display only
  currency: string,    // ISO 4217 (e.g. "USD", "JPY")
  locale:   string,    // BCP-47 (e.g. "en-US", "ja-JP")
}

bridge.call(path, body?) → Promise<responseShape>
  // path MUST be in httpRoutes.admin from app.json.
  // HTTP method auto-selected per the route's declared method.
  // body shape MUST match the route's requestShape from contracts.ts.

bridge.notify(message, variant?)
  // variant ∈ {"success", "error"} (default "success").
  // Transient toast — for short feedback only.
  // For blocking errors, render a shell-error-banner in container instead.

bridge.pickResource(options) → Promise<PickedResource[] | null>
  // Native Shopify resource picker — ALWAYS prefer over custom search.
  // options.type ∈ {"product", "collection", "variant"}
  // Returns null on cancel; [{ id: "gid://...", title }] otherwise.

bridge.saveBar.show(id?) / bridge.saveBar.hide(id?)
  // Native "You have unsaved changes" bar.
  // show() on first dirty input; hide() on save success or discard.
```

`shop` and `appId` are display-only — never include them in `bridge.call`
bodies (the shell adds shop identity to the session JWT itself).

## Design system

The admin shell pre-injects CSS classes — use them, do NOT redeclare:

- `.shell-card`, `.shell-section`, `.shell-stack`, `.shell-error-banner`
- `.btn-primary`, `.btn-secondary`, `.btn-destructive`
- `.badge`, `.badge-success`, `.badge-warning`, `.badge-critical`

Hex colours are forbidden except `#008060`. Use Polaris CSS tokens:
`var(--p-color-text-subdued)`, `var(--p-color-bg-surface)`, etc.

## Data formatting

Format money + dates with `Intl.*` and `bridge.context`:

```ts
new Intl.NumberFormat(bridge.context.locale, {
  style: "currency",
  currency: bridge.context.currency,
}).format(amountInMajorUnits)

new Intl.DateTimeFormat(bridge.context.locale, {
  dateStyle: "medium",
  timeStyle: "short",
}).format(new Date(isoTimestamp))
```

Never hardcode `"USD"` or `"en-US"`.

## Status / enum vocabulary

Render badges and filter dropdowns ONLY using values from
`contracts.ts`. If `contracts.ts` declares
`type BundleHealth = "all_available" | "some_unavailable" | "all_unavailable"`,
those three strings are the entire vocabulary — never invent
intermediate states.

## After mutations

Every successful POST that changes state MUST be followed by a refetch
of the relevant GET. Leaving stale rows on screen is a bug.

## DOM scoping — admin is looser than storefront

The admin panel IS in its own iframe, so some page-level reads are
legitimate. But:

- ✅ Prefer `container.*` for anything the panel owns
- ✅ `document.createElement`, `document.addEventListener` for events
- ❌ `document.body.*`, `document.head.*`, `document.documentElement`
- ❌ `document.cookie`, `document.title`, `document.write`
- ❌ `window.parent`, `window.top`, `window.opener`

CSS injection goes into `container`, never `document.head`:

```ts
const style = document.createElement('style');
style.textContent = `.my-panel { color: red; }`;
container.appendChild(style);
```

## Pagination

If the route's `paginationKind` is `"offset"` in `app.json` /
`contracts.ts`:

```ts
const { items, total, page, page_size } =
  await bridge.call("/bundles", { page, page_size });
```

If `"cursor"`:

```ts
const { rows, next_cursor } =
  await bridge.call("/bundles", { cursor });
```

Match the response shape from `contracts.ts` exactly — both clients of
the route must agree.

## Bug-class prevention (production-burned)

**1. `innerHTML +=` is forbidden.**
It re-parses the entire container, destroying every previously-attached
event listener. Silent UI breakage. Use `container.appendChild(node)` or
assign `container.innerHTML = '...'` once and re-attach listeners
afterwards.

**2. Cursor pagination needs TWO cursors.**
- `pageCursor` — what you pass to `bridge.call(...)` for the current
  fetch (null on first page).
- `nextCursor` — `response.next_cursor` from the last fetch; what
  the Next button advances to.
Plus a `cursorStack: string[]` to support Prev. Collapsing into one
`cursor` variable breaks Prev (it just re-fetches the current page).

**3. After a successful POST: refetch ONLY the affected region; stay
on the same page.**
Don't jump to page 1 after every mutation — that's disorienting. The
one exception: after deleting the LAST row on a page, pop the stack
and refetch the previous page before rendering.

## Self-test before writing a line

"Does this reach the DOM, network, or storage in a way that `bridge` or
`container` doesn't expose?" — if yes, drop it.
