# Generation Quality Plan

Raise generated apps to a reliable **4/5** — production-grade, no
runtime-crashing bugs, no silently-dead features, no Shopify-protocol
violations. This plan follows the single-agent pivot
(`GENERATOR_PIVOT_PLAN.md`) and fixes the three problems that pivot left
open: the HLD agent was never adapted to the single-agent world, the
coding agent picks the wrong webhook topics, and the deterministic
safety net the pivot promised was never built.

---

## 1. The target — what 4/5 means, operationally

The rubric is the contract every generation is measured against.

- **5/5** — tsc clean, deploys, every webhook topic correct *and*
  subscribed, every UI action round-trips to a real DB row, all Shopify
  multi-step protocols correct (discount created→applied, dedup, variant
  resolution), no runtime crashes on the golden path or the edge cases
  named in the prompt's `qualityBrief`.
- **4/5** — same, but with at most cosmetic / non-crashing gaps (a
  missing pagination affordance, a non-ideal-but-correct query). **No
  data corruption, no silent feature death, no crash.**
- **≤3/5** — any one of: a runtime crash, a feature unreachable through
  the UI, a fabricated identifier passed to Shopify, a wrong/missing
  webhook topic, data corruption on retry.

The line between 4 and 3 is the bar: **no crashes + no silent feature
death + no protocol violation.**

---

## 2. Root cause — why we're below 4

The pivot's central bet was: *one agent plans and implements;
deterministic gates replace the LLM validators.* The first half
shipped (`w_coding_agent` exists; the LLD/codegen/validator agents are
gone). **The second half did not:** `renderer.py` and `integrity.py`
do not exist, and `done()` (`tools.py`) just flips a flag. So the
coding agent's *only* gate today is `tsc`, which cannot see
protocol/logic bugs. That is strictly weaker than the old pipeline on
exactly the bugs we care about.

Three downstream symptoms, all rooted there:

1. **HLD not adapted.** `c_hld_agent/prompt.py` still defers ~13
   decisions "to the LLD" — topic mapping, SQL types, indexes,
   constraints, bulk pre-fetch, row-locking. The LLD is gone; those
   decisions now have **no owner** and fall on the coding agent with
   only domain-level hints. `e_hld_v_agent/prompt.py` still judges the
   plan by "would this mislead the LLD" — optimizing for a reader that
   no longer exists.

2. **Wrong webhook topics.** The HLD deliberately omits the topic; the
   coding agent maps domain-event→topic alone, and nothing verifies the
   choice. Worked example from the one test run:

   | HLD event (domain) | signalFields promised | Topic picked | Problem |
   |---|---|---|---|
   | "an order is paid" | order id, variant ids, total | `orders/paid` | correct |
   | "variant inventory reaches zero / recovers" | **variant external id**, inventory level | `inventory_levels/update` | payload carries `inventory_item_id` + `available`, **not** a variant id — the agent had to invent an Admin GraphQL hop, using a non-standard `shopifyClientFor({shopDomain})` instead of the zero-arg form `webhooks.md` mandates |
   | "a product variant is permanently deleted" | variant id, product id | `products/update` | early-returns if `variant_gids` absent/empty — the "silently disable the feature" pattern §1 of the pivot plan called out |

3. **Protocol violations.** The documented mechanism to prevent
   discount-create-then-apply / dedup / variant-resolution bugs (Track B
   helpers, Phase 6) was deferred and never built.

The common thread: the old HLD was calibrated to hand *semantic* fields
to an LLD that would map them onto real Shopify payloads. With the LLD
gone, the coding agent receives domain fields that are sometimes
*unmappable without an API hop it has to invent itself* — and nothing
checks whether it got it right.

---

## 3. The model — three stages, kill each bug class at the cheapest one

Every bug class gets handled at the **earliest, cheapest stage that has
enough information to catch it.** Only the irreducibly post-hoc,
cross-file classes reach the expensive stage.

- **Plan time (HLD + `e_hld_v`)** — anything that's a *decision* (which
  topic, which op, does a field need a hop). One bad decision poisons
  many files, so catching it here is the highest leverage. Cheap:
  catalog-grounded, no code.
- **Prevention (component rules + platform helpers + prompt)** —
  anything that's a *house pattern* the agent just follows. If the rule
  + helper make the right path the easy path, there's nothing to detect.
