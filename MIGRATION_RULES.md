# Migration Prompt Rules — Validation Map

Source: every migration-facing prompt block — `platform-ai/subagents/prompts/core/migration.py:MIGRATION_BASE`, the migration agent's user-prompt scaffolding in `platform-ai/subagents/migration_agent.py` (`_format_db_contracts`, `_format_prior_migration`), and the existing static gate in `platform-ai/llm_validations/migration_artifact.py` (which mirrors `platform-back/packages/deployer/src/sql-validator.ts`).

**Scope note:** the migration agent generates DDL mechanically from the architect's `dbContracts`. The `dbContracts` column rules themselves (`tenant_id` ban, money cols → BIGINT, currency siblings, email-template deny-list, singleton shape, `enum` → CHECK, NULLABLE state col when `unknownSentinel="null"`, etc.) are owned by `ARCH_RULES.md` and enforced upstream by `arch_plan.py:9.a-g + arch_plan.py:10`. They do NOT appear as separate rule-rows here — by the time migration runs, they've already been gated. This file lists only the migration agent's *own* rules and the cross-artifact "is the DDL faithful to the contract?" check.

**Legend** — `validate?` = should this rule be enforced after the migration agent emits its SQL?
- **static** — structural / regex / AST / schema-shape check. HIGH precision (no false positives). Implemented in `llm_validations/migration_artifact.py`. The static layer here mirrors `platform-back`'s `sql-validator.ts` so a migration that passes locally also passes the deployer's pre-run gate.
- **llm** — semantic, prose, or judgment that won't survive a cheap structural check but is worth catching agentically (per `LLM_VALIDATORS_PLAN.md`).
- **no** — judgment/style/informational; high false-positive risk relative to value.
- **no (paranoid)** — structural rule the prompt + agent already carry; model gets it right ~always. If it ever drifts, `bug_finder` (Sonnet + thinking) catches downstream impact, and the deployer's `sql-validator.ts` is the deploy-time safety net.

**`done?`** column — `✅` means the static-tier check is currently implemented in `migration_artifact.py`. Blank for `llm` / `no` / `no (paranoid)` rows.

**One owner per rule** — every row has exactly one owner. No rule is enforced by both static AND llm. Where a rule is also caught by the platform-back `sql-validator.ts` (the deploy-time gate), the local static check is intentional defense-in-depth — it fails fast inside the gen pipeline and saves a wasted deploy round-trip. That's noted on the row, not double-counted.

**Static-validation principle:** only enforce a regex/AST static rule when (a) the failure mode has been seen with non-trivial frequency, (b) the check is cheap & structural with **near-zero false-positive rate**, (c) the blast radius is catastrophic (deploy fails, silent corruption, tenant cross-talk, schema drift), AND (d) `tsc` / `handler_graphql` / the platform-back `sql-validator.ts` / upstream `arch_plan.py` checks don't already cover it. Everything else flows through the LLM validators (`agent_rules` + `bug_finder`).

**What earns a static validator (concept summary for future sessions):** the static layer in this repo is intentionally narrow. A rule earns a regex/AST check ONLY when all four bars are cleared: it's structurally checkable, the model fails it often enough to matter, the failure is catastrophic (not "drift" or "wasted tokens" or "annoying UX"), AND the deterministic runtime gates (the deployer's `sql-validator.ts`, the migration runner's idempotency rewrite, upstream architect checks) don't already surface it. Migration is special: most of its real catastrophic failure modes are caught by the deployer's pre-run gate, but local pre-deploy enforcement saves the round-trip and gives the gen pipeline a fast retry signal — so where the local check has near-zero FP risk and saves a real round-trip, it earns its keep. Bias toward letting the deployer + bug_finder do the work, not adding more local regex.

---

