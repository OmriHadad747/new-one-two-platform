# Admin UI Prompt Rules — Validation Map

Source: every admin-UI-facing prompt block — `platform-ai/subagents/prompts/core/admin.py:ADMIN_BASE`, the user-prompt scaffolding in `platform-ai/subagents/admin_ui_agent.py` (`_format_admin_catalog`, `_format_state_machine`, `_format_column_enums`, `_format_gaps`, `_sanitize_dom_access`), and the existing static gates in `platform-ai/llm_validations/admin_ui_artifact.py` (+ shared `utils/static_validations/shared_checks.py` for `document.*` denylist + `setTimeout` discipline) plus the cross-artifact field-shape matcher in `platform-ai/llm_validations/cross_admin_handler.py`.

**Scope note:** rules about how the *handler* responds to admin calls (route shape, response contract, `enqueueJob` for cron-trigger routes, request scoping) are owned by `HANDLER_RULES.md`. This file lists only the admin UI agent's own rules — what the panel JS itself must look like.

(There is no per-capability JIT for the admin UI today — `subagents/prompts/capabilities/admin.py` is an empty registry. When the first scoped admin capability ships — App Bridge Toast / Modal / ResourcePicker / etc. — wire it through `admin_ui_agent.py:user_prompt` mirroring `widget_js_agent._build_jit_sections`.)

**Legend** — `validate?` = should this rule be enforced after the admin UI agent emits its JS module?
- **static** — structural / regex / AST check. HIGH precision (no false positives), implemented in `llm_validations/admin_ui_artifact.py` (regex / shared denylists) and `llm_validations/cross_admin_handler.py` (cross-artifact catalog matching).
- **llm** — semantic, prose, or judgment that won't survive a cheap structural check but is worth catching agentically (per `LLM_VALIDATORS_PLAN.md`).
- **no** — judgment/style/informational; high false-positive risk relative to value.
- **no (paranoid)** — structural rule the prompt + parse step already carry; model gets it right ~always. If it ever drifts, `bug_finder` (Sonnet + thinking) catches downstream impact, and the Shopify Admin iframe runtime fails-fast to load any module the browser can't resolve (no bare `import`s).

**`done?`** column — `✅` means the static-tier check is currently implemented in `admin_ui_artifact.py` (or `shared_checks.py` / `cross_admin_handler.py`). Blank for `llm` / `no` / `no (paranoid)` rows.

**One owner per rule** — every row has exactly one owner. No rule is enforced by both static AND llm.