- **Downstream validator (LLM judging code)** — the *expensive* stage,
  and the one the pivot deleted for cause. A class lands here **only
  if** it (a) can't be decided at plan time and (b) can't be prevented
  by a rule — because it's an *emergent, cross-file property* that only
  exists once code is written.

### Bug-class allocation

| # | Class | Stage | Why there |
|---|---|---|---|
| 1 | Webhook topic-fit | **Plan** | it's a decision (which topic) |
| 4 | Shopify op selection | **Plan** | it's a decision (which op) |
| 5 | Field needs a resolution hop | **Plan** (`payloadBindings`) | decided when binding the payload |
| 6 | Access scopes | — | the platform registers scopes; not a per-generation concern |
| 9 | Money correctness | **Prevention** | `money` helper + `backend.md` rule |
| 10 | Heavy work in webhook | **Prevention** | `webhooks.md` already mandates cron offload via `enqueueJob` |
| 2 | Shopify-effect not realized / wired | **Downstream** | can't see at plan time whether the op was actually called or the id threaded; cross-file |
| 3 | Write-path integrity (UI→DB) | **Downstream** | only exists once UI + route are both written |
| 7 | Idempotency / races | **Downstream** | a property of the SQL emitted |
| 8 | Null-disables-feature | **Downstream** | a property of the handler body |

Prevention is demand-driven: we do **not** pre-build a validator for
9/10. If those bugs recur despite the rule + helper, *then* promote the
class to a downstream check.

**Track B (typed platform helpers) is dropped.** The helper catalog is
open-ended, and a helper only ever lands *after* a bug has shipped once,
so it doesn't prevent the first occurrence. Dropping it shifts the weight
onto two things instead: the HLD must describe multi-step Shopify
protocols explicitly (§4), and the Shopify-effect validator must catch
when the code didn't follow them (§6).

---

## 4. HLD realignment — make it Shopify-aware

`c_hld` becomes a **tool-using agent** with the same catalog tools the
coding agent has (`list_webhook_family`, `get_webhook_topic`,
`list_shopify_ops`, `get_shopify_op`). **One agent, two phases:**

- **Phase 1 — domain.** Reason in domain terms via the existing
  self-test; this still produces the right data model.
- **Phase 2 — Shopify resolution (new).** Use the catalog tools to bind
  the plan to concrete Shopify.

### Phase-2 output (the contract the coding agent implements against)

- **Per external-event trigger:** `shopifyTopic` (resolved string) +
  `payloadBindings` — each signalField mapped to *either* a real payload
  path *or* a declared resolution hop
  (e.g. `"variant external id": resolve via inventoryItem GraphQL query
  from inventory_item_id`). This is what would have caught the inventory
  bug at plan time.
- **Per `shopify-*` capability:** the Shopify op(s) it resolves to.
  - *Single-op capabilities* bind one op name (e.g. `discountCodeBasicCreate`).
  - *Multi-step protocols* bind an **ordered sequence of steps**, each
    step naming the op plus what it *produces* and *consumes*
    (e.g. apply-bundle-discount = step 1 `discountCodeBasicCreate`
    → produces a discount code; step 2 apply that code to the cart
    → consumes the code from step 1). Without Track B helpers, the plan
    is the only place this protocol knowledge can live before the agent
    writes code — and the per-step produces/consumes is what makes the
    Shopify-effect validator (§6) able to check the sequence was honored.
- **Dropped:** `accessScopes` — the platform registers scopes.

This prevents classes 1, 4, 5 at the source. The cost: `c_hld` stops
being a one-shot JSON producer and loses its "integration-agnostic"
property — acceptable for a Shopify-only generator, and consistent with
the pivot's "fewer brains, each fully informed."

### `e_hld_v` repurposed

Strip the dead "would this mislead the LLD" framing. New, narrow job:
confirm the topic fits the event, the op fits the capability, and every
`payloadBinding` is a real field in that topic's payload or a declared
hop. Catalog-grounded, no code. (Kept for now; revisit later.)

---

## 5. Deterministic backbone

**Corrected after reading the template** — the pivot's §3.2 claim ("render
`server.ts`, migrations, and webhook config from app.json") was wrong for
this template:
- `server.ts` is **static and complete** in the template; routes are
  registered *inside* the generated `widget.ts`/`admin.ts` routers. Nothing
  to render — the agent just must not touch it.
