# Generator Pivot Plan

Collapse the LLD + codegen sub-agents into **one agent with tools and a todo
list** — same loop model as Claude Code. The goal is a step change in
**functional correctness** of generated apps and a meaningful reduction in
**generation cost**, achieved by removing the inter-agent handoff that was
the source of cross-file alignment bugs.

> **Source of the analysis below**
> The bugs, token counts, and retry patterns referenced in this document were
> measured on the post-split generator state with separate `a_product_agent`,
> `c_hld_agent`, `e_hld_v_agent`, `g_ops_picker_agent`, `i_lld_agent`,
> `k_lld_v_agent`, `m_pre_codegen_agent`, `o_codegen_agent`,
> `q_codegen_v_agent`, `s_revision_agent`, `u_explenation_agent`.

---

## 0. How this plan evolved

This document went through three shapes before landing where it is. The
history matters because the rejected shapes still inform the design's
guardrails.

**Iteration 1 — Two tracks in parallel.**
- **Track A (scaffold-first codegen):** LLD emits real TypeScript files plus
  a shared `types/contracts.ts`. Per-file codegen agents fill bodies against
  the types. `tsc --noEmit` replaces LLM validators.
- **Track B (Shopify protocol helpers):** typed platform helpers
  (`ensureBundleTierDiscount`, `resolveVariantsForProducts`,
  `defineHandler<topic>`) absorb multi-step Shopify protocols so the agent
  has no typed path to do them wrong.

**Iteration 2 — Track A only, Track B deferred.** Helpers fix specific
Shopify-flavored bugs but don't address the general class — cross-file
alignment. Track A is the bigger lever. Track B becomes a contingency: build
helpers only for protocol patterns the agent demonstrably gets wrong.

**Iteration 3 — Track A folded into a single agent (current design).** The
LLD/codegen split was itself the source of drift. If one brain plans the
contracts and another brain implements against them, the handoff can fail.
Collapse them into one agent with read/write/tsc/todo tools, same model as
Claude Code. This is the endpoint of Track A — the LLD-as-architect role
doesn't need to be a separate agent at all.

**Track B is not dead, just postponed.** Section §7 Phase 6 keeps it as the
backstop: if specific Shopify-protocol bugs recur across archetypes despite
the single-agent design, add typed helpers that make the bug inexpressible
at the type level. Demand-driven, not pre-built.

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

## 2. The pivot in one paragraph

Replace the "LLD emits JSON → four codegen sub-agents each write a slice"
pipeline with a **single codegen agent** that has read/write/tsc/todo tools
and produces the entire scaffold itself. Upstream agents (product, HLD,
ops-picker) stay; they feed the single codegen agent. Downstream validators
are deleted. The retry signal becomes `tsc --noEmit` errors the agent fixes
via its own tool calls, inside the same loop.

The same brain that decides the contracts is the brain best placed to
implement against them. Removing the handoff removes the drift.

---

## 3. Architecture

### 3.1 Tool surface

```
read_file(path, offset?, limit?)         -> str
write_file(path, content)                -> { ok, denied_reason? }
todo_write(todos)                        -> ok
run_tsc()                                -> list of tsc errors
done()                                   -> ok | { incomplete_reason }
```

Five tools. Each earns its place:

- `read_file` — peek at peer files, the in-progress `contracts.ts`, the
  platform template surface, component rules docs. Offset/limit lets the
  agent fetch only the slice it needs (e.g. lines 200–250 of a long file).
- `write_file` — emit scaffold files. Allowlist applies (3.3).
- `todo_write` — the agent plans for itself, same pattern as Claude Code's
  own todo tool. Forces explicit planning before implementation.
- `run_tsc` — self-verify before declaring done. The agent's own quality
  gate, not an external one.
- `done` — declare completion; the runner does final integrity checks
  before accepting.

