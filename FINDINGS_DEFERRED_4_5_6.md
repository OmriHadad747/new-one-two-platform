# Deferred Findings — 4, 5, 6

Context: evaluation of generated bundle at
`platform-ai/cli/test_results/2026-04-23T23-24-56_recover-abandoned-carts-by-sending-timely/`.

Findings 1, 2, 3 (cron handler Shopify client misuse, `cron_queue` misuse,
wrong Shopify endpoint) are being handled first. These three are non-trivial
and should be addressed afterward, carefully.

---

## Finding 4 — Settings save accumulates duplicate rows instead of upserting

### What the generator produced

Migration:

```sql
CREATE TABLE abandonment_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  abandonment_delay_minutes INTEGER NOT NULL DEFAULT 60,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Admin route `POST /settings/save`:

```sql
INSERT INTO abandonment_settings (abandonment_delay_minutes, is_enabled, created_at, updated_at)
VALUES (${abandonment_delay_minutes}, ${is_enabled}, NOW(), NOW())
ON CONFLICT (id) DO UPDATE
  SET abandonment_delay_minutes = EXCLUDED.abandonment_delay_minutes,
      is_enabled                = EXCLUDED.is_enabled,
      updated_at                = NOW()
```

Reads use `SELECT ... FROM abandonment_settings LIMIT 1`.

### Why it's broken

`id` is `gen_random_uuid()` and is not specified in the INSERT. Every save
mints a fresh UUID, so the conflict on `id` can never fire. The table grows
by one row per save. Reads return an arbitrary row (Postgres makes no
ordering guarantee without `ORDER BY`), so "what settings are live" is
effectively random after the first save.

This is a **singleton config table** pattern. Singletons need one of:

- a fixed sentinel `id` (e.g. `'00000000-0000-0000-0000-000000000000'`) plus
  `UPDATE ... WHERE id = <sentinel>` or `INSERT ... ON CONFLICT (id) DO UPDATE`
  with the sentinel spelled out in VALUES;
- a generated column / `CHECK` pinning rows to a single logical key (e.g.
  `singleton BOOLEAN GENERATED ALWAYS AS (true) STORED UNIQUE`);
- explicit two-step: `UPDATE`; if `rowCount === 0`, `INSERT`.

The generator reached for the conflict-target idiom without recognizing that
`id` had no stable value to conflict on.

### Root cause

Prompt gap. Nothing in the architect or handler prompts teaches the
"singleton settings table" pattern. The architect emitted a `dbContract`
with a UUID PK and no uniqueness constraint on anything else — technically
valid SQL, but wrong shape for a singleton. The handler then faithfully
generated broken upsert SQL that matches the shape it was given.

### Suggested fix

Two layers:

1. **Architect prompt.** When a `dbContract` represents singleton settings
   (heuristic: one row ever, no natural key, tables named `*_settings` or
   similar), emit a sentinel pattern:

   ```json
   {
     "table": "abandonment_settings",
     "columns": [
       { "name": "id", "type": "BOOLEAN", "constraints": "PRIMARY KEY DEFAULT true CHECK (id = true)" },
       ...
     ]
   }
   ```

   Or add a `singleton: true` flag to `dbContracts` entries and let the
   migration generator emit the `CHECK (singleton = true) UNIQUE` column
   from that flag.

2. **Handler prompt.** Add a short section "Singleton settings pattern"
   showing the canonical UPSERT against the sentinel, so the handler
   doesn't invent a broken `ON CONFLICT (id)` when the table shape changes.

### Why it's not trivial

- The architect schema needs a new field or a new pattern convention; both
  touch the JSON schema exposed to the model and the validator's
  understanding of `dbContracts`.
- Existing app contracts may already use the "UUID PK + no uniqueness"
  shape; changing the default silently shifts generated migrations. Needs
  to be an opt-in flag, not a behavior change.
- Migration diffs for already-deployed apps would need a one-time data
  cleanup (collapse N rows → 1 sentinel row). Not in scope for gen, but the
  change creates the burden.

### Severity / blast radius

**High for correctness, low for observability.** Merchant saves settings,
sees "Saved successfully", and the read *usually* returns the latest row
because `LIMIT 1` often hits the newest page. The bug surfaces as
occasional "my settings reverted" reports, which are maddening to debug.

Will recur on every app that has a settings/config table — which is most
of them.

---

## Finding 5 — `FOR UPDATE SKIP LOCKED` offers no real protection

### What the generator produced

In the cron second pass ([cron.ts:243-256](platform-ai/cli/test_results/2026-04-23T23-24-56_recover-abandoned-carts-by-sending-timely/src/routes/cron.ts#L243)):

```ts
const pendingRows = await sql`
  SELECT id, checkout_id, customer_email, ...
  FROM abandoned_cart_queue
  WHERE status = 'pending'
  FOR UPDATE SKIP LOCKED
`;

for (const row of pendingRows) {
  // ... send email via platform.email.send
  await sql`UPDATE abandoned_cart_queue SET status = 'sent', sent_at = NOW() WHERE id = ${row.id}`;
  await sql`INSERT INTO abandonment_send_log (...) VALUES (...)`;
}
```

### Why it's broken

Each `sql\`...\`` call auto-commits. The `FOR UPDATE SKIP LOCKED` lock is
released the moment the SELECT's implicit transaction commits — before the
loop body even runs. Subsequent `UPDATE` and `INSERT` statements run with
no lock held on the queue row.

Two overlapping cron ticks can therefore both read the same `pending` row,
both send the email, and both mark it `sent`. The architect contract
explicitly called out this risk:

> *"Duplicate cron runs overlap due to slow execution — use
> FOR UPDATE SKIP LOCKED on the queue table to prevent double-sending the
> same record"*

The handler emitted the SQL keyword but not the transaction boundary that
makes it work.

### Root cause

Two-part:

1. **Template convention unclear.** `sql` in the template is (likely)
   `postgres-js` or similar tagged-template helper; it auto-commits per
   call. To get a multi-statement transaction, the handler would need
   `sql.begin(async (tx) => { ... })` or equivalent. The handler prompt
   doesn't document this pattern.
2. **Prompt gap.** The cron contract describes the *lock intent*
   (`FOR UPDATE SKIP LOCKED`) but not the *transaction boundary*. The
   handler agent pattern-matches on the SQL idiom without understanding the
   surrounding transaction semantics.

### Suggested fix

- **Handler prompt.** Add a "Concurrency idioms" section that specifies:
  *whenever you emit `FOR UPDATE SKIP LOCKED`, the claim-process-update
  span must be inside a `sql.begin(...)` block, one row per transaction,
  and the email send must happen inside the transaction so its success
  gates the status update.*
- **Template helper.** Consider a higher-level helper — e.g.
  `claimAndProcess(tableName, filter, async (row, tx) => { ... })` — that
  encapsulates the lock-send-update pattern so the handler doesn't hand-roll
  transactions. This parallels the `enqueueJob(...)` approach from
  finding 2: replace a footgun-prone SQL idiom with a named template API.
- **Validator.** Static check: if `FOR UPDATE SKIP LOCKED` appears in
  handler SQL, require the enclosing statement to be inside a
  `sql.begin(...)` or equivalent. AST-level or regex-level check; either
  works.

### Why it's not trivial

- Email send-inside-transaction is itself a tradeoff: if the email provider
  call takes 2s, the row stays locked for 2s, limiting parallelism. The
  correct pattern is probably "claim row + set `status='claimed'` inside
  tx; commit; send email; second tx to mark sent/failed." That's a
  non-obvious three-phase pattern that should be codified in a template
  helper rather than spelled out prose-by-prose in a prompt.
- Testing this requires actually simulating overlapping cron runs, which
  none of the current validators do.

### Severity / blast radius

**Medium.** Single-worker deployments won't hit it. Scaled deployments or
slow runs that overlap will double-send. Merchant impact = duplicate
reminder emails to customers, which is a real brand problem, but low
frequency.

Will recur on every app that uses the queue-with-locked-claim pattern.

---

## Finding 6 — Admin UI shows always-empty status filters

### What the generator produced

Admin UI queue view has filter buttons for:

```
All | Pending | Sent | Failed | Converted | Skipped
```

The cron handler only ever writes `pending`, `sent`, or `failed`. The
`converted` and `skipped` buttons will always return zero rows.

### Why it's broken

The UI agent invented two plausible-sounding statuses (the architect's
edge-case list does mention "mark as converted" and "skip silently" as
behaviors, but no code path in the handler materializes those into queue
rows). The UI rendered filters for statuses that the handler never emits.

### Root cause

No cross-agent contract on enum values. Architect emits `dbContracts` with
a `status TEXT NOT NULL DEFAULT 'pending'` column but no enumerated values;
handler decides unilaterally which statuses it writes; UI decides
unilaterally which statuses to filter by. Each agent guesses, and the
guesses don't have to agree.

### Suggested fix

- **Architect schema.** Change status columns from free-form `TEXT` to
  enumerated values in the contract:

  ```json
  {
    "name": "status",
    "type": "TEXT",
    "constraints": "NOT NULL DEFAULT 'pending'",
    "enum": ["pending", "sent", "failed"]
  }
  ```

  And/or emit a Postgres `CHECK (status IN (...))` constraint in the
  migration so the DB itself rejects unknown values.

- **Handler & UI prompts.** Both read the `enum` list from `dbContracts`
  and treat it as authoritative. Handler writes only those values; UI
  filters only on those values.

- **Validator.** Cross-check: every literal status value in handler SQL
  and in UI filter buttons must be in the `enum` set for that column.

### Why it's not trivial

- The enum-in-contract change is a schema change that ripples through the
  architect prompt, handler prompt, UI prompt, migration generator, and
  (likely) the validator. Coordinated edit across five surfaces.
- The UI agent currently seems to use the architect's `edgeCases` narrative
  to pad the filter list — changing behavior here may make the UI feel
  less "complete" for apps where the handler genuinely does emit
  intermediate statuses. Worth keeping the architect free to declare
  additional statuses if the handler will write them; the fix is to
  enforce *consistency*, not to limit to three.

### Severity / blast radius

**Low.** Cosmetic. Two empty filter buckets. No data loss, no runtime
error. Worth fixing because it makes the generated UI look unpolished and
because the same inconsistency-between-agents pattern will surface in
worse places (e.g. admin UI calling a route the handler never defined,
or displaying fields the DB doesn't have).

---

## Cross-cutting theme

All three findings have the same shape: **no single source of truth shared
between architect, handler, and UI agents**. Each agent reads the
architect plan through its own lens and fills in the blanks independently.

- Finding 4: no singleton-pattern field in `dbContracts`.
- Finding 5: no transaction-boundary field in `cronContract`.
- Finding 6: no enum-values field on status columns in `dbContracts`.

Fixing these individually is fine. Fixing them systematically means
tightening the architect schema so every decision the downstream agents
need is named, typed, and validated — not implied in prose.