- Webhook **subscription** is owned by
  `platform-back/packages/deployer/src/webhook-registrar.ts` (outside
  `platform-ai`, already built). The renderer doesn't produce it.
- So the renderer's only job is the **migration** (`app.json.database` →
  one `.sql`) — and that is **deferred** (§8) until quality is at 4/5.

What stays in scope as a quality gate is **`integrity.py`** — structural
checks run *inside* `done()` (the loop breaks on `done()`, so it's the
natural gate; on failure return `incomplete_reason` to keep the agent
fixing in-loop):
- every subscribed `webhookTopic` has a handler key in `webhook-handlers.ts`;
- every `httpRoute` is registered in its router file;
- `app.json` parses; `tsc` clean (backend **and**, per Phase 1, the UI pass).
- **Dropped gate:** "topic exists in catalog" — observed never violated,
  and the topic now comes from the HLD and is validated by `e_hld_v`.

Structure only — no semantic judgment, no false positives, no LLM.

---

## 6. Downstream micro-validators — general invariants only

Three narrow, single-purpose validators. **The criteria are universal —
never app-specific.** The app-specific bug is caught as an *instance* of
a general rule. Each runs on **Haiku** (narrow scope makes it both safe
and cheap), is **advisory and never mutates code** (it emits findings
fed back to the coding agent's loop; the agent fixes its own code — this
kills the "validator disabled the feature" failure mode).

The three are symmetric: integrity on the way **in** (UI→DB), integrity
on the way **out** (DB/logic→Shopify), and safety of the **DB ops**
themselves.

1. **Write-path integrity (UI → DB)** — *every reference/identifier
   column the plan declares must be populated, on every write path, from
   real data (a picker result field, a prior GET response, user input) —
   never a literal, `"0"`, `[]`, or `?? placeholder`, and never a field
   the UI doesn't actually send.* (class 3). Instances: the
   `variant_external_ids: []` empty-write bug **and** the
   `product_external_id = "0"` placeholder bug.
2. **Shopify-effect integrity (logic → Shopify)** — *for every capability
   the plan marks `integration: shopify-*`, the code must actually invoke
   the bound op(s) — every step of a bound sequence — not fake the effect
   with a property or a client-side return; and every id passed to an op
   must trace to a prior op's response or the request, never a literal.*
   (class 2). Instances: the faked-discount bug (op absent), the
   `BUNDLE-XXXX` fabrication, and "created the discount but never applied
   it" (a dropped step in the sequence). Also flags heavy inline webhook
   work missing cron offload.
3. **Persistence-safety** — *every INSERT/UPDATE on a table with a dedup
   key (from app.json) uses `ON CONFLICT`, never `SELECT-then-INSERT`;
   and no early-return guards a field the plan bound as required.*
   (classes 7, 8).

### How they stay general yet catch breadth

A validator never checks "does this app do its job." It checks a
**structural correspondence between the plan and the code that every
generated app shares** — capability↔op, reference-column↔real-source,
dedup-key↔`ON CONFLICT`. The merchant's domain lives only in the *data*
fed to the validator; the *rule* is about the joint, which is universal.
So one rule covers bundles, loyalty, subscriptions, abandoned-cart alike.

Breadth comes from anchoring to the **plan's own enumeration**, not a
fixed checklist. A checklist catches only *anticipated* bugs; these
iterate the plan's declarations (every reference column, every shopify
capability, every dedup key) and confirm each is honored in code — so
coverage scales with the plan and catches the unforeseen instance too.

