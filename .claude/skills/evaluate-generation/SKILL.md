---
name: evaluate-generation
description: Evaluate a generated Shopify app (a w_coding_agent run dir) and produce a structured evaluation.md scoring it 1-5 against the quality rubric. Use when asked to evaluate, grade, score, or assess the quality of a generated app, or to check a generation for regressions.
---

# Evaluate a generated app

Grade one generated app and write `evaluation.md` into its run dir. The
report is the signal we use to track quality improvement/regression across
runs, so the format is fixed and the criteria are general — never tuned to
one app.

## Criteria — single source of truth

Read `GENERATION_QUALITY_PLAN.md` at the repo root before grading:
- **§1** — the 1–5 rubric (the 4-vs-3 line: no crash, no silent feature
  death, no protocol violation).
- **§3** — the bug classes.
- **§6** — the general invariants (provenance both directions,
  Shopify-effect realization, write-path integrity, persistence-safety).

Do not restate them here; grade against them.

## Inputs (in the run dir)

- `inputs/user.txt` — merchant request + product intent + the HLD plan.
  The HLD is the spec: what the app *should* do.
- `scaffold/app.json` — tables, `webhookTopics`, `httpRoutes`.
- `scaffold/src/**`, `scaffold/admin/ui.ts`, `scaffold/widget/widget.ts`,
  `scaffold/src/types/contracts.ts` — what was built.
- `manifest.jsonl` / `tool_calls/` — optional; use to confirm process
  (e.g. the agent fetched a topic's payload before subscribing).
- `token_usage.json` — optional; the coding agent's loop tokens + the
  done()-gate validators' tokens. Report them in the Token cost section so
  runs are comparable on cost as well as quality.

## Method

1. Read the HLD plan → list what the app must do (capabilities, triggers,
   surfaces).
2. Read the code. For each HLD capability, find its implementation and
   decide: **realized / faked / broken / missing**. A capability that
   returns success or writes a record without performing its real effect
   (e.g. a discount "applied" via a cart property, no discount op called)
   is **faked**, not realized.
3. Walk the §6 invariants over the code. Every finding needs `file:line`
   evidence.
4. Classify each finding by severity: **crash / silent-feature-death /
   protocol-violation / cosmetic**.
5. Score 1–5 per §1. Any crash, unreachable feature, faked Shopify effect,
   fabricated/placeholder reference, or wrong/missing topic caps at ≤3.
6. Write `evaluation.md` using the template below.

## Rules

- **General only.** Judge "does the code honor the plan," never invent
  app-specific requirements. The app's domain lives in the data you read,
  not in new rules.
- **Evidence or it didn't happen.** Every finding cites `file:line`.
- **Artifacts only.** No deploy/run; reason from the code.
- Be concise. Findings are one line each.

## Output template (write verbatim, fill in)

```markdown
# Evaluation — <app slug>

- Run: <run dir>
- Coding model: <from manifest/loop if known, else "unknown">
- Date: <YYYY-MM-DD>

## Score: <N>/5

<one line: the single thing that capped it>

## Severity counts

- crash: <n>
- silent-feature-death: <n>
- protocol-violation: <n>
- cosmetic: <n>

## Findings

| # | severity | class (§3) | file:line | finding |
|---|----------|-----------|-----------|---------|
| 1 | ... | ... | ... | ... |

## Capability realization

| capability (HLD) | status | evidence |
|------------------|--------|----------|
| <id> | realized/faked/broken/missing | file:line |

## Surface checklist

| surface | verdict | note |
|---------|---------|------|
| backend | pass/fail | ... |
| webhooks | pass/fail | ... |
| admin | pass/fail | ... |
| widget | pass/fail | ... |
| db | pass/fail | ... |

## Token cost

<from token_usage.json if present, else "not recorded">
- coding agent: <input> in / <output> out (<turns> turns)
- validators: <input> in / <output> out
- cache reads: <coding cache_read + validator cache_read>

## Notes

<short free text: anything the table didn't capture>
```
