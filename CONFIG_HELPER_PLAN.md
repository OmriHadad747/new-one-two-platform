# Platform-Wide Settings / Config Helper — Implementation Plan

## Goal

Replace the per-app "singleton config table" pattern with one shared
`app_config` table per tenant + a typed `config.get()` / `config.set()`
helper. Apps stop declaring per-feature config tables; the LLD stops
emitting `singleton: true` schemas; the admin "settings" route
collapses to two steps.

## Why now

Today every config knob (rate, threshold, toggle, TTL) requires the
LLD to declare a singleton table:

```python
{
  "name": "loyalty_settings",
  "singleton": True,
  "columns": [
    {"name": "points_per_dollar", "sqlType": "INTEGER", ...}
  ],
  ...
}
```

The migration generator emits the `singleton BOOLEAN PK` trick. The
handler writes `INSERT … ON CONFLICT (singleton) DO UPDATE`. The
admin "Save settings" route is ~5 LLD steps. Every app reinvents this.

Per-feature tables also fragment config across the schema — there's
no single place to inspect "what knobs does this app have?"

## Specification

### Storage — one shared table per tenant

```sql
CREATE TABLE app_config (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- One row per setting key.
- `value` is JSONB so any JSON-serialisable type (number, string,
  boolean, array, object) fits without schema changes.
- Per-tenant via search_path (same as every other table).
- Template-owned; auto-created on first deploy via a
  `0003_app_config.sql` migration.

### Helper API

```ts
import { config } from "../lib/config.js";

// Read with default fallback (default applied if key missing OR null)
const rate: number = await config.get("points_per_dollar", 1);
const enabled: boolean = await config.get("notifications_enabled", false);
const thresholds: number[] = await config.get("alert_thresholds", []);

// Write (admin route)
await config.set("points_per_dollar", req.body.rate);

// Read all (for an admin "settings page" that lists every knob)
const all = await config.getAll();
// → { points_per_dollar: 1.5, notifications_enabled: true, ... }

// Read multiple (for "edit settings" pre-fill)
const subset = await config.getMany(["points_per_dollar", "alert_thresholds"]);
// → { points_per_dollar: 1.5, alert_thresholds: [10, 50, 100] }