| # | rule | validate? | how | done? |
|---|---|---|---|---|
| **Schema isolation** | | | | |
| 1 | No `tenant_id` column declared inside any `CREATE TABLE` body. Each tenant has its own Postgres schema; `search_path` is pinned at deploy time. A `tenant_id` column is redundant and signals drift from the schema-isolation model. | yes | static | ✅ (`migration_artifact` — defense-in-depth against `arch_plan.py:9.a` upstream) |
| 2 | No schema-qualified table names (`tenant_<uuid>.<table>` style). The migration runner pins `search_path` to the tenant's own schema; bare names land where they should. | yes | llm | |
| **Allowed SQL allowlist (mirrors deployer's `sql-validator.ts`)** | | | | |
| 3 | Only `CREATE TABLE`, `CREATE INDEX` (incl. `UNIQUE`), `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `COMMENT ON` are emitted. Everything else is forbidden — `DROP*` / `TRUNCATE` / `DELETE FROM` / `UPDATE … SET` / `GRANT` / `REVOKE` / `SET ROLE` / `SET SESSION AUTHORIZATION` / `ALTER POLICY` / `ALTER ROLE` / `ALTER USER` / `ALTER DEFAULT PRIVILEGES` / `ALTER SYSTEM` / `ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` / `CREATE FUNCTION` / `CREATE TRIGGER` / `CREATE EXTENSION` / `DO $$` PL/pgSQL / `CONCURRENTLY` / `COPY … FROM PROGRAM` / `cron.schedule` / `cron.unschedule`. The deployer rejects any of these unconditionally; local enforcement here fails-fast inside the gen pipeline. | yes | static | ✅ (`migration_artifact._FORBIDDEN`) |
| 4 | `ALTER TABLE` is permitted ONLY for `ADD COLUMN IF NOT EXISTS`. No `DROP COLUMN`, no `ALTER … TYPE`, no `RENAME`, no constraint adds outside the create. | yes | static | ✅ (`migration_artifact` ALTER-statement scan) |
| **Template-owned tables** | | | | |
| 5 | Don't `CREATE TABLE processed_webhooks` or `CREATE TABLE cron_queue`. Both ship with every handler via the template's bootstrap migration; emitting a CREATE collides with the template even with idempotency wrappers. | yes | static | ✅ (`migration_artifact` — name-set match against `TEMPLATE_OWNED_TABLES`) |
| **Revision-run discipline** | | | | |
| 6 | On a revision run, don't `CREATE TABLE` for a table already deployed by a prior run. Use `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for incremental schema evolution so the diff is explicit and reviewable. | yes | static | ✅ (`migration_artifact` — `prior_tables` cross-check) |
| 7 | On a revision run with no schema change, output zero characters (empty migration is valid). | no (paranoid) | — | |
| **DDL ↔ dbContracts faithfulness** | | | | |
| 8 | Every column declared in `dbContracts` is emitted with EXACT name, type, and constraints — no extras, no renames, no skipped columns, no type drift. The dbContracts are the contract; the handler reads them, the migration must implement them. | yes | llm | |
| **Indexes** | | | | |
| 9 | Indexes emitted when `dbContracts.indexes` declares them. Avoid redundant standalone indexes when a composite index already covers the same prefix. | no | — (style — redundant indexes waste disk + slow writes but are not catastrophic; bug_finder can flag the worst cases when they appear with other findings) | |
| **Output format** | | | | |
| 10 | Output is raw SQL only — no markdown fences, no explanation prose, no leading/trailing chatter. | no (paranoid) | — (`MigrationGenerator.parse()` strips ```sql / ``` fences and falls back to empty string when the agent returns prose; not a separately-validated rule) | |
| 11 | Idempotency markers (`IF NOT EXISTS`) are added by the deployer — don't write them yourself. Tolerated but redundant. | no | — (cosmetic; tolerated by the deployer's idempotency-rewrite step) | |

---

## Static implementation map

The static-yes rule-rows above (✅) are covered by checks in:

- **`llm_validations/migration_artifact.py`** (sole local static gate; mirrors `platform-back/packages/deployer/src/sql-validator.ts` so a migration that passes locally also passes the deployer's pre-run gate):
  - Row 1 — `tenant_id` column inside any `CREATE TABLE` body.
  - Row 3 — `_FORBIDDEN` regex list (DROP / TRUNCATE / DELETE / UPDATE / GRANT / REVOKE / SET ROLE / SET SESSION AUTHORIZATION / ALTER POLICY|ROLE|USER|DEFAULT PRIVILEGES|SYSTEM / ENABLE RLS / CREATE POLICY / CREATE FUNCTION|TRIGGER|EXTENSION / DO $$ / CONCURRENTLY / COPY FROM PROGRAM / cron.schedule|unschedule). Patterns match inside string literals and comments too — the prompt warns the model accordingly.
  - Row 4 — per-statement scan: `ALTER TABLE` without `ADD COLUMN IF NOT EXISTS` is rejected.
  - Row 5 — name-set match of `CREATE TABLE` targets against `TEMPLATE_OWNED_TABLES` (`processed_webhooks`, `cron_queue`).
  - Row 6 — `CREATE TABLE` targets cross-checked against the caller-supplied `prior_tables` list (extracted from `ctx.prior_migration_sql` by `migration_agent._extract_table_names`).

**Rules covered upstream — NOT re-listed in this table:** every dbContracts column rule (`tenant_id` ban, Shopify ID col types, money cols → BIGINT, currency siblings, email-template column deny-list, singleton shape, column-level `enum` → CHECK + DEFAULT membership, NULLABLE state-tracking column when `stateMachine.unknownSentinel == "null"`). All enforced at architect-emit time by `arch_plan.py:9.a-g + arch_plan.py:10`. The migration agent's `_format_db_contracts` then emits the corresponding DDL fragments mechanically (singleton `BOOLEAN PRIMARY KEY`, `CHECK (col IN ('a','b'))` for enums, etc.) — those translations are plumbing, not rules.

**Rules covered downstream — NOT re-listed:** anything `platform-back/packages/deployer/src/sql-validator.ts` catches that the local mirror in `migration_artifact.py` doesn't (today: identical, by design). The deploy-time gate is the safety net; local mirroring is fail-fast.

---

## Counts

- **11 rules** total across the migration prompt + agent surface
- **7 validate** → **5 static** rule-rows (✅ all enforced today in `migration_artifact.py`) + **2 llm** rule-rows deferred to `agent_rules` + `bug_finder`
- **4 skip** → **2 no** (style / cosmetic) + **2 paranoid** (model handles via prompt; deployer catches deploy-blocking versions)
- **0 critical static gaps** — the local static layer is feature-complete for the rules selected under the four-bar policy. Row 8 (DDL ↔ dbContracts faithfulness) is intentionally `llm` because a faithful structural check requires a full DDL parse + contract diff, which would either duplicate `bug_finder`'s cross-artifact reasoning or carry false-positive risk against legitimate constraint variations. bug_finder's existing prompt (under "Cross-artifact mismatches" and "Silent data loss / corruption") already covers this case.
