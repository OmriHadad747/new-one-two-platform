/**
 * App-wide settings / config helper.
 *
 * Backed by the template-owned `app_config` table (one row per setting
 * key, JSONB value). Replaces the per-app singleton-table pattern: a
 * recipe that needs a knob (rate, threshold, toggle, TTL) reads it via
 * `config.get(key, default)` and writes it via `config.set(key, value)`,
 * with no per-app DDL.
 *
 * Tenancy is search_path-scoped (same as every other table), so the
 * helper takes no tenant arg.
 */

import { sql } from "./db.js";

const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;

const SOFT_KEY_CAP = 500;
let _warnedKeyCap = false;

export class ConfigKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigKeyError";
  }
}

function validateKey(key: string): void {
  if (typeof key !== "string" || !KEY_RE.test(key)) {
    throw new ConfigKeyError(
      `invalid config key ${JSON.stringify(key)}: must match /^[a-z][a-z0-9_]{0,62}$/`,
    );
  }
}

/**
 * Read a single config value.
 *
 * Returns the stored value when present. Returns `defaultValue` when the
 * key is missing OR the stored JSONB value is SQL NULL. The default is
 * NOT written back to the table — keeps `getAll()` honest about "what
 * was actually configured".
 *
 * Type is asserted at the call site via the generic; the helper does no
 * runtime shape check (Phase 2 brings schema-declared validation).
 */
export async function get<T>(key: string, defaultValue: T): Promise<T>;
export async function get<T>(key: string): Promise<T | undefined>;
export async function get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
  validateKey(key);
  const rows = await sql<{ value: T | null }[]>`
    SELECT value FROM app_config WHERE key = ${key}
  `;
  const row = rows[0];
  if (row === undefined || row.value === null) {
    return defaultValue;
  }
  return row.value;
}

/**
 * Read multiple config values in one round-trip.
 *
 * Keys not present in the table are simply absent from the returned
 * map (no default fallback). Use this to pre-fill an admin "edit
 * settings" form where each field has its own default.
 */
export async function getMany<T = unknown>(keys: readonly string[]): Promise<Record<string, T>> {
  if (keys.length === 0) return {};
  for (const k of keys) validateKey(k);
  const rows = await sql<{ key: string; value: T }[]>`
    SELECT key, value FROM app_config WHERE key = ANY(${keys as unknown as string[]})
  `;
  const out: Record<string, T> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/**
 * Read every config row. Returns `{ key: value }` map.
 *
 * Backs the admin "settings page" listing every knob. Logs a warning
 * once if the row count exceeds the soft cap — apps with that many
 * keys probably want a paginated route instead.
 */
export async function getAll<T = unknown>(): Promise<Record<string, T>> {
  const rows = await sql<{ key: string; value: T }[]>`
    SELECT key, value FROM app_config ORDER BY key
  `;
  if (rows.length > SOFT_KEY_CAP && !_warnedKeyCap) {
    _warnedKeyCap = true;
    console.warn(
      JSON.stringify({
        event: "config.getAll_above_soft_cap",
        count: rows.length,
        cap: SOFT_KEY_CAP,
        message: "app_config row count exceeds soft cap; consider per-key reads",
      }),
    );
  }
  const out: Record<string, T> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/**
 * Upsert a config value. Last-writer-wins on concurrent updates;
 * apps that need optimistic locking can wrap a `get` + `set` pair in
 * `sql.begin` directly.
 *
 * `value` must be JSON-serialisable. `undefined` is rejected (use
 * `unset` to remove a key explicitly).
 */
export async function set<T>(key: string, value: T): Promise<void> {
  validateKey(key);
  if (value === undefined) {
    throw new ConfigKeyError(
      `config.set('${key}', undefined) is not allowed; use config.unset('${key}') to remove the key`,
    );
  }
  await sql`
    INSERT INTO app_config (key, value)
    VALUES (${key}, ${sql.json(value as never)})
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = now()
  `;
}

/**
 * Remove a config key. No-op if the key doesn't exist.
 */
export async function unset(key: string): Promise<void> {
  validateKey(key);
  await sql`DELETE FROM app_config WHERE key = ${key}`;
}

export const config = { get, set, getMany, getAll, unset };