**Component rules are not a tool.** They live as plain markdown under
`platform-ai/component_rules/{admin,storefront,backend,db,webhooks,cron}.md`
and the agent reads them with `read_file`. Fewer tool types, more uniformity.

### 3.2 Output shape

The agent writes the following into a working directory:

```
scaffold/
├── app.json                    # structured metadata
├── src/
│   ├── types/contracts.ts      # cross-file types
│   ├── routes/{widget,admin}.ts
│   ├── webhooks/{topic}.ts
│   └── lib/business/*.ts       # pure logic
├── admin/ui.ts
└── widget/widget.ts
```

`app.json` carries the structured metadata the runner needs:

```json
{
  "database": { "tables": [...] },
  "shopifyIntegration": { "webhookTopics": [...], "cronSchedule": null },
  "httpRoutes": { "widget": [...], "admin": [...] }
}
```

The runner then deterministically materializes from `app.json`:

- `migrations/0001_app.sql` — from `database.tables[]`
- `src/server.ts` — Express route registration from `httpRoutes`
- Webhook subscription config — from `shopifyIntegration.webhookTopics`

These three are mechanical. The agent does not write them.

### 3.3 Write allowlist

```
✅ scaffold/app.json
✅ src/types/contracts.ts
✅ src/routes/*.ts, src/webhooks/*.ts, src/lib/**/*.ts
✅ admin/*.ts, widget/*.ts
❌ migrations/*.sql                 (rendered from app.json)
❌ src/server.ts                    (rendered from app.json)
❌ platform-back/templates/**       (the template itself)
```

The allowlist exists to keep deterministic outputs deterministic. Migration
SQL and server wiring are mechanical; letting the agent edit them
reintroduces drift.

### 3.4 Component rules — JIT loading

The base agent prompt is component-agnostic. Conventions for each target are
loaded on demand by reading a markdown file:

```
platform-ai/component_rules/
├── admin.md         # Polaris, App Bridge, React patterns, auth context
├── storefront.md    # No Node APIs; theme app extension; vanilla JS
├── backend.md       # Express handler shape; sql tagged template
├── db.md            # SQL idioms for migrations (not used directly — see §3.2)
├── webhooks.md      # Payload shapes per topic; dedup contract
└── cron.md          # Cron context; idempotency
```

Each is small (~200–500 tokens) and contains: runtime constraints, available
libs/globals, house style, do/don't list.

Prompt rule: "Before implementing the first file of any component kind,
read the matching `platform-ai/component_rules/{kind}.md`."

This keeps the base prompt small and lets the rules evolve independently of
the agent code.

---

## 4. The loop

1. Agent receives merchant intent + HLD + ops_picks in its prompt.
2. Agent calls `todo_write` to lay out its plan.
3. Agent writes `scaffold/app.json` and `src/types/contracts.ts` first — the
   spine. Then reads relevant `component_rules/*.md`. Then implements files.
4. As the agent implements peer files, it may re-read `contracts.ts` or
   other written files. `contracts.ts` is editable by the same agent — if a
   missing shape surfaces during implementation, the agent extends it.
5. At some point the agent calls `run_tsc()`. On errors, it fixes them via
   more `write_file` calls. Loop until clean.
6. When tsc is clean and todos are done, the agent calls `done()`.
7. The runner does final integrity checks (app.json present, contracts.ts
   present, tsc passes, no allowlist violations) and either accepts or
   returns failures to the agent for one more round.

Retry budget is on the **agent loop**, not per-file. First cut: 50 turns
max, hard-fail if exceeded.

---

## 5. Observability

Every tool call is logged on disk under the run's results dir:

```
test_results/<timestamp>_<slug>/codegen/
  tool_calls/
    001_todo_write/      input.json   output.json
    002_read_file/       input.json   output.txt
    003_write_file/      input.json   output.json
    004_run_tsc/         input.json   output.txt
    ...
  scaffold/                # the files the agent actually wrote
  manifest.jsonl           # one line per call: idx, tool, ts_start, ts_end, ok
```