**The honest boundary:** these catch "the code didn't honor what the
plan declared." They do *not* catch "the plan declared the wrong thing"
(that's the HLD + `e_hld_v`, upstream) or a pure-logic bug that touches
no declared joint (an off-by-one in tier math — that falls to the rubric
+ the measurement harness). No single layer is complete; the split is
principled: structure→backbone, plan-honored→validators,
plan-correct→HLD, the rest→measurement. This is *why* the Shopify-aware
HLD is the foundation — the richer the structured spec, the more joints
the validators can check generically.

### General criteria, app-specific *aim*

App-specific information is allowed to do **two things only**, never to
define correctness:

- **Narrow *where to look*** — route the Shopify-effect validator to the
  files implementing each `shopify-*` capability; route the write-path
  validator to each UI→route write pair. Shrinks tokens, sharpens focus.
- **Supply *intent context*** — hand the validator the relevant **HLD
  plan fragment** so it judges against intent ("the plan declares a
  write; a code path that writes zero rows violates it"). The criterion
  stays general; the plan only says what was declared.

**Both are derived from the HLD's *structured* output — not from a
free-text "explanation" agent.** Structured routing is mechanical (no
blind spot) and costs nothing extra; a prose-generating checklist agent
would (a) reintroduce the shared blind spot the pivot deleted validators
for, and (b) be per-app and thus uncacheable. *Narrow the `where`, keep
the `what` general.*

---

## 7. Cost discipline

Generation cost is a first-class constraint; the architecture reflects
it.

- **Prompt caching, everywhere.** `loop.py` already marks the coding
  agent's system prompt `cache_control: ephemeral, ttl 1h`. Extend the
  same to the HLD agent and the validators.
- **One shared, cached Shopify-catalog block across HLD *and* coding
  agent.** Both now read the same catalog; structured as a common cached
  prefix, the cache-write is paid once and both sides read cheaply.
- **Static validator prompts cache across every run.** Because the
  validator criteria are general (not app-specific), each validator's
  system prompt is identical hour after hour — paid once, read cheaply.
- **Haiku validators + minimal inputs + single-pass advisory.** Three
  narrow Haiku passes, each fed only its slice, emitting small findings,
  is far cheaper than the old pipeline's big Sonnet validators retrying
  3–4×. Findings feed back into the coding agent's *already-cached* loop
  — no separate `retry_suffix` orchestration.
- **HLD tool calls are cheap.** Catalog lookups are small outputs
  against a cached prefix — far cheaper than the coding agent flailing on
  a wrong topic and then a fix loop.

Target unchanged from the pivot: **≤60% of the baseline tokens per
generation.** The upstream tool calls we add are cheap and *prevent* the
expensive downstream retries.

---

## 8. Phased implementation

Sequencing reflects a decision to **fix generation quality to 4/5 first,
and defer all deployment plumbing** (migration renderer + scaffold→deploy
bundle assembly, see §5 / §8-deferred) until quality is there.

### Phase 0 — evaluation skill (do first)
A Claude Code skill (`.claude/skills/evaluate-generation/SKILL.md`) that,
loaded in any session and pointed at a run dir, produces a structured
`evaluation.md` grading the generated app 1–5 against §1 with per-bug-class
findings (`file:line` evidence), a capability-realization list, and
severity-classified counts (crash / silent-feature-death /
protocol-violation / cosmetic). Fixed template so runs diff cleanly — this
is the regression/improvement signal for every change below. Constraints:
**token-efficient, relaxed (lightweight) output grammar.**
- *Scope:* evaluates generated **artifacts** only (live deploy-and-test
  waits on the deferred assembly step).
- *Grader:* LLM judgment by the loading agent, reading code against the
  checklist. **No deterministic shell-out anchors at this stage** (grep
  for `?? "0"`, `SELECT`-then-`INSERT`, etc.); add them later only if LLM
  grading proves unreliable.

### Phase 1 — deterministic UI type gate
Add a second `tsc` pass in `tsc_runner.py` for `scaffold/admin/ui.ts` +
`scaffold/widget/widget.ts` against a browser tsconfig referencing the SDK
types (`platform-shopify-admin/src/types.ts` for admin; author a `Host`
type for storefront if none exists — flag before touching anything outside
`platform-ai`). Today these files are **never type-checked** (§3, §5), yet
that's where Bug B lived. Deterministic, no false positives. Complements
the §6 write-path validator (tsc kills wrong-shape; the validator covers
type-clean placeholders/empties).

### Phase 2 — HLD realignment
Make `c_hld` a two-phase tool-using agent; add Phase-2 bindings to the
schema (§4, incl. op *sequences* for multi-step protocols); strip dead LLD
references from `c_hld` and `e_hld_v`; repurpose `e_hld_v` to validate
bindings.

### Phase 3 — downstream micro-validators
Build the three general validators (§6) on Haiku, advisory/non-mutating,
aimed via the HLD's structured output. Wire findings back through `done()`
into the coding-agent loop (§5).

### Phase 4 — measure & tune
Re-run the Phase-0 skill across archetypes. Tune component rules, the HLD
prompt, and validator checklists where gaps surface. Promote prevention
classes (9/10) to validators only if they recur.

### Deferred until generation is solid at 4/5
- **Migration renderer** — `app.json.database` → `migrations/0002_app.sql`
  (must sort after `0001_template_baseline.sql` and pass the deployer's
  `sql-validator.ts`). Fully specced by `db.md`.
- **Scaffold → deploy-bundle assembly** — package the scaffold into the
  `Bundle` contract `platform-back` consumes (`contract/validators.py`:
  `handlerModule.files`, `dbMigration`, `widgetCatalog`/`adminCatalog`,
  etc.). The pipeline currently dead-ends at `scaffold/`; this is what
  unblocks live deploy-and-test (and richer Phase-0 measurement).

---

## 9. Success criteria

1. A regenerated bundle app (same prompt as the analyzed run) scores
   ≥4/5: discount actually applies, item pool is populated through the
   UI, variant-deletion auto-disable is reachable, no runtime crash.
2. The three correct webhook topics are chosen and subscribed; every
   `payloadBinding` resolves to a real field or a declared hop.
3. ≥4/5 sustained across 3–5 archetypes, not just the bundle app.
4. Tokens per generation ≤60% of the pivot baseline.
5. Every validator finding is a *general* invariant violation — no
   app-specific check anywhere in a validator prompt.

---

## 10. Open questions

- **Scoring harness mechanics** — fully automated (deploy + simulated
  webhooks + assertions) vs. a structured human/LLM checklist per
  archetype? Phase 0 needs a concrete design.
- **Protocol validator model** — start on Haiku; bump *only that slice*
  to Sonnet if measurement shows it misses cross-file id tracing.
- **HLD two-phase shape** — one prompt with two sections vs. two
  sequential tool-use rounds within the same agent. Decide during
  Phase 2.
- **Does `e_hld_v` survive long-term**, or do its binding checks fold
  into the deterministic backbone + the HLD's own self-verification?
  Revisit after Phase 4.

---

## 11. Appendix — autopsy of the single-agent bundle run

Findings from the first committed single-agent run
(`platform-ai/cli/test_results/2026-05-20T21-57-13_smoke_w_coding_agent`,
bundle app). They shaped §4 and §6.

**What improved.** The agent followed the topic-selection process
(`list_webhook_family` ×3 → `get_webhook_topic` ×4 *before* writing) and
picked all four correct topics — `orders/paid`, `inventory_levels/update`,
`products/update`, **and** `products/delete` (the prior run missed
delete). So the wrong-topic problem is **intermittent (prompt-adherence),
not a capability gap** — which is exactly why moving the topic into an HLD
binding (§4) turns something probabilistic into something deterministic.

**Bug A — discount silently never applies.** `widget.ts` `POST
/widget/cart/add` returns line items with a cosmetic
`properties._discount_rate` and `success: true`; the storefront adds them
via Ajax `/cart/add.js`. **No discount op is ever called** (the agent only
inspected the `nodes` and `product` storefront ops). The widget shows
"20% off," the items enter the cart, the customer pays full price. The
merchant's core feature is silently dead.

**Bug B — `product_external_id` written as `"0"`.** `admin/ui.ts` reads
`p.product_id ?? "0"` from the variant picker (comment: *"we'll use
placeholder"*), so every `bundle_items` row stores `product_external_id =
0`. The `products/update` / `products/delete` handlers match deletions by
`WHERE product_external_id = ${productId}` — which never matches `0`. So
variant-deletion auto-disable is broken again, this time from a fake
reference written upstream, not a wrong topic.

**The unification that reshaped the validators.** A and B are instances of
one principle — *references must derive from real data, never fabricated
or placeholder* — spanning **both** directions (UI→DB and DB→Shopify).
Plus a shape the original framing missed entirely: **a declared Shopify
effect that is never realized in code** (Bug A isn't a *bad* id, it's the
*absence* of the op). Hence §6's symmetric three: write-path integrity
(in), Shopify-effect integrity (out), persistence-safety.