// Delete (rare — usually overwrite with default)
await config.unset("deprecated_knob");
```

### Type safety

Config values are `unknown` from the DB. Two patterns:

**(a) Caller-supplied generic** (simple, works today):
```ts
const rate = await config.get<number>("points_per_dollar", 1);
```
Type is asserted at the call site — runtime check only via
default-fallback type if the value is missing. Trust caller for now.

**(b) Schema-declared shape** (Phase 2):
```ts
// In src/config-schema.ts (LLD-generated)
export const APP_CONFIG_SCHEMA = {
  points_per_dollar: z.number().min(0),
  notifications_enabled: z.boolean(),
} as const;
```
The helper validates on get/set against the schema, throwing on
shape mismatch. Catches the case where merchant manually edits the
DB to a wrong type. Defer until Phase 2 — pattern (a) covers v1.

### Behavior

- **Missing key + default supplied:** returns the default. Does NOT
  write the default back to the table (lazy initialisation; keeps
  `getAll()` honest about "what was actually configured").
- **Missing key + no default:** returns `undefined`. TypeScript
  signature reflects this.
- **`set` is upsert:** `INSERT … ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value, updated_at = now()`. Atomic.
- **Concurrent writes:** last-writer-wins. Matches typical
  settings semantics (a merchant overrides their own value).
  Apps that need optimistic locking (rare for config) use
  `sql.begin` directly.
- **Validation:** `key` must match `^[a-z][a-z0-9_]{0,62}$` —
  lowercase snake_case, ≤63 chars to fit Postgres identifier limits.
  Helper rejects keys that don't match (catches typos at the
  edge).

### Audit log (optional, Phase 2)

A `config_changes` table records every `set()` call:
`(key, old_value, new_value, changed_at)`. Useful for merchant
dashboards showing "you changed this setting on X date." Cheap to
add later.

### What the helper does NOT do

- **Per-tenant scoping logic** — search_path handles it. Helper
  doesn't take tenant args.
- **Encryption** — config values are NOT for secrets. Secrets live
  in the platform's secret manager (different surface). Helper
  enforces this with a deny-list on key names ending in
  `_token` / `_secret` / `_password` / `_key` (rejects with a
  structured error pointing to the secret-manager doc).
- **Versioning / rollback** — config_changes audit (Phase 2) covers
  read access to history; rollback is a manual `set()` to a prior
  value.

## Implementation phases

### Phase 1 — Helper + table

**Files to author:**
- `platform-back/templates/handler/src/lib/config.ts` —
  `get`, `set`, `getAll`, `getMany`, `unset`, key validation,
  secret-name rejection.
- `platform-back/templates/handler/migrations/0003_app_config.sql`
  — template-owned migration.

**Files to modify:** none. Pure addition.

### Phase 2 — Schema validation + audit log (deferred)

Land Phase 1 first, see how apps use it, then add:
- Zod schema declaration support in `config.get/set`.
- `config_changes` table + automatic write on `set()`.

### Phase 3 — LLD integration

**Files to modify:**
- `platform-ai/subagents/lld_agent/schema.py`:
  - **Drop the `Table.singleton` field entirely.** It existed only
    to support config tables; the new helper covers that case.
  - Remove `_singleton_shape` validator.
  - Add `request_idempotency` and `app_config` to the
    template-owned tables list (LLD must not redeclare them).

- `platform-ai/subagents/lld_agent/prompt.py`:
  - Drop the section explaining `singleton: true` table shapes.
  - Add a config section:

    > "App-wide configuration (rates, thresholds, toggles, TTLs)
    > lives in the platform-owned `app_config` table accessed via
    > the `config` helper from `../lib/config.js`. Do NOT declare
    > config tables in `database.tables` — declare keys directly:
    >
    > In `database`: nothing. The table is template-owned.
    >
    > In recipes: use `config.get(key, default)` inside `compute`
    > steps to read; use `config.set(key, value)` inside admin
    > 'save settings' routes to write.
    >
    > Conventions:
    >  - Keys are lowercase snake_case.
    >  - Group related keys by prefix: `loyalty_*`, `notification_*`.
    >  - Always supply a default to `get()`; never assume the key is set."

- LLD validator: the `singleton` field is removed from the schema,
  so the LLD literally cannot express a singleton config table.

### Phase 4 — Documentation

**Files to author:**
- `docs/CONFIG_HELPER.md` — public contract, key conventions,
  secret-management caveat.

## Sequencing

```
Phase 1 (helper + table + tests) ─────┐
                                      ▼
                            Phase 3 (LLD prompt + schema)
                                      │
                                      ▼
                            Phase 4 (docs)
                                      │
                                      ▼
                            Phase 2 (schema val + audit log,
                                    when needed)
```

Pure addition; no coordinated rollout.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| App author treats config keys as secrets | Helper rejects keys ending in `_token`/`_secret`/`_password`/`_key` and points to secret-manager docs |
| Two apps in different tenants stomping on the same key | Impossible — `app_config` is per-tenant via search_path |
| `getAll()` payload grows unbounded | Document a soft cap of ~500 keys per app; alert if any tenant crosses it. In practice apps have <20 knobs |
| JSONB allows any shape, callers assume a type | Phase 2 schema validation closes this; Phase 1 trusts the caller's generic |
| Atomic read-modify-write needed for some config (e.g. counter) | `set` is upsert, not atomic increment. For counters, either use a real DB column or extend the helper with `config.increment(key, delta)` (Phase 2) |

## Success metrics

- Zero `singleton: true` tables in generated LLD outputs after
  Phase 3.
- Average admin "settings" route shrinks from ~5 LLD steps to 2.
- Number of distinct config tables across all generated apps drops
  from N (one per feature per app) to 1 (`app_config`).

## Estimated scope

| Phase | Effort |
|---|---|
| 1. Helper + table | 0.5 day |
| 2. Schema validation + audit log (deferred) | 0.5 day (when needed) |
| 3. LLD prompt + schema simplification | 0.5 day |
| 4. Docs | 0.5 day |
| **Total (Phases 1+3+4)** | **1.5 working days** |