CLI live output:

```
[001] todo_write           6 todos
[002] read_file            platform-ai/component_rules/backend.md
[003] write_file           scaffold/app.json ✓
[004] write_file           src/types/contracts.ts ✓
[005] run_tsc              0 errors
[006] done                 ✓
```

Cheap to write, expensive-not-to-have when debugging a 40-turn failure.

---

## 6. What gets retired

| Component | Status | Replaced by |
|---|---|---|
| `i_lld_agent` | Deleted | Folded into single codegen agent |
| `k_lld_v_agent` | Deleted | `run_tsc` + agent self-verify |
| `m_pre_codegen_agent` | Deleted | Single agent owns alignment via shared context |
| `o_codegen_agent` (umbrella) | Deleted | Single agent |
| `backend_agent` / `admin_agent` / `storefront_agent` / `db_agent` | Deleted | Single agent + JIT component rules |
| `q_codegen_v_agent` | Deleted | `run_tsc` |
| `s_revision_agent` | Deleted | Agent self-revises via tool loop |
| `LLDPlan` Pydantic schema | Deleted | `app.json` (metadata) + TS files (code) |
| `retry_suffix` machinery | Deleted | tsc errors are the in-loop retry signal |
| Coupled-retry orchestration in codegen | Deleted | Single agent has no inter-agent coupling |

What survives upstream: `a_product_agent`, `c_hld_agent`, `e_hld_v_agent`,
`g_ops_picker_agent`, `u_explenation_agent`. They feed the single codegen
agent unchanged.

---

## 7. Phased plan

### Phase 0 — Branch & layout
- Branch: `track-a-scaffold-first` (created).
- Decide module location for the new agent (likely
  `platform-ai/subagents/codegen_agent/` — replaces `o_codegen_agent`).

### Phase 1 — Tool implementations + observability
- Implement the five tools as Python callables wired to the Anthropic
  tool-use API.
- Implement the per-tool logging layout (§5).
- Implement the deterministic renderers: `app.json` → migration SQL;
  `app.json` → `src/server.ts`; `app.json` → webhook config.

### Phase 2 — Agent prompt + component rules + hand-run
- Write the base agent system prompt.
- Write the six `component_rules/*.md` docs.
- Hand-run the agent against the bundle merchant intent. Inspect the
  resulting scaffold. No pipeline wiring yet.
- Iterate prompt + rules until the agent reliably produces a tsc-clean
  scaffold.

### Phase 3 — Pipeline integration
- Replace `o_codegen_agent` in the orchestrator with the new single agent.
- Delete: `i_lld_agent`, `k_lld_v_agent`, `m_pre_codegen_agent`,
  `q_codegen_v_agent`, `s_revision_agent`, the four `o_codegen` sub-agents,
  the coupled-retry logic, `retry_suffix`, and the `LLDPlan` schema.
- Keep upstream agents intact.

### Phase 4 — Real end-to-end run
- Run the full pipeline on the bundle intent. Compare to the analyzed run on
  token cost, retry count, and the three end-to-end bugs.

### Phase 5 — Catalog expansion
- Run on 3–5 other archetypes (abandoned cart, post-purchase upsell,
  loyalty, subscriptions). Tune component rules + agent prompt as gaps
  surface.

### Phase 6 — Track B as backstop (deferred until needed)
- **This is the original Track B from iteration 1, now demand-driven.** If
  specific Shopify-protocol bugs keep appearing across archetypes despite
  the single-agent design — discount-then-apply, dedup-before-handler,
  variant-resolution from products — add typed platform helpers that make
  the bug inexpressible at the type level.
- Examples (only build if needed):
  - `shopify.discounts.ensureBundleTierDiscount(...)` — absorbs the
    discount-create-then-cart-apply sequence.
  - `shopify.products.resolveVariantsForProducts(...)` — absorbs the
    product-picker-to-variants expansion.
  - `shopify.webhooks.defineHandler<Topic>(...)` — narrows payload type per
    topic so phantom fields can't compile.