**Static-validation principle:** only enforce a regex/AST static rule when (a) the failure mode has been seen with non-trivial frequency, (b) the check is cheap & structural with **near-zero false-positive rate**, (c) the blast radius is catastrophic (panel doesn't load, admin shell stylesheet broken, tenant cross-talk from hardcoded shop, silent data loss, dead UI filters), AND (d) the Shopify Admin iframe runtime / parse-time normalization / upstream architect checks don't already cover it. Everything else flows through the LLM validators (`agent_rules` + `bug_finder`).

**No `tsc` for admin code, same as widget.** The admin panel is plain ES module JavaScript loaded inside the Shopify Admin iframe via `<script type="module">`. There's no compile-time type check. The static layer carries weight here, but the four-bar policy still applies — bias toward letting the iframe runtime fail-fast on unloadable modules and toward `agent_rules` catching anything structurally clean but semantically wrong.

---

| # | rule | validate? | how | done? |
|---|---|---|---|---|
| **Module shape** | | | | |
| 1 | Export a named `mount(container, bridge)` function — the only allowed export from the panel module | yes | static | ✅ (`admin_ui_artifact` regex) |
| 2 | No React / JSX / framework — vanilla DOM only. No `import` statements, no `export default`, no JSX syntax, no `React.*` / `useState` / `useEffect` / `useRef` / `React.createElement` calls | no (paranoid) | — (Shopify Admin iframe loads the panel as an ES module via `<script type="module">`; bare imports fail to resolve at load time → fast deploy-time feedback; `agent_rules` catches drift inside the module) | |
| 3 | Output is raw JavaScript only — no markdown fences, no explanation prose | no (paranoid) | — (`AdminUiGenerator.parse()` strips fences and trims leading prose) | |
| **Forbidden globals** | | | | |
| 4 | No raw `fetch()` and no `XMLHttpRequest` — backend traffic goes through `bridge.call()` only | yes | static | ✅ (`admin_ui_artifact` `FORBIDDEN_ADMIN_UI_PATTERNS`) |
| 5 | No `eval()`, no `new Function()`, no `setInterval` | yes | static | ✅ |
| 6 | `setTimeout` allowed only as bounded debounce / throttle with a literal numeric delay ≤500ms | yes | static | ✅ (`shared_checks.find_setTimeout_violations`) |
| 7 | No `window.parent` / `window.top` / `window.opener` / `window.frames` — cross-frame access breaks the admin iframe isolation | yes | static | ✅ |
| **DOM scoping** | | | | |
| 8 | `document.*` denylist: `body`, `head`, `documentElement`, `cookie`, `title`, `write` / `open` / `close`, `execCommand`. CSS / scripts / style elements MUST be appended to `container`, never `document.head` | yes | static | ✅ (`shared_checks.find_document_violations`) |
| 9 | Prefer `container.*` for panel-owned DOM; legitimate page-level reads (`document.querySelector` / `getElementById`, `addEventListener` for keyboard shortcuts / outside-click / visibilitychange) are explicitly allowed | no | — (style preference; the document.* denylist at row 8 catches the actual hazards) | |
| **Hardcoded identifiers** | | | | |
| 10 | No hardcoded `tenant_id` / `tenantId` literal in the source — read identity from `bridge.context.tenantId` | yes | static | ✅ |
| 11 | No hardcoded shop domain (`*.myshopify.com`) and no hardcoded entity IDs — read from `bridge.context` or the route's response payload | yes | llm | |
| **Polaris styling** | | | | |
| 12 | No hardcoded hex colors except `#008060` (Shopify brand green). Use Polaris CSS custom properties (`--p-color-*`) for ALL other colors. Hardcoded hex breaks the merchant's theme (dark mode, high-contrast accessibility). | yes | llm | |
| 13 | Don't redefine the shell-* / btn-* / badge-* classes — the admin shell injects them into `container` BEFORE `mount()` is called. Use them directly in HTML; don't restyle them. | yes | llm | |
| 14 | Use Polaris design tokens (`--p-space-*`, `--p-border-radius-*`, `--p-font-*`, `--p-shadow-*`) for spacing / typography / shadow / radius — don't hardcode pixel values. | yes | llm | |
| **Catalog adherence** | | | | |
| 15 | Every `bridge.call(path, …)` path is one of the paths in `adminApiCatalog` — no invented paths | yes | static | ✅ (cross-checked against the architect's `adminApiCatalog`) |
| 16 | `bridge.call(path, body)` body uses EXACT field names from the catalog's `requestShape`; the panel reads EXACT field names from the catalog's `responseShape` (no renaming, no aliasing, no spreads that drop fields silently) | yes | llm | |
| **Pagination** | | | | |
| 17 | List-rendering UI uses the route's catalog-declared `page_size` and reads the standard `(page, page_size, items, total)` shape from the response — don't introduce a different limit in the panel | yes | llm | |
| **DOM safety** | | | | |
| 18 | Never use `container.innerHTML += "..."` AFTER any `container.appendChild()` call. innerHTML-assign serializes the DOM back to a string and re-parses it, destroying previously-appended nodes and their event listeners. Safe pattern: assign `container.innerHTML = '...'` ONCE at start of `mount()`, then `appendChild(styleEl)` for the trailing `<style>`. | yes | llm | |
| **Backend interaction** | | | | |
| 19 | When a button triggers a `bridge.call()`, disable it while the call is pending to prevent double-submit | yes | llm | |
| 20 | Handle `bridge.call()` rejections gracefully — show an error message (banner, inline error, or `bridge.notify(msg, "error")`) in the UI; never let the panel hang silently or render in an inconsistent partial state | yes | llm | |
| **Silent data loss** | | | | |
| 21 | A panel with EXPLICIT form submission (`<button type="submit">`, `addEventListener("submit", …)`, `.submit()` call) MUST call `bridge.call()` somewhere — otherwise collected data is silently discarded. | yes | static | ✅ (after tightening — see audit findings below) |
| 22 | The broader case — a panel with input controls and a click-handler that LOOKS like a data submission but never dispatches to `bridge.call()` — distinguish from legitimate read-only UI (filters, navigation, modal close buttons). | yes | llm | |
| **Enum vocabulary cross-check (admin UI ↔ dbContracts)** | | | | |
| 23 | Filter buttons, status badges, and conditional rendering branches reference ONLY the literal status values declared in some `dbContracts` column-level `enum` (or the `stateMachine` from/to vocabulary). Inventing values like `'converted'` / `'skipped'` that no column or transition emits leaves dead UI options the merchant cannot act on. **Distinguish from UI-only state attributes** (`data-status="loading"`, `data-status="submitting"` for in-flight indicators, `data-state="open"` for modal/disclosure widgets) — those are NOT filter values. | yes | llm | |
| **Cross-artifact field alignment** | | | | |
| 24 | Field names the panel sends via `bridge.call()` body must match what the handler reads from `req.body` for the corresponding `adminRouter.post(path, …)` route | yes | static | ✅ (`cross_admin_handler.py` after rewrite — see audit findings) |

---

## Audit changes (2026-04-28) — method-aware bridge.call SDK + admin proxy

Documented case (cart-recovery generation, run
`2026-04-28T16-17-38_recover-lost-sales-by-automatically-reminding`) where
the architect declared GET `/reminders` and GET `/abandoned-carts` in
adminApiCatalog, the admin agent obediently called `bridge.call(path,
{filters})`, the handler agent obediently wrote `adminRouter.get(path,
async (req, res) => { const {…} = req.query; … })` — and the cross-handler
validator FP'd "never reads req.body — collected data is silently
discarded" 8 times across two retries. Worse: at runtime the bridge SDK
was hardcoded to POST and the platform-back admin proxy was POST-only, so
the GET catalog declaration was a lie at every layer.

Fix shipped this round (paired with the matching widget changes):

- **`AdminShell.tsx:makeBridge` SDK now derives method from a catalog
  manifest** baked into the served bundle. The manifest comes from
  `Bundle.adminCatalog` (Pydantic + Zod schemas updated in lockstep) and
  is prepended as `window.__PLATFORM_CATALOG__ = [...]` by
  `platform-back/apps/api/src/lib/bundle-storage.ts:saveBundles`.
  `bridge.call(path, args)` looks up `path → method` and dispatches
  GET-with-querystring vs POST-with-body. Defaults to POST when the
  path is absent from the manifest.
- **`platform-back/apps/api/src/routes/admin.ts` admin proxy now accepts
  GET** in addition to POST. On GET the proxy forwards the query string
  verbatim to the handler; on POST it forwards the raw body bytes (as
  before). Mirrors the widget edge proxy which already supported both.
- **`cross_admin_handler.py` is now method-aware.** Row 24's structural
  field-name match scans `req.body` on POST routes and `req.query` on
  GET routes, source of truth being the architect catalog passed as
  the third argument.
- **`AdminBridge.call` interface** signature updated:
  `(path: string, args?: unknown) => Promise<unknown>` (the second arg
  is no longer a "body" — it's args that the SDK encodes per method).
  No call-site changes needed; the type docstring captures the new
  semantic.
- **`chat_local.py:_save_generated_files`** prepends the same manifest
  to locally-saved `admin_ui.js` so dev-loop testing matches deployed
  behaviour.

Row classifications unchanged. Like the widget side, this is a
sub-genre of `Cross-artifact-context FP` resolved at the SDK and
validator layers without reclassifying any rule.

## Audit fixes applied this round

All issues flagged during the audit have been resolved, plus one additional reclassification surfaced during static-safety review.

- **`cross_admin_handler.py` rewritten** for the current Express `adminRouter.<method>("/path", async (req, res) => …)` harness shape. The earlier version was anchored to the legacy `ctx.adminPath === "/path"` / `ctx.adminBody` harness and silently matched nothing — the cross-artifact field-shape check (row 24) was effectively disabled for every admin app. Now scans `bridge.call(path, { fields })` against matching `adminRouter` route bodies via balanced-brace scan + `req.body` destructure / `req.body.<field>` access collection. Mirrors the `cross_widget_handler.py` rewrite from the previous round.
- **`strip_comments_and_strings` scrubber wired into `admin_ui_artifact.py`** for every token-level regex (mount export, FORBIDDEN list, document.* denylist, setTimeout, tenant_id). Path-arg extraction (`bridge.call`) and the form-submission `type="submit"` HTML-attribute signal continue to use raw source — the literal contents inside the quotes are exactly what those checks need.
- **Form-submission heuristic tightened** to the explicit-submit signal only (`type="submit"` / submit listener / `.submit()` call). The FP-prone click+input branch was removed; the broader case is now row 22 (llm).
- **`import` / `export default` dropped from `FORBIDDEN_ADMIN_UI_PATTERNS`** for consistency with widget. The Shopify Admin iframe loads the panel as an ES module via `<script type="module">`; bare imports fail to resolve at load time → fast deploy-time feedback. Same downstream gate logic as the App Block runtime on the widget side. `agent_rules` covers semantic drift inside the module body. Both rules are now `no (paranoid)` (rows 2/3 in this table).
- **Row 23 (`_check_admin_ui_enum_filters`) reclassified static → llm** and removed from `admin_ui_artifact.py`. The static heuristic failed three of four bars: non-trivial FP risk on UI-only `data-status="loading"` / `data-status="submitting"` attributes and error messages embedding literal comparisons (`'status === \'wrong\' is rejected'`); UX-degradation rather than catastrophic blast radius (always-empty filter bucket); and the canonical detection requires distinguishing UI-state attributes from dbContracts-column filter attributes — semantic work `agent_rules` can do but a regex cannot. Vocabulary enforcement is now owned by `agent_rules` using cross-artifact context (admin UI + dbContracts + stateMachine + handler writes), with explicit prompt guidance to avoid the UI-state-attribute FP class. The `_format_state_machine` and `_format_column_enums` user-prompt scaffolding in `admin_ui_agent.py` remains in place — that's the prevention side.

---

## Counts

- **24 rules** total across the admin-UI prompt + agent surface
- **21 validate** → **10 static** rule-rows (✅ all enforced today across `admin_ui_artifact.py` + `shared_checks.py` + `cross_admin_handler.py`) + **11 llm** rule-rows deferred to `agent_rules` + `bug_finder`
- **3 skip** → **1 no** (style: container-preference for legitimate page reads) + **2 paranoid** (Shopify Admin iframe runtime catches imports / non-`mount` shapes; `parse()` handles output-format normalization)
- **0 critical static gaps** under the four-bar policy.

---

## Static implementation map (post-fix target)

The static-yes rule-rows above (✅) are covered by checks in:

- **`llm_validations/admin_ui_artifact.py`** (regex pass + heuristics, all running against scrubbed source after the audit fix):
  - Row 1 — `export\s+function\s+mount\b` regex.
  - Row 4 — `FORBIDDEN_ADMIN_UI_PATTERNS` covering `fetch(`, `XMLHttpRequest`.
  - Row 5 — same FORBIDDEN list covering `eval(`, `new Function(`, `setInterval(`.
  - Row 7 — `\bwindow\.(parent|top|opener|frames)\b` regex.
  - Row 10 — `\btenant[_-]?id\s*[:=]\s*['"]` regex.
  - Row 15 — `bridge.call(...)` path scan cross-checked against `adminApiCatalog`.
  - Row 21 — explicit-submit signal: `type="submit"` / submit listener / `.submit()` call AND no `bridge.call(`. Tightened from the prior heuristic that also combined click + input.
- **`utils/static_validations/shared_checks.py`** (shared with `widget_artifact.py`):
  - Row 6 — `find_setTimeout_violations`.
  - Row 8 — `find_document_violations` denylist.
- **`llm_validations/cross_admin_handler.py`** (cross-artifact admin↔handler field-shape match, after rewrite for the Express harness):
  - Row 24 — scans `bridge.call(path, { fields })` in admin UI JS, scans `adminRouter.post(path, async (req, res) => { … })` route bodies in the handler bundle, cross-checks field-name sets between the panel body and the handler's `req.body` destructure / `req.body.<field>` access.

**Parse-time normalization (not validation):** `AdminUiGenerator._sanitize_dom_access` auto-rewrites `document.head` / `document.body` references to `container` before validation runs — same shape as widget.

---

## LLM coverage

- **`agent_rules.py` SYSTEM_PROMPT** — extended with a new "ADMIN UI — what to look for:" section covering the 11 LLM rule-rows in this table (hardcoded shop/entity-IDs, Polaris styling discipline, request/response shape adherence, pagination consistency, DOM-write safety, button-disable + error-handling UX, click-as-submit pattern, enum vocabulary). Enum-vocabulary paragraph explicitly carves out UI-state attributes (`data-status="loading"` / `data-state="open"`) so the rule fires only on real column-filter contexts, not DOM-state markers. Includes the standard "don't re-flag what `admin_ui_artifact.py` already catches" carve-out.
- **`bug_finder.py` SYSTEM_PROMPT** — Cross-artifact mismatches paragraph extended this round with admin-specific cross-artifact concerns: enum-vocabulary mismatch (admin UI references status values that no column enum or stateMachine transition emits), pagination-shape drift (admin renders fields the handler doesn't return; admin uses a `page_size` the catalog never declared), and the cronSchedule manual-trigger gap (cronSchedule non-null but adminApiCatalog has no manual-trigger POST or admin panel never calls one). Plus the admin↔handler field-shape case carried over from the widget round.
