---
name: evaluate-generation
description: Evaluate a generation run (a w_coding_agent / pipeline run dir) — rank each agent's output individually AND the overall app — and write a structured evaluation.md. Handles partial runs that halted early (e.g. after hld_v). Use when asked to evaluate, grade, score, rank, or assess a generation, an agent's output, or to check for regressions.
---

# Evaluate a generation — per-stage + overall

Grade **each agent's output individually** and the **overall app**, then
write `evaluation.md` into the run dir. The format is fixed and the criteria
are general — never tuned to one app — so runs are comparable over time.

Runs may halt early. A pipeline that stopped after `hld_v` has no app to
score: rank the stages that ran, and report the overall as **incomplete** —
never fabricate an app score for code that was never generated.

## Criteria — single source of truth

Read `GENERATION_QUALITY_PLAN.md` at the repo root before grading:
- **§1** — the 1–5 app rubric (the 4-vs-3 line: no crash, no silent feature
  death, no protocol violation).
- **§3** — the bug classes. **§6** — the general invariants.

Grade against them; don't restate them.

## Inputs (in the run dir)

- `state.json` — `intent`, `plan` (with the Phase-2 bindings:
  `shopifyTopic`, `payloadBindings`, `shopifySteps`), `hld_v_findings`, and
  per-stage `tokens_*`. The backbone for ranking the HLD stages.
- `inputs/<stage>/attempt_N/{system.txt,user.txt,output.*}` — each stage's
  prompts + output (`product`, `hld`, `hld_revise`, `hld_v`, `coding`).
  The `coding` stage also writes `tool_calls/`, `manifest.jsonl`, and
  `turns/` under the same `inputs/coding/attempt_1/` dir.
- `scaffold/app.json` + `scaffold/**` — the built app (only when coding ran).
- `token_usage.json` (at run root), `final_tsc.json`,
  `forced_completion.json` — optional run-level aggregates.

Detect which stages ran from these; rank only those present.

## Per-stage ranking (1–5 each)

- **product** — does the intent capture the merchant's real needs
  (archetype, resources, a complete qualityBrief) without inventing scope
  or dropping a stated requirement?
- **hld** — judge the FINAL plan (post-revise if a revision ran).
  *Domain*: spine intact, no orphan state/config. *Phase-2 bindings*: each
  `shopifyTopic` actually fires for its event; each `payloadBinding` maps to
  a real payload field or a declared resolution hop; each shopify-*
  capability's `shopifySteps` fit the action and multi-step protocols are
  resolved as a full sequence — flag any capability whose description
  implies a Shopify effect but carries `integration:null`/no steps (a
  plan-level "effect not realized").
- **hld_v** — recall + precision: did it catch the issues a careful
  reviewer would (judge against the plan you can see), with precise
  locations and actionable fixes, and WITHOUT hallucinated or over-reaching
  findings (quote-or-drop)?
- **hld_revise** (if present) — did it apply EACH `hld_v` finding's fix and
  carry unflagged sections unchanged? Name any finding left unaddressed.
- **coding** (only if a scaffold exists) — the §3/§6 bug-class review per
  surface (see the app method below).

## App method (only when a scaffold exists)

1. From the plan, list what the app must do (capabilities, triggers, surfaces).
2. For each capability, decide **realized / faked / broken / missing**. A
   capability that returns success or writes a record without performing its
   real effect (e.g. a discount "applied" via a cart property, no discount
   op called) is **faked**.
3. Walk the §6 invariants over the code; every finding cites `file:line`.
4. Classify findings: **crash / silent-feature-death / protocol-violation /
   cosmetic**. Score per §1 (any crash, unreachable feature, faked effect,
   fabricated/placeholder reference, or wrong/missing topic caps at ≤3).

## Overall

- **Scaffold present** → the app rank per §1, and name the weakest stage
  that capped it.
- **Halted early** → `incomplete — halted at <stage>`. Do NOT invent an app
  score. State which stage is the weakest link in what *did* run.

## Rules

- **General only.** Judge "does each output honor the prior stage / the
  invariants," never invent app-specific requirements.
- **Evidence or it didn't happen.** Cite `file:line` (code) or a plan path
  / quoted field (HLD). If you can't quote it, drop it.
- **Artifacts only.** No deploy/run. Be concise — one line per finding.

## Output template (write verbatim, fill in)

```markdown
# Evaluation — <slug>

- Run: <run dir>
- Date: <YYYY-MM-DD>
- Pipeline reached: <last stage that ran> (<complete | halted early>)

## Stage ranks

| stage       | rank/5 | one-line rationale |
|-------------|--------|--------------------|
| product     | <n>    | ... |
| hld         | <n>    | ... |
| hld_v       | <n>    | ... |
| hld_revise  | <n/—>  | ... |
| coding      | <n/—>  | ... |

## Overall: <N/5  OR  incomplete — halted at <stage>>

<weakest link + the single thing capping quality>

## App findings  (omit this section entirely if no scaffold)

| # | severity | class (§3) | file:line | finding |
|---|----------|-----------|-----------|---------|

## Capability realization  (omit if no scaffold)

| capability (HLD) | status | evidence |
|------------------|--------|----------|

## Revise effectiveness  (only if hld_v findings + a revised plan both exist)

| hld_v finding (location) | severity | addressed? | evidence in final plan |
|--------------------------|----------|-----------|------------------------|

## Token cost

<per-stage from state.json tokens_* and/or token_usage.json; else "not recorded">
- product / hld / hld_v / hld_revise: <in> in / <out> out (+<cache_read> cache)
- coding / validators (if present): <in> in / <out> out

## Notes

<short free text: anything the tables didn't capture>
```
