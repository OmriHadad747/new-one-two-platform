# Storefront Agent — Example Library & Prompt Plan

**Goal:** make the storefront agent ([platform-ai/subagents/e_storefront_agent/prompt.py](platform-ai/subagents/e_storefront_agent/prompt.py))
production-grade across the MVP app catalog without bloating the system
prompt or speculating on shapes we don't actually need.

**Owner:** storefront agent owner
**Status:** proposal, awaiting review

---

## 1. Problem

The storefront agent today ships **one** worked example — a custom-engraving
widget at [prompt.py:276–516](platform-ai/subagents/e_storefront_agent/prompt.py#L276-L516) — that demonstrates form-persistence with a paired GET state-check.

The MVP supports 27 storefront apps total:

- 16 in the original catalog: [docs/SUPPORTED_APPS_CATALOG.md](docs/SUPPORTED_APPS_CATALOG.md)
- 11 proposed additions: [docs/SUPPORTED_APPS_CATALOG_ADDITIONS.md](docs/SUPPORTED_APPS_CATALOG_ADDITIONS.md)

The single example covers **4 of 27 apps** cleanly (Wishlists, Price Drop,
Back-in-Stock, Waitlist). For the remaining 23 the agent improvises, and
improvisation is where bugs come from — silent locale-prefix regex misses,
fragile cart-event subscriptions, broken page-template state, etc.

We also discovered a hard **prompt-vs-app conflict**: 3 apps require
recurring updates (Flash Sale Countdown, Social Proof, Estimated Delivery),
but the prompt forbids `setInterval` and `setTimeout > 500ms` outright at
[prompt.py:546–550](platform-ai/subagents/e_storefront_agent/prompt.py#L546-L550). No example library fixes this — it's a rule problem.

---

## 2. Shape inventory across all 27 apps

Apps tagged by architectural pattern (a single app can have multiple shapes
when it composes patterns):

| Shape | # apps | Example today? |
|---|---|---|
| Form-persist with state-check | 4 | ✅ Engraving |
| Form-persist no state-check | 1 | ⚠️ Documented in prompt |
| Form-persist + list view | 1 (Q&A) | ⚠️ Extrapolate |
| **Stateless display** (config → render) | 5 | ❌ Missing |
| Stateless display + variant context | 5 (mostly combos) | ❌ Missing |
| Stateless display + localStorage source | 2 | ⚠️ Variant of stateless |
| **Cart-aware widget** | 2 | ❌ Missing |
| **Mutate existing page DOM** | 3 | ❌ Missing |
| **Modal overlay** | 7 | ❌ Missing |
| **Live-tick / polling** | 3 | 🚨 Prompt rule conflict |
| **Page-template widget** (full page) | 2 (FAQ, Store Locator) | ❌ NEW SHAPE |
| **Collection-grid DOM injection** | 1 (Quick View) | ❌ NEW SHAPE |

The two genuinely *new* shapes — page-template widget and collection-grid
injection — are not represented in the original 16 apps; they came from the
proposed additions.

---

## 3. Proposal — 5 examples + 1 rule change

### 3.1 Examples to add (in priority order)

| # | Example | Apps anchored | Why |
|---|---|---|---|
| 1 | **Stateless display** | Announcement Bar, Trust Badges, Cookie Consent, Age Verify, Lookbook (5 direct + base for 7 variants) | Highest leverage. Different lifecycle from form-persist — no GET, no submit, just fetch+render. |
| 2 | **Modal overlay** | Cookie, Age Verify, Size Chart, Comparison, Quick View, Newsletter, Lookbook tooltip (7) | Mounted-but-hidden lifecycle, focus trap, ESC-to-close, scroll lock. Distinct from inline widgets. |
| 3 | **Cart-aware widget** | Free Shipping Bar, Cart Drawer (2) | New event flow — fetch `/cart.js`, react to cart updates *without* depending on theme-specific events. |
| 4 | **Page-template widget** | FAQ Page Builder, Store Locator (2) | NEW shape. Full-page render, sub-routing via query params, search/filter, larger state. |
| 5 | **Mutate existing page DOM** | Currency Switcher, Pre-Order, Volume Discount price (3) | Touches elements *outside* container — needs a clean pattern for finding theme elements safely. |

**Existing example to keep as-is:** form-persist with state-check (engraving).

**Skipped examples (extrapolatable):**
- Q&A → form-persist + list display
- Recently Viewed → stateless + localStorage source
- Quick View → modal + page-DOM mutation combined
- Lookbook tooltips → stateless + tooltip

Revisit if the Level 1 test harness (§3.4) shows they fail.

### 3.2 Prompt rule change — timers

Current rule at [prompt.py:546–550](platform-ai/subagents/e_storefront_agent/prompt.py#L546-L550) forbids `setInterval` and `setTimeout > 500ms`. This was the right
default for *most* widgets but blocks 3 legit MVP apps. Replace with:

> **Live-tick widgets** (countdown, social proof, polling) MAY use
> `setInterval` or `setTimeout > 500ms` if ALL of the following hold:
>
> 1. The handle is captured and stored on the container
>    (`container.__appTickHandle = setInterval(...)`)
> 2. Minimum interval is 1000ms (no busy-loops, no sub-second polling)
> 3. The tick pauses when `document.visibilityState === "hidden"` and
>    resumes on `visibilitychange`
> 4. The widget exposes a teardown path so the runtime can call
>    `clearInterval(container.__appTickHandle)` on remount

Plus a tiny snippet showing the safe pattern. Roughly 15 lines of prompt.

### 3.3 Delivery mechanism — single source, mirror the LLD pattern

Mirror the existing LLD runtime-examples pattern at
[platform-ai/subagents/d_lld_agent/platform_runtime_examples.py](platform-ai/subagents/d_lld_agent/platform_runtime_examples.py):
single Python module with a `_EXAMPLES: Dict[str, str]` keyed by stable
bucket names, plus a dumb dispatcher that maps inputs → bucket name(s).
The codegen agent reads the dispatched output and appends it to the user
message — never imports the example module directly.

**Single source for ALL examples** — including the existing engraving body,
which is extracted out of `prompt.py` into the same module. After the
move, [prompt.py](platform-ai/subagents/e_storefront_agent/prompt.py)
shrinks by ~240 lines and stops carrying any example body; it just
references "the worked examples appended to your user message."

```
subagents/e_storefront_agent/
  widget_examples.py          # mirrors platform_runtime_examples.py
    _EXAMPLES = {
      "form_persist_state_check": "...",   # the engraving body, extracted
      "stateless_display": "...",
      "modal_overlay": "...",
      "cart_aware": "...",
      "page_template": "...",
      "mutate_page_dom": "...",
      "live_tick": "...",                  # added with §3.2 rule change
    }
    def examples_for_widget(lld, intent) -> list[str]: ...
  agent.py                    # calls examples_for_widget(), appends to user msg
  prompt.py                   # no example bodies
```

**Inject ALL applicable buckets — no cap.** Most apps need 2–3 buckets;
worst case is ~4 (e.g. Cart Drawer = `cart_aware` + `modal_overlay`). At
~1k tokens per example, even a 4-bucket case is ~4k tokens of examples
in the user message — well within budget.

**User message structured for prompt-cache hits on retries.** Anthropic's
prompt cache caches whatever prefix is marked with `cache_control:
ephemeral`, including in the user message. Order:

```
[examples block]            ← cache breakpoint here
[LLD + intent + catalog]    ← cache breakpoint here
[generation request tail]   ← uncached, volatile
```

Within the 5-min cache TTL, retries of the same widget hit the cache for
the entire example + LLD prefix and only pay for the volatile tail.
Inlining examples in the system prompt would NOT help here, because the
example set varies per app — that would just invalidate the system-prompt
cache per generation. The user-message cache breakpoint is strictly
better.

### 3.4 Dispatcher — single registry, three signal sources

To avoid the "many places to edit when adding a shape" problem, every
piece of shape metadata lives in ONE registry. The dispatcher and the
LLD agent both read from it.

**The registry —
`subagents/e_storefront_agent/widget_shapes.py`:**

```python
WIDGET_SHAPES: dict[str, dict] = {
    "form_persist_state_check": {
        "description": "GET+POST pair, mounted form, confirmed state",
        "example_js": "...",                    # the JS body
        "route_predicate": lambda routes: _has_get_and_post(routes),
        "text_keywords": [],                    # mostly route-inferred
    },
    "stateless_display": {
        "description": "fetch config / data → render. No form.",
        "example_js": "...",
        "route_predicate": lambda routes: _get_only(routes),
        "text_keywords": ["banner", "announcement", "badge"],
    },
    "modal_overlay": {
        "description": "renders a fixed overlay that gates page content",
        "example_js": "...",
        "route_predicate": None,
        "text_keywords": ["popup", "modal", "overlay"],
    },
    "cart_aware": {
        "description": "reads /cart.js, reacts to cart state",
        "example_js": "...",
        "route_predicate": None,
        "text_keywords": ["cart", "free shipping", "checkout total"],
    },
    "page_template": {
        "description": "fills full page region — sub-routing, search/filter",
        "example_js": "...",
        "route_predicate": None,
        "text_keywords": ["FAQ page", "store locator page", "full page"],
    },
    "mutate_page_dom": {
        "description": "changes elements OUTSIDE container",
        "example_js": "...",
        "route_predicate": None,
        "text_keywords": ["replace add to cart", "convert price", "swap button"],
    },
    "live_tick": {
        "description": "recurring updates — requires the timer-rule pattern",
        "example_js": "...",
        "route_predicate": None,
        "text_keywords": ["countdown", "ticking", "live updates", "refresh every"],
    },
    # adding a new shape = edit this dict only. Everything below
    # auto-picks it up.
}

def widget_shapes_section() -> str:
    """Render the LLD prompt's enum section from the registry."""
    lines = []
    for key, meta in WIDGET_SHAPES.items():
        lines.append(f"  {key}    {meta['description']}")
    return "\n".join(lines)
```

**Three signal sources, combined in the dispatcher:**

1. **Structured signal** — `lld.uxExpectations.widgetShapes: list[str]`
   populated by the LLD agent (see §3.4.1 for the LLD changes). Primary
   signal; takes precedence when present.
2. **Mechanical inference** — apply each shape's `route_predicate` to
   `lld.httpRoutes.widget`. Deterministic; no LLM. Covers the
   form-persist family from route shape alone.
3. **Heuristic keyword match** — fallback when (1) is empty. Mines
   `lld.uxExpectations.storefront` + `intent.qualityBrief` +
   `intent.desiredOutcome` against each shape's `text_keywords`.

```python
def examples_for_widget(lld, intent) -> list[str]:
    routes = lld.get("httpRoutes", {}).get("widget", [])
    declared = set(lld.get("uxExpectations", {}).get("widgetShapes") or [])
    text = " ".join([
        lld.get("uxExpectations", {}).get("storefront", "") or "",
        intent.get("qualityBrief", "") or "",
        intent.get("desiredOutcome", "") or "",
    ]).lower()

    shapes = set(declared)
    for name, meta in WIDGET_SHAPES.items():
        pred = meta["route_predicate"]
        if pred and pred(routes):
            shapes.add(name)
        if not declared:  # heuristic fallback only when LLD didn't classify
            for kw in meta["text_keywords"]:
                if kw in text:
                    shapes.add(name)
                    break
    return [WIDGET_SHAPES[s]["example_js"] for s in sorted(shapes)]
```

The "many places" problem is resolved: adding a shape = ONE edit to
`WIDGET_SHAPES`. The LLD prompt's enum section, the storefront
dispatcher, the schema validator, and the example library all pick it
up automatically.

### 3.4.1 LLD changes — the `widgetShapes` field

Concrete diff for the registry-backed structured field:

**`schema.py`** — add a registry-validated field:
```diff
 class UxExpectations(_StrictModel):
     storefront: Optional[str] = None
     admin: Optional[str] = None
+    widgetShapes: list[str] = Field(default_factory=list)
+
+    @field_validator("widgetShapes")
+    def _validate_shapes(cls, v):
+        from subagents.e_storefront_agent.widget_shapes import WIDGET_SHAPES
+        bad = set(v) - set(WIDGET_SHAPES.keys())
+        if bad:
+            raise ValueError(f"unknown widgetShapes: {sorted(bad)}")
+        return v
```

**LLD prompt** ([prompt.py:1285–1299](platform-ai/subagents/d_lld_agent/prompt.py#L1285-L1299)) —
auto-generate the enum from the registry instead of hard-coding:
```diff
 9. uxExpectations
   storefront      one or two sentences — what the customer experience...
   admin           one or two sentences — what the merchant dashboard...
+  widgetShapes    storefront archetypes only — list of architectural
+                   patterns the widget composes. Pick every pattern that
+                   applies — most widgets are 1–3 patterns. Closed enum:
+
+                   {widget_shapes_section()}
+
+                   Examples: Cart Drawer = ["cart_aware", "modal_overlay"];
+                   Quick View = ["modal_overlay", "stateless_display"];
+                   FAQ page = ["page_template"]. Empty list for non-storefront.
```

The `{widget_shapes_section()}` interpolation runs at module load,
pulling descriptions from the registry. Adding a shape regenerates the
prompt section automatically — no LLD prompt edit needed.

**Validator** — if there's an archetype-completeness check that asserts
`uxExpectations.storefront is not None` for storefront archetypes, add
the parallel:
```diff
 if is_storefront_archetype(plan):
     assert plan.uxExpectations.storefront is not None
+    assert len(plan.uxExpectations.widgetShapes) > 0
```

### 3.5 Level-1 test harness (jsdom)

Build a Node-only jsdom harness with a mock host. Each generated widget
runs through `mount(container, host)` against canned host responses;
assertions check: no crash, expected DOM, expected `host.call` invocations,
no leaks outside `container`.

- Cost: ~50–200ms per widget, fits in CI.
- Catches: undefined references, missing await, wrong response shape,
  broken submit flow, missing aria attributes.
- Misses: real layout, font/CSS bleeding, screen-reader behavior.

Treat as a quality gate for new examples (no example enters the library
without passing) and as a regression test on every codegen run.

Headless-browser tests (Playwright) for CLS / a11y are a possible Level 2,
deferred until Level 1 is stable.

### 3.6 Out of scope (deliberately)

- Rich pattern library of 10+ examples — premature without evidence the
  agent fails specific patterns. Add only what tests prove necessary.
- Theme-compatibility "hazard contract" with 12 rows (multi-instance,
  GDPR, RTL, etc.) — most are speculative. Locale-prefix regex is the
  one shipped bug worth fixing now (see §4).
- Headless-browser test layer.
- Agent-driven retrieval tool.

---

## 4. Bugs to fix in passing

While we're in here:

- **Locale-prefix regex** at [prompt.py:318](platform-ai/subagents/e_storefront_agent/prompt.py#L318):
  `/\/products\/([^/?]+)/` silently misses every locale-prefixed URL
  (`/de/products/...`, `/fr-ca/products/...`). One-line fix:
  `/\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?products\/([^/?#]+)/`. Ship in every
  example.

- **Variant re-mount assumption** at [prompt.py:587–594](platform-ai/subagents/e_storefront_agent/prompt.py#L587-L594):
  prompt assumes App Block re-mounts on variant change so widget can
  "snapshot variantId once." This needs verification in a current Shopify
  dev store. If false, the existing rule needs a popstate-based fallback;
  if true, leave alone. **One experiment, ~30 min.**

---

## 5. Sequencing

1. **Verify variant re-mount** in a Shopify dev store (one experiment).
   Decides whether the existing snapshot-once rule is correct.
2. **Fix locale-prefix regex** in the engraving example. One-line ship.
3. **Land the timer rule change** (§3.2). Unblocks Flash Sale, Social Proof,
   Estimated Delivery without authoring an example.
4. **Build Level 1 jsdom harness** (§3.4). Run it on the existing engraving
   output for sanity, plus a few previously-generated widgets if available.
5. **Author 5 examples** (§3.1) one at a time, each gated through Level 1.
   Order: stateless display → modal overlay → cart-aware → page-template →
   page-DOM-mutation.
6. **Wire deterministic injection** in `agent.py` (§3.3) once at least 2
   examples exist.
7. **Run end-to-end** on a sample of 5 apps from each category. Iterate
   based on what fails.

Estimated total work: ~3–5 days of focused effort, depending on harness
build-out and whether the variant experiment forces a prompt change.

---

## 6. Open questions for review

1. **Is "page-template widget" actually a different runtime?** In Shopify's
   theme app extensions, a custom theme template can host an App Block
   that fills the page. The `mount(container, host)` contract still
   applies — the widget just renders more. Does that hold for our
   platform? If yes, page-template is just "a bigger widget." If no, we
   need a separate runtime contract (and probably a separate generator
   agent).
2. **Should the timer rule allow polling, or only ticking?** Social Proof
   needs to *poll the backend* every ~30s for new sales. That's a
   `host.call(...)` inside an interval — meaningfully different from a
   pure-client countdown tick. Worth deciding whether the rule covers
   both, or only ticks (in which case Social Proof stays blocked and
   needs a different solution like server-sent events).
3. **LLD `widgetShapes` classification quality** — once the LLD agent
   starts producing `widgetShapes`, run a calibration pass against the
   test corpus and confirm the bucket choices match what a human
   reviewer would pick. The heuristic fallback in §3.4 catches gaps
   when the LLD's list is empty, but consistent miss patterns may mean
   the LLD prompt's enum descriptions need sharpening.
4. **Q&A and Quick View** — confident these extrapolate, or worth their
   own examples? Decide after Level 1 tests on a generated Q&A widget.

---

## 7. What was considered and rejected

For reviewer context — alternatives that were on the table:

- **10-pattern library** (originally proposed): rejected because de-duped
  it's really 5 patterns, and inlining all of them in the system prompt
  bloats every call regardless of relevance.
- **12-row theme-compatibility hazard table** (originally proposed):
  rejected because most rows are speculative for MVP merchants. Locale
  prefix is the one shipped bug worth fixing in §4. Currency, RTL,
  cookie-consent fallback, multi-instance collision detection — all real
  hazards but not evidence-based. Add when they bite.
- **Agent-driven retrieval tool** (user suggestion): rejected because the
  LLD already produces text we can dispatch on. Tool retrieval pays off
  when the agent has to *discover* relevance; here we already know.
- **Structured `widgetShapes` field on the LLD without a registry**:
  rejected. Initially this looked expensive — schema enum, LLD prompt
  section, validator, plus the storefront dispatcher all hold their own
  copy of the shape list, so adding a shape touches 4 files. The
  registry pattern in §3.4 dissolves that: one dict in
  `widget_shapes.py` is the single source, and the LLD prompt + schema
  validator + dispatcher all read from it. Adding a shape becomes a
  one-file edit, so we adopt the structured field as v1 (with heuristic
  keywords as fallback), not a v2 upgrade.
- **Capping examples at 1–2 per call**: rejected. Multi-shape apps
  (e.g. Cart Drawer = `cart_aware` + `modal_overlay`) need both. At
  ~1k tokens per example, the user-message budget easily absorbs 4
  buckets, and the prompt-cache breakpoint in §3.3 makes retries cheap.
- **Inlining examples in the system prompt for cache benefit**: rejected
  because the example set varies per app, which would invalidate the
  system-prompt cache per generation. A user-message cache breakpoint
  gets the same retry-cache benefit without the per-app invalidation.
- **Headless-browser tests as the starting point**: rejected because
  Level 1 jsdom catches ~80% of bugs at ~10% of the cost.
- **Multi-step wizard example** and **identity-read example** (earlier
  proposals): rejected after tagging the MVP — zero apps in the catalog
  need them.
- **"Richer/more complex" version of the existing example**: rejected
  because complexity teaches more code, not new pattern shapes. Pattern
  coverage > example richness.

---

## 8. Acceptance

This plan is good if:
- It covers all 27 MVP apps' shapes with 6 total examples (1 existing + 5
  new) and 1 prompt rule change.
- The system prompt size stays within ~10% of today's.
- Level 1 jsdom tests gate every new example.
- The locale-prefix and variant-remount issues are resolved before any new
  example is authored.

Reviewer: please challenge §3 priorities (am I right that stateless and
modal beat page-template?), §3.2 (is the timer rule safe?), §3.4 (are the
heuristic keywords sufficient, or should we go straight to a structured
LLD field?), and §6 open questions.