- The rule: **only after a class of bug recurs**. Don't pre-build a helper
  catalog; pre-built helpers are infrastructure debt the single agent may
  never need.

---

## 8. Success criteria

A regenerated bundle app — same merchant prompt as the analyzed run —
passes all of:

1. **`tsc --noEmit` passes** on the assembled scaffold by the time the agent
   calls `done()`.
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
   ≤ 60% of the analyzed-run baseline. (Single agent does more work per
   turn, but no validator retries and no prior-output echoes.)
6. **Tool-call log is readable.** A developer can scroll `manifest.jsonl`
   and understand what the agent did, in order, in under 2 minutes.

---

## 9. Risks and open questions

### Risks

- **Context bloat in long loops.** As the agent reads/writes more files,
  context grows. Mitigation: selective `read_file` with offset/limit; force
  re-reads instead of relying on stale cached content; 50-turn hard cap on
  the first cut.
- **No design audit before code.** Today's LLD forces a planning step.
  Mitigation: prompt requires `todo_write` + `app.json` + `contracts.ts`
  *first*, before any per-file implementation.
- **Loss of retry isolation.** If the agent dies on turn 40, it cannot
  cleanly resume. Acceptable for now — fail-and-restart on full input.
- **Debugging a long trace.** Mitigation: the structured tool-call logs
  (§5). Each tool call is an isolatable artifact on disk.
- **Cost per turn × many turns.** Each turn the agent has prior tool
  outputs in context. Measure early; if it bloats, prefer fewer, broader
  writes over many small ones.
- **Agent might keep refining indefinitely.** Mitigation: agent must call
  `done()` to terminate; turn limit caps runaway behavior.
- **Without Track B helpers, the agent still has to get Shopify protocols
  right by itself.** Mitigation: component rules + `contracts.ts` carry the
  protocol knowledge. If this proves insufficient, Phase 6 (Track B
  backstop) closes the gap on a per-pattern basis.

### Open questions

- Cache strategy: the platform surface (~25k tokens) goes in the system
  prompt with the 1h cache. `contracts.ts` once written: best cached on the
  agent's working dir and re-read on demand, not cached in prompt.
- Integration tests against a sandbox dev store — out of scope for the
  proof; revisit post-Phase 4.
- `done()` semantics: should the runner do anything beyond "tsc passes and
  app.json present"? Likely a small set of graph gates (every
  `webhookTopics` entry has a matching handler file; every `httpRoutes`
  entry has a matching exported handler). Cheap, deterministic, no LLM.

---

## 10. Appendix — bug-to-mechanism mapping

How the three end-to-end-broken paths from the prior generation are
eliminated under the new design:

| Prior bug | Mechanism that absorbs it |
|---|---|
| Admin UI sends `variant_external_ids: []` to `/bundles/items/save` | One agent writes the admin UI **and** the backend route in the same session, against the same `contracts.ts`. The two halves cannot disagree because there is no second brain to disagree with. |
| `products/update` handler reads phantom `payload.__shopDomain` | `component_rules/webhooks.md` documents the actual payload shape; `contracts.ts` types the webhook payload precisely; `tsc` rejects the phantom field. |
| Cart-add passes fabricated `BUNDLE-XXXX-1000` discount code | Agent writes both `discountCreate` and `cartCreate` paths in the same session. `contracts.ts` types the cart input as taking a `DiscountNodeId` returned from `discountCreate`. The fabrication required two agents to invent half-a-contract each; one agent cannot. |

If the agent still drifts on these classes of bug despite the above — a
real risk — the Phase-6 Track B escape hatch is a typed platform helper
that makes the specific case inexpressible at the type level. Not
pre-built; only when a recurring class is observed.
