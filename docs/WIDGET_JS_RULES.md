# Widget JS Prompt Rules — Validation Map

Source: every widget-facing prompt block — `platform-ai/subagents/prompts/core/widget.py:WIDGET_BASE`, the JIT capability docs in `platform-ai/subagents/prompts/capabilities/shopify_storefront.py:WIDGET_DOCS` (injected when the architect declared `widgetCapabilities` includes `"storefront"`), the user-prompt scaffolding in `platform-ai/subagents/widget_js_agent.py` (`_build_jit_sections`, `_format_catalog`, `_format_ux_guidance`, `_format_quality_brief`, `_sanitize_dom_access`), and the existing static gates in `platform-ai/llm_validations/widget_artifact.py` (+ shared `utils/static_validations/shared_checks.py` for `document.*` denylist + `setTimeout` discipline).

**Scope note:** rules about how the *handler* responds to widget calls (route shape, response contract, customerId/guestToken merge logic on the server) are owned by `HANDLER_RULES.md`. This file lists only the widget agent's own rules — what the widget JS itself must look like.

**Legend** — `validate?` = should this rule be enforced after the widget agent emits its JS module?
- **static** — structural / regex / AST check. HIGH precision (no false positives), implemented in `llm_validations/widget_artifact.py` (regex / shared denylists) and the cross-artifact catalog matcher.
- **llm** — semantic, prose, or judgment that won't survive a cheap structural check but is worth catching agentically (per `LLM_VALIDATORS_PLAN.md`).
- **no** — judgment/style/informational; high false-positive risk relative to value.
- **no (paranoid)** — structural rule the prompt + parse step already carry; model gets it right ~always. If it ever drifts, `bug_finder` (Sonnet + thinking) catches downstream impact, and the App Block runtime fails-fast to load any module with disallowed shapes (no React, no `import`).

**`done?`** column — `✅` means the static-tier check is currently implemented in `widget_artifact.py` (or in `shared_checks.py` for the document/setTimeout shared logic). Blank for `llm` / `no` / `no (paranoid)` rows.

**One owner per rule** — every row has exactly one owner. No rule is enforced by both static AND llm. Where a rule is also enforced by the App Block runtime (which rejects unloadable modules at deploy time), that's a downstream safety net — not a duplicate static check we maintain locally.

