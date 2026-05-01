# Revision Prompt Rules — Validation Map

Source: `platform-ai/subagents/prompts/core/revision.py:REVISION_SYSTEM`, the user-prompt builder in `platform-ai/subagents/revision_agent.py:_build_user_prompt` (locking block, static-error feedback block, semantic-issues block), and the post-parse handling in `platform-ai/subagents/revision_agent.py:run_revision_agent` (per-artifact extraction gated on `locked_artifacts`).

**Scope note — the revision agent is unique in the pipeline.**

- **It runs against ALL surfaces.** One LLM call produces handler + migration + widget_js + admin_ui together, holistically. There's no per-surface revision agent; surface-specific rules belong to the surface (`HANDLER_RULES.md` etc.) and apply equally to revision output as to first-run output.
- **Its output flows through every per-surface static gate.** Both invocation paths (`crew._phase_codegen` first-attempt holistic and `crew._phase_validator` post-LLM-validator) call `validate_artifacts()` on the revised bundle. That runs `handler_artifact` + `handler_typecheck` + `handler_graphql` + `shopify_ops` + `migration_artifact` (with `prior_tables` cross-check) + `widget_artifact` + `admin_ui_artifact` + `cross_widget_handler` + `cross_admin_handler`. The post-validator path retries ONCE on static failure with `static_errors` fed back to the prompt, then fails the job with `REVISION_STATIC_VALIDATION_FAILED`.
- **Most rules taught here are restatements of surface rules** (incremental DDL is migration territory; field-shape consistency is cross-handler territory; export names are tsc territory). The only rules unique to revision are: incremental-DDL discipline (already enforced via `migration_artifact.py`'s `prior_tables` parameter and `_FORBIDDEN` list), single-file output for widget/admin (newly enforced — see audit findings), and locking discipline (enforced post-parse in `revision_agent.py`).

**Legend** — `validate?` = should this rule be enforced after the revision agent emits its output?
- **static** — structural / regex / AST / set-membership / cross-field check. HIGH precision (no false positives).
- **llm** — semantic, prose, or judgment that won't survive a cheap structural check but is worth catching agentically (per `LLM_VALIDATORS_PLAN.md`).
- **no** — judgment/style/informational; high false-positive risk relative to value.
- **no (paranoid)** — structural rule the prompt + parse step + downstream gates already carry; model gets it right ~always. If it ever drifts, `bug_finder` catches downstream impact.

**`done?`** column — `✅` means the static-tier check is currently implemented (cross-referenced to the per-surface validator that owns it). `⏳ TODO` means a static check that earns its keep but doesn't exist yet. Blank for `llm` / `no` / `no (paranoid)` rows.

**One owner per rule** — every row has exactly one owner. No rule is enforced by both static AND llm. Where a revision rule restates a surface rule, the owner is the surface validator; this file points at it rather than re-implementing.

**Static-validation principle:** only enforce a regex/AST static rule when (a) the failure mode has been seen with non-trivial frequency, (b) the check is cheap & structural with **near-zero false-positive rate**, (c) the blast radius is catastrophic (deploy fails, silent corruption, contract regression on prior code), AND (d) `tsc` / `handler_graphql` / per-surface validators / the post-parse extraction in `revision_agent.py` don't already surface it. Everything else flows through the LLM validators (`agent_rules` + `bug_finder`).

**Catastrophic-by-regression** is the dominant failure class for the revision agent. The agent is editing already-deployed code; a wrong edit can break a contract that was working in production. That's a separate flavor of catastrophic from first-run codegen — the worst outcomes here are SILENT regressions on prior behaviour, not failed first-deploys.

---

| # | rule | validate? | how | done? |
|---|---|---|---|---|
| **Approach (judgment)** | | | | |
| 1 | Read existing files first; understand contracts each route/job maintains | no | — (judgment; not structurally checkable; the prompt teaches it as the approach) | |
| 2 | Compare prior code against the new appContracts before editing | no | — (same — judgment; the LLM's reasoning, not a checkable artifact rule) | |
| 3 | Apply only the changes required — preserve everything else | llm | (semantic; requires diffing prior bundle vs revised bundle to flag rewrites of code that didn't need touching. Real failure mode — revision agents notoriously rewrite working code. Bar (b) fails for static: a structural diff would FP every time the revision IS supposed to touch a file. agent_rules with `ctx.prior_*` could carry the case but would significantly grow the prompt; deferred until a documented incident — see Architectural Q2 below) | |
| 4 | Propagate field-name changes consistently across files | no (paranoid) | — (`cross_widget_handler.py` + `cross_admin_handler.py` catch widget/admin↔handler field drift; `handler_typecheck` catches type-level inconsistency; `handler_graphql` catches GraphQL-side renames. Three deterministic gates already cover the canonical failure modes — adding a fourth would duplicate with a less actionable error message) | |
| **Re-emission — file bundle (handler)** | | | | |
| 5 | Modified handler files re-emitted via `===FILE: <path>=== / ===END===` markers; bundle parses cleanly | no (paranoid) | — (`handler_artifact.py` checks #1–#3 enforce bundle-marker shape on EVERY handler artifact, including revision output — the revision path uses the same `validate_artifacts` entry point as first-run codegen) | |
| 6 | Re-emit unchanged files too if you touched even one byte (complete picture) | no | — (semantic intent; the parse layer accepts incremental bundles fine, and the revision agent's holistic prompt makes complete bundles the natural output. Enforcing "must contain every prior file even if untouched" would FP whenever the revision genuinely consolidates files. Trust the prompt; downstream tsc catches missing required exports) | |
| 7 | Fixed export names (`webhookHandlers` / `adminRouter` / `widgetRouter` / `jobs`) — never rename | no (paranoid) | — (made impossible by the template structure: the template `import`s these names directly, so a rename is a tsc compile error. Same logic as `HANDLER_RULES.md` row 9 — not a separately-maintained check) | |
| **Migration — incremental DDL only (revision-specific)** | | | | |
| 8 | Output ONLY incremental DDL — prior migration already ran | yes | static | ✅ (`migration_artifact.py` row 6 — `prior_tables` cross-check rejects `CREATE TABLE` for already-deployed tables; revision_agent passes `ctx.prior_migration_sql` → `crew.validate_artifacts` → `MigrationGenerator.validate(prior_tables=...)`) |
| 9 | NEVER drop, recreate, or modify existing tables/columns | yes | static | ✅ (`migration_artifact._FORBIDDEN` covers `DROP TABLE` / `DROP COLUMN` / `TRUNCATE` / `DELETE FROM` / `UPDATE … SET`; `prior_tables` cross-check rejects `CREATE TABLE` recreation; ALTER-shape scan rejects everything but `ADD COLUMN IF NOT EXISTS`) |
| 10 | New table → plain `CREATE TABLE` (no `tenant_id`, no RLS, no `CREATE POLICY`) | yes | static | ✅ (`migration_artifact.py` row 1 catches `tenant_id` columns; `_FORBIDDEN` rejects `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY`. Identical enforcement to first-run migration) |
| 11 | New column → `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` | yes | static | ✅ (`migration_artifact.py` row 4 — every `ALTER TABLE` must contain `ADD COLUMN IF NOT EXISTS` or it's rejected) |
| 12 | If nothing changed → output exactly `-- no schema changes` | no | — (the literal sentinel string is convention; what matters is the absence of forbidden DDL, which IS enforced by `migration_artifact._FORBIDDEN` and the `prior_tables` check. An empty migration / a comment-only migration / the literal sentinel all behave identically downstream — the deployer's idempotent runner is a no-op on all three) | |
| 13 | `SELECT cron.schedule(...)` is deployer-owned — do not emit it | yes | static | ✅ (`migration_artifact._FORBIDDEN` regex `\bcron\.(schedule|unschedule)\b`) |
| **Widget / Admin UI emission (revision-specific)** | | | | |
| 14 | Revise widget/admin only when prior bundle includes the module AND the revision touches the surface | no | — (judgment about WHEN to emit; downstream is forgiving — `crew._phase_validator` merges revised frontend artifacts onto the existing bundle, so omitting an unchanged widget preserves the prior version. The opposite mistake — emitting a widget for a backend-only app — is caught by archetype gates in `crew._phase_codegen`) | |
| 15 | Output raw JavaScript — NO `===FILE:===` markers (widget_js + admin_ui are single-file artifacts) | yes | static | ✅ (added this round to `widget_artifact.py` + `admin_ui_artifact.py` — see audit findings below) |
| 16 | Set field to `null` when not applicable (backend-only / no change needed) | no (paranoid) | — (`revision_agent.py:run_revision_agent` post-parse handling: `if isinstance(<field>, str) and <field>.strip(): artifacts[name] = …` already gates on truthiness; null / missing / empty-string all collapse to "skip this surface" without further validation) | |
| **JSON output shape** | | | | |
| 17 | Single JSON object with `handler` / `migration` / `widget_js` / `admin_ui` keys | no (paranoid) | — (the JSON schema example IS in the system prompt; with schema-as-prompt the model essentially never omits keys. `revision_agent.py:_build_user_prompt` shows the exact output shape. Same frontier-model-tax logic as `ARCH_RULES.md` row 1) | |
| 18 | No markdown fences, no explanation prose around the JSON | no (paranoid) | — (`extract_json` strips fences; `json.loads` failure is caught and falls through to `run_codegen_parallel` with the bad output discarded — no separate validator needed) | |
| **Locking discipline (revision-specific)** | | | | |
| 19 | Don't output revisions for artifacts in `locked_artifacts` | no (paranoid) | — (`revision_agent.py:run_revision_agent` parser silently drops locked-artifact keys: `if "handler" not in locked_artifacts: …`. The agent CAN'T leak a locked artifact into the result even if the LLM emits one, so a static check would have nothing to catch. The locking-block prose in the user prompt is the prevention side; the parser is the enforcement side) | |
| **Static-retry feedback** | | | | |
| 20 | On static-retry, fix only the failing artifacts; don't change passing ones | no | — (judgment; "didn't change a passing artifact" requires diffing two revisions and the legitimate-touch FP class is high. The prompt's `STATIC VALIDATION FAILURES` block already pinpoints which artifacts to fix — trust the prompt. Real regressions surface on the next `validate_artifacts` call and trigger the `REVISION_STATIC_VALIDATION_FAILED` path) | |

---

## Audit findings this round

- **Row 15 promoted from prompt-only to static.** The revision prompt explicitly says "no `===FILE:===` markers; widget_js and admin_ui are single-file artifacts." Nothing enforced it. If the revision agent leaks a `===FILE: widget.js===` prefix into the widget_js or admin_ui slot, the artifact passes the existing static layer (export-mount regex matches further down), ships into the App Block / Shopify Admin iframe, and the runtime fails to evaluate the module — `===` at file head is an ES-module syntax error. Silent storefront/admin breakage at deploy time with no actionable error.
  - **Why it clears all four bars:** structurally checkable (anchored regex against `^\s*===FILE:\s+`); near-zero FP (no legitimate ES module starts a line with `===FILE:` followed by a path); catastrophic (silent runtime failure on shopper / merchant-facing surface); not duplicated downstream (the App Block runtime catches it but only after deploy, which means the static gate IS the only fast-feedback path).
  - Added to both `widget_artifact.py` and `admin_ui_artifact.py` against RAW source — the marker is a literal token, not something the comment/string scrubber should erase.

- **Row 4 and rows 8–13 are not new this round** — they were already enforced by `migration_artifact.py` (with `prior_tables` flowing in via the existing `MigrationGenerator.validate()` signature) and the cross-handler validators. This audit's contribution is documenting WHICH layer owns each rule — the revision agent's prompt was teaching them as if they were revision-specific, but they're really surface rules that apply equally to first-run output.

- **No new validator file, no new agent_rules section.** Revision adds zero new prompt surface for `agent_rules` — every `llm` candidate either restates a rule already covered by the architect/handler/widget/admin sections (row 4) or is the deferred row 3 case below. Sticks to the three-validator architecture: new generator surfaces extend prompts, not validator counts. Revision adds zero prompt extension this round.

---

## Counts

- **20 rules** total across the revision agent's prompt + parser surface
- **6 validate** → **6 static** rule-rows (✅ all enforced — 5 owned by `migration_artifact.py` per the surface-rule mapping in rows 8–11 + 13, 1 newly added to `widget_artifact.py` + `admin_ui_artifact.py` for row 15) + **0 llm** rule-rows in `agent_rules` today (row 3 is the only deferred candidate; see Q2 below)
- **14 skip** → **5 no** (judgment / style / non-catastrophic) + **9 paranoid** (model handles via prompt; downstream gates catch deploy-blocking versions)
- **0 critical static gaps** under the four-bar policy after this round.

---

## Architectural questions deferred (NOT static-gate decisions)

These are the deeper "should revision get more validation?" questions surfaced during the audit. They don't fit the static-validation philosophy and would be separate decisions if pursued.

### Q1 — Should LLM validators re-run on revised output?

Today, `crew._phase_validator` runs `agent_rules` + `bug_finder` ONCE on the codegen output, then revises. The revised output goes through STATIC validation but not the LLM validators again. **Real gap class:** if revision tries to fix one semantic issue and introduces a different one (e.g. fixing a money-cents bug but breaking idempotency), the new bug ships.

**Cost:** ~3 more LLM calls per revision-bearing generation (Haiku + Haiku + Sonnet+thinking). Significant on a Sonnet+thinking budget.

**Mitigations short of a full re-run:** run only `bug_finder` post-revision (cheaper, broader scope, catches new regressions); cap at one extra round (no infinite loop); gate behind a config flag (`LLM_VALIDATION_POST_REVISION`).

**Status: deferred.** No documented incident yet. Re-evaluate when one shows up.

### Q2 — Should rule #3 ("preserved unrelated code") get an `agent_rules` section?

The deeper failure mode: revision agent rewrites a route it wasn't supposed to touch and silently breaks a working contract. Today nothing catches this — `tsc` passes (the rewrite is type-clean), `cross_*_handler` passes (field shapes still align), the prompt-rule validators don't see the prior bundle.

**To enforce it:** `agent_rules` would need access to `ctx.prior_handler_code` / `prior_widget_code` / `prior_admin_ui_code` and a new "REVISION DRIFT — what to look for" section comparing prior to new. Real value, but: significantly grows the agent_rules prompt (it'd need both bundles in context = ~2x token cost on revision runs); only fires on revision runs (prompt-section gating adds complexity); hard to write a high-precision rule (legitimate revisions DO change things).

**Status: deferred.** Re-evaluate when there's a documented case of "revision broke unrelated code that everyone agreed wasn't supposed to be touched."

---

## Static implementation map

The static-yes rule-rows above (✅) are covered by checks in:

- **`llm_validations/migration_artifact.py`** (already in place — revision routes through the same `MigrationGenerator.validate()` entry as first-run):
  - Row 8 — `prior_tables` cross-check against `_extract_table_names(ctx.prior_migration_sql)`.
  - Row 9 — `_FORBIDDEN` regex list (DROP / TRUNCATE / DELETE / UPDATE) + ALTER-shape scan + `prior_tables` recreation check.
  - Row 10 — `tenant_id` column scan + `ENABLE RLS` / `CREATE POLICY` in `_FORBIDDEN`.
  - Row 11 — `ALTER TABLE` shape scan rejecting everything but `ADD COLUMN IF NOT EXISTS`.
  - Row 13 — `\bcron\.(schedule|unschedule)\b` in `_FORBIDDEN`.

- **`llm_validations/widget_artifact.py`** + **`llm_validations/admin_ui_artifact.py`** (added this round):
  - Row 15 — `^\s*===FILE:\s+` line-anchored regex against raw source on both single-file artifacts.

**Rules covered upstream by the revision_agent.py parser — NOT separately validated:**
- Row 16 (null when not applicable) — `if isinstance(<field>, str) and <field>.strip()` truthiness gate.
- Row 18 (no markdown fences) — `extract_json` strips them; `json.loads` failure falls through.
- Row 19 (locking discipline) — `if "handler" not in locked_artifacts` per-key gate at parse time.

**Rules covered by tsc / template structure — NOT separately validated:**
- Row 7 (fixed export names) — template imports the names directly; missing export = tsc compile error.

---

## Resuming this work in another session

Pick up by checking whether either Q1 or Q2 above has shifted from "deferred" to "documented incident." If yes, that's the natural next round. Otherwise the revision surface is feature-complete under the four-bar policy.

Tests: 76 platform-ai tests pass after the row-15 addition (`cd platform-ai && .venv/bin/python -m pytest -q --ignore=tests/test_graphql_validation.py`).
