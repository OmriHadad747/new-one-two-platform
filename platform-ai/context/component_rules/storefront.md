# component_rules/storefront.md

Conventions for the storefront widget — `scaffold/widget/widget.ts`.
Read this before writing widget code.

## What the widget module is

A self-contained JavaScript ES module that loads inside a Shopify App
Block on the storefront page. The runtime calls:

```ts
widget.mount(container, host) // your only export
```

You render UI inside `container` and reach the outside world only
through `host`. The App Block sandbox is STRICT — stricter than admin.

## Output rules

- **Type the SDK** — this file IS type-checked. Start with exactly one
  type-only import and annotate `host` with `Host`:

  ```ts
  import type { Host } from "@platform/storefront-sdk";

  export function mount(container: HTMLElement, host: Host): void {
    // ...
  }
  ```

  `import type` is erased at build, so it does NOT violate the sandbox's
  no-runtime-import rule. **Never type `host` as `any`** — that disables the
  type-check and ships bugs; the gate rejects `host: any`. `host.call` and
  `host.storefront` return `Promise<unknown>` — cast each result to the
  matching response type from `contracts.ts` (for `host.call`) or the Ajax
  catalog shape (for `host.storefront`).
- **Single runtime export**: `export function mount(...)`. No default
  export, no other named exports, and no *runtime* imports (the one
  `import type` above is the only import allowed).
- **Vanilla DOM only**: no React, no JSX, no framework.
- **No** `setInterval`, `eval`, `new Function`. `setTimeout` only for
  short debounce/throttle (≤500ms literal).
- **No Node APIs** — this runs in the customer's browser. No `sql`, no
  `process`, no `fs`.
- **No hardcoded URLs**.

## The `host` API

```ts
host.context = {
  shop:       string,        // "example.myshopify.com"
  customerId: string | null, // null for guests
}
// No product/variant/page fields. Read location.pathname / location.search
// for page context.

host.call(path, body?) → Promise<responseShape>
  // POST to your platform backend.
  // path MUST be in httpRoutes.widget from app.json.
  // body shape MUST match the route's requestShape from contracts.ts.

host.getFormData(form) → object
  // Reads named inputs from a <form> into a plain object. Use on submit.

host.storefront(relativePath) → Promise<any>
  // Public Shopify Ajax API — same-origin, no auth.
  // Allowed paths and response field names live in §7.4 (Ajax catalog).
  // Use field names from the catalog VERBATIM (e.g. `variant.available`,
  // NOT `variant.is_available`).
```

**Decision rule**:
- Public Shopify data (product, variant, cart, pricing) → `host.storefront`
- Your backend (DB state, Admin-API-only data, writes) → `host.call`

## DOM scoping — STRICT

Preferred: `container.*` for anything the widget owns.

Allowed `document.*`:
- ✅ `document.createElement`, `document.createTextNode` (pure factories)
- ✅ `document.addEventListener`, `removeEventListener`, `dispatchEvent`
  (for page-level events: visibilitychange, scroll, custom cart events)
- ✅ `document.querySelector`, `getElementById`, `querySelectorAll`
  (reading the merchant's existing page — theme integration only)

Forbidden `document.*`:
- ❌ `document.body.*` (injects into merchant page)
- ❌ `document.head.*` (global styles/scripts)
- ❌ `document.documentElement`, `document.cookie`, `document.title`
- ❌ `document.write`, `document.open`, `document.close`

Forbidden `window.*`:
- ❌ `window.parent`, `window.top`, `window.opener`, `window.frames`

CSS into container, NEVER `document.head`:

```ts
const style = document.createElement('style');
style.textContent = `.my-widget { color: red; }`;
container.appendChild(style);
```

## Customer identity — logged-in / guest

Pair with the backend handler's identity contract. Read
`host.context.customerId` (string | null).

When the feature persists per-shopper state, send identity on every
`host.call`:

```ts
// Logged-in: include customerId when non-null
host.call("/signup", { customerId: host.context.customerId, ... })

// Guest: mint a guestToken once and reuse it
const KEY = "<app_slug>.guestToken";
let guestToken = localStorage.getItem(KEY);
if (!guestToken) {
  guestToken = (crypto.randomUUID && crypto.randomUUID()) ||
               String(Date.now()) + Math.random().toString(36).slice(2);
  localStorage.setItem(KEY, guestToken);
}
host.call("/signup", { customerId: null, guestToken, ... })
```

Use EXACTLY this snippet — the `crypto.randomUUID` fallback is required
for Safari <17 support. Hand-rolled UUIDs often fail backend validation
or leak identity.

## When the backend isn't there yet

If a feature persists per-shopper state and the route catalog
(`httpRoutes.widget` in `app.json`) is empty, render a clear "feature
requires backend configuration" message. NEVER silently collect data
that gets discarded.

## Bug-class prevention (production-burned)

**1. Fall OPEN on state-check failure at mount.**
If the GET that loads initial state fails (network blip, 5xx, timeout),
render the DEFAULT state (form / "not active") — never an error that
blocks the shopper. Customer checkout must not depend on your widget
booting cleanly. The backend's dedup on POST catches any retries.

**2. Runtime-value HTML composition: use `createElement` + `textContent`,
not template literals.**
Two anti-patterns to avoid:
- `container.innerHTML += '...'` — re-parses the whole container,
  destroys all listeners. Use `appendChild(node)` instead.
- Inlining a runtime string into HTML like
  `` `<span>Notify when "${variantLabel}" is back</span>` `` —
  any `"` or `<` in the value breaks the markup AND opens XSS.

For complex composition, build with elements:
```ts
const wrap = document.createElement("span");
wrap.appendChild(document.createTextNode("Notify when "));
const v = document.createElement("strong");
v.textContent = variantLabel;
wrap.appendChild(v);
wrap.appendChild(document.createTextNode(" is back"));
```
For simple single-value strings, ONE template literal is fine:
`` `Selected: ${itemCount} of ${maxItems}` `` (the `textContent` setter
escapes the result).

## Self-test before writing a line

"Does this reach the DOM, network, or storage OUTSIDE what `container`
and `host` expose?" — if yes, drop it.