**Static-validation principle:** only enforce a regex/AST static rule when (a) the failure mode has been seen with non-trivial frequency, (b) the check is cheap & structural with **near-zero false-positive rate**, (c) the blast radius is catastrophic (widget doesn't load, theme breakage from page-leakage, tenant cross-talk from hardcoded shop, silent data loss), AND (d) the App Block runtime / parse-time normalization / upstream architect checks don't already cover it. Everything else flows through the LLM validators (`agent_rules` + `bug_finder`).

**Special note on widget JS specifically — there is no `tsc` for widget code.** Unlike the handler bundle, the widget is plain ES module JavaScript that the App Block runtime loads in the shopper's browser. There's no compile-time type check. The static layer therefore carries more weight here than for the handler — but the four-bar policy (and especially the near-zero-FP bar) still applies. Bias toward the App Block runtime catching truly unloadable modules at deploy time, and toward `agent_rules` catching anything that's structurally clean but semantically wrong.

---

| # | rule | validate? | how | done? |
|---|---|---|---|---|
| **Module shape** | | | | |
| 1 | Export a named `mount(container, host)` function — the only allowed export from the widget module | yes | static | ✅ (`widget_artifact` regex) |
| 2 | No React / JSX / framework — vanilla DOM only. No `import` statements of any kind, no `export default`, no JSX syntax, no `React.*` / `useState` / `useEffect` / `useRef` / `React.createElement` calls | no (paranoid) | — (the App Block runtime expects a self-contained ES module with no external imports; any `import React` makes the module fail to load → fast deploy-time feedback. `agent_rules` catches drift inside the module.) | |
| 3 | Output is raw JavaScript only — no markdown fences, no explanation prose, no comments outside the code | no (paranoid) | — (`WidgetJsGenerator.parse()` strips ` ```js / ``` ` fences and trims leading prose; not a separately-validated rule) | |
| **Forbidden globals** | | | | |
| 4 | No raw `fetch()` and no `XMLHttpRequest` — backend traffic goes through `host.call()` only; public Shopify data goes through `host.storefront()` only | yes | static | ✅ (`widget_artifact` `FORBIDDEN_WIDGET_JS_PATTERNS`) |
| 5 | No `eval()`, no `new Function()`, no `setInterval` | yes | static | ✅ |
| 6 | `setTimeout` allowed only as a bounded debounce / throttle with a literal numeric delay ≤500ms | yes | static | ✅ (`shared_checks.find_setTimeout_violations`) |
| 7 | No `window.parent` / `window.top` / `window.opener` / `window.frames` — cross-frame access breaks the storefront's iframe isolation | yes | static | ✅ |
| **DOM scoping** | | | | |
| 8 | `document.*` denylist: `document.body.*`, `document.head.*`, `document.documentElement`, `document.cookie`, `document.title`, `document.write` / `document.open` / `document.close`, `document.execCommand`. These leak outside the widget's container, mutate the merchant's page, or read sensitive session state. CSS / scripts / style elements MUST be appended to `container`, never `document.head` | yes | static | ✅ (`shared_checks.find_document_violations`) |
| 9 | Prefer `container.*` for widget-owned DOM; legitimate page-level reads (`document.querySelector` / `getElementById` for theme integration, `document.addEventListener` for visibilitychange/scroll/outside-click, `document.dispatchEvent` for cart events) are explicitly allowed | no | — (style preference; the prompt teaches positively; the document.* denylist at row 8 catches the actual hazards) | |
| **Hardcoded identifiers** | | | | |
| 10 | No hardcoded `tenant_id` / `tenantId` literal in the source — read identity from `host.context` | yes | static | ✅ (`widget_artifact` regex) |
| 11 | No hardcoded shop domain (`*.myshopify.com`) and no hardcoded entity IDs (variantId / productId / customerId / collectionId literals) — read from `host.context` or page URL (`location.pathname` / `location.search`) | yes | llm | |
| **Catalog adherence** | | | | |
| 12 | Every `host.call(path, …)` path is one of the paths in `platformApiCatalog` (the architect-declared `widgetApiCatalog`) — no invented paths | yes | static | ✅ (`widget_artifact` cross-checks against catalog) |
| 13 | `host.call(path, body)` body uses EXACT field names from the catalog's `requestShape`; the widget reads EXACT field names from the catalog's `responseShape` (no renaming, no aliasing, no spreads that drop fields silently) | yes | llm | |
| **host.storefront / public Shopify reads** | | | | |
| 14 | `host.storefront(path)` paths are relative (e.g. `/products/<handle>.js`), never full URLs | yes | static | ✅ |
| 15 | Public Shopify data (product details, variant availability, cart) goes through `host.storefront`; backend reads/writes go through `host.call`. Don't proxy storefront reads through the handler when the widget can read them directly. | yes | llm | |
| **Customer identity (paired with handler `WIDGET CUSTOMER IDENTITY` contract)** | | | | |
| 16 | For features that persist per-shopper data: every `host.call()` body includes BOTH `customerId` (read fresh from `host.context`, may be null for guests) and `guestToken` (minted client-side via `crypto.randomUUID()`, persisted in `localStorage`, reused on every call). After a successful migration response that carried both fields, the stored `guestToken` MUST be cleared from `localStorage`. Never refuse to render for guests unless the feature genuinely requires authentication. | yes | llm | |
| 17 | Never write `customerId` to `localStorage` — it's supplied fresh by `host.context` on every mount. Storing it leaks the previous shopper's identity to the next one on shared browsers. | yes | static | ✅ (`widget_artifact` regex `localStorage.setItem('customerId', …)`) |
| **Silent data loss** | | | | |
| 18 | A widget with an EXPLICIT form submission (`<button type="submit">`, `addEventListener("submit", …)`, `.submit()` call) MUST call `host.call()` somewhere — otherwise collected data is silently discarded. | yes | static | ✅ (`widget_artifact` — narrow explicit-submit signal only; near-zero FP) |
| 19 | The broader case — a widget with input controls and a click-handler that LOOKS like a data submission but never dispatches to `host.call()` — distinguish from legitimate read-only filter UI that operates client-side. (The earlier static heuristic combined "click + input" and FP'd on filter widgets; that branch was removed and the case moved to `agent_rules`.) | yes | llm | |
| 20 | If `platformApiCatalog` is empty AND the feature requires persistent data collection, render a clear "this feature requires backend configuration" message — never fake a successful save. | yes | llm | |

---

## Static implementation map

The static-yes rule-rows above (✅) are covered by checks in:

- **`llm_validations/widget_artifact.py`** (regex pass + heuristics):
  - Row 1 — `export\s+function\s+mount\b` regex.
  - Row 4 — `FORBIDDEN_WIDGET_JS_PATTERNS` covering `fetch(`, `XMLHttpRequest`.
  - Row 5 — same `FORBIDDEN_WIDGET_JS_PATTERNS` covering `eval(`, `new Function(`, `setInterval(`.
  - Row 7 — `\bwindow\.(parent|top|opener|frames)\b` regex.
  - Row 10 — `\btenant[_-]?id\s*[:=]\s*['"]` regex.
  - Row 12 — `host.call(...)` path scan cross-checked against the architect's `platformApiCatalog`.
  - Row 14 — `host.storefront(...)` path scan rejecting `http://` / `https://` arguments.
  - Row 17 — `localStorage.setItem('customerId', …)` exact-key regex.
  - Row 18 — explicit-submit signal: `type="submit"`, `addEventListener("submit", …)`, `.submit()` call. Tightened from the prior heuristic that also combined click + input; the click+input branch had non-trivial FP on read-only filter UIs and was moved to `agent_rules` (row 19).
- **`utils/static_validations/shared_checks.py`** (shared with `admin_ui_artifact.py`):
  - Row 6 — `find_setTimeout_violations` — rejects non-literal delays and delays > 500ms.
  - Row 8 — `find_document_violations` — denylist for `document.body / head / documentElement / cookie / title / write / open / close / execCommand`.
- **`llm_validations/cross_widget_handler.py`** (cross-artifact widget↔handler field-shape match):
  - Row 13 (structural half) — scans `host.call(path, { fields })` in widget JS, scans `widgetRouter.post(path, async (req, res) => { … })` route bodies in the handler bundle, cross-checks field-name sets between the widget body and the handler's `req.body` destructure / `req.body.<field>` access. Both sides receive any mismatch on retry.

**Parse-time normalization (not validation):** `WidgetJsGenerator._sanitize_dom_access` auto-rewrites `document.head` / `document.body` references to `container` before validation runs — it's a safety net for the most common LLM mistake, not a separately-counted rule.

---

## Audit changes (2026-04-28) — method-aware host.call SDK

The architect's `widgetApiCatalog` rows carry a `method` field (GET / POST)
per ARCH_RULES row 19. Until this round the host.call SDK was always-POST
regardless: the storefront app proxy widget runtime
(`platform-shopify-app/extensions/widget-runtime/assets/widget-runtime.js`)
hardcoded `method: "POST"` for every call. That made the architect's
catalog `method` field a lie at runtime — GET routes silently became POST
in the wire, and the platform-back widget edge proxy already forwarded the
request method verbatim, so a generated `widgetRouter.get(path, ...)` route
that read from `req.query` got an empty `req.query` because the SDK had
sent the args in the body of a POST instead.

Fix shipped this round:

- **SDK now derives method from a runtime catalog manifest.** The served
  widget bundle gets `window.__PLATFORM_CATALOG__ = [{path, method}, ...]`
  prepended at deploy time by
  `platform-back/apps/api/src/lib/bundle-storage.ts:saveBundles`. The
  manifest is a slim projection of `widgetApiCatalog` threaded through
  `Bundle.widgetCatalog` (Pydantic + Zod schemas updated in lockstep).
  `host.call(path, args)` looks up `path → method` and routes
  GET-with-querystring vs POST-with-body accordingly.
- **`cross_widget_handler.py` is now method-aware.** Row 13's structural
  half (field-name match between widget and handler) checks `req.body`
  for POST paths and `req.query` for GET paths, source of truth being
  the architect catalog passed as the third argument to
  `validate_widget_handler_contract`. Defaults to POST when the path is
  absent from the catalog (matches the SDK fallback for routes that
  bypass the catalog).
- **`chat_local.py:_save_generated_files`** prepends the same manifest
  to locally-saved `widget.js` so dev-loop testing matches deployed
  behaviour.

Row classifications unchanged. The audit recorded the FP class —
"correct architect declaration, SDK didn't honour it, validator FP'd
on the symptom not the cause" — as a sub-genre of
`Cross-artifact-context FP`: the validator was reading the right slot
(the slot the SDK populated) but the slot was wrong because the SDK
was wrong. Resolution lived in the SDK (now method-aware) and the
validator (now method-aware about WHICH slot to check), with no rule
reclassification needed.

## Audit changes this round

- **`cross_widget_handler.py` rewritten** to target the current Express `widgetRouter.post("/path", async (req, res) => … req.body …)` shape. The earlier version was anchored to the legacy `ctx.widgetPath === "/path"` / `ctx.widgetBody` harness and silently matched nothing — the cross-artifact field-shape check was effectively disabled for every storefront app. The structural half of row 13 is now active.
- **Row 17 promoted from llm to static.** `localStorage.setItem('customerId', …)` is a clean, near-zero-FP regex against an exact key string, and the failure mode (next shopper on a shared browser sees the prior shopper's data) is privacy-class catastrophic. Worth a fail-fast static gate.
- **Row 18 tightened.** The click+input branch of the form-submission heuristic had FP surface against legitimate read-only filter UIs (search field + click handler on filter button + no host.call by design). Removed that branch from the static check; the broader case is now row 19, owned by `agent_rules`.
- **Row 19 added** (split off from old row 18). Click-as-submit pattern detection — semantic, requires distinguishing data-collection from filter UI. LLM owns it.
- **Row 20 added** (split off from old row 18). Empty `platformApiCatalog` + persistent-data-collection feature → render "needs backend config" message instead of faking success. Cross-field reasoning, LLM owns it.

---

## Counts

- **20 rules** total across the widget prompt + agent + capability surface
- **17 validate** → **11 static** rule-rows (✅ all enforced today across `widget_artifact.py` + `shared_checks.py` + `cross_widget_handler.py`) + **6 llm** rule-rows deferred to `agent_rules` + `bug_finder`
- **3 skip** → **1 no** (style: container-preference for legitimate page reads) + **2 paranoid** (App Block runtime catches imports / non-`mount` shapes; `parse()` handles output-format normalization)
- **0 critical static gaps** under the four-bar policy. Row 2 (no React / JSX / imports) was the strongest residual candidate for static promotion (cheap regex, near-zero FP), but stays `no (paranoid)` because the App Block runtime already rejects modules with `import` statements at deploy time — a faster, less brittle gate than a local regex. `agent_rules` is the structured-output safety net for any drift inside the module body.
