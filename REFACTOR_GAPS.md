# Refactor Gap Analysis

**Branches compared**
- **OLD (authoritative)**: `claude/architect-required-capabilities` — single-harness architecture, under `platform/`
- **NEW (current)**: `feature/refactor-to-standalone-app-backends` — per-app Cloud Run services, under `platform-back/`

**Goal of this doc.** Enumerate every feature the refactor silently dropped so we can
schedule catch-up work deliberately. Not every gap must be closed before shipping —
some features (billing, compliance webhooks) were never end-to-end live on OLD either.
Items closed by recent commits have been removed; what remains is real outstanding work.

> Out of scope here: doc drift (`docs/*.md` may still describe OLD behaviour),
> prompt-system changes that don't affect the refactor itself, and UI-only cleanup.

---

## 5. Uninstall / compliance webhooks

Neither OLD nor NEW is wired here, but listed so we don't forget:

- **`app/uninstalled` webhook handler** — not present
- **`shop/redact` (GDPR)** — not present
- **`customer/redact` (GDPR)** — not present
- **Tenant hard-delete admin tool** — not present

Priority depends on whether we go public with Shopify review or stay on
custom-distribution. Custom distribution → low priority. Public listing →
Shopify requires the two redact webhooks to pass review.

---



## 12. Webhook gateway — `apps/webhook-gateway/`

Core receiver + queue + idempotency + quota is ported. Noted drift:

- Log-field volume is lower on NEW vs OLD (fewer correlation fields in
  structured logs) — observability nuance, not functional.
- Retry policy (backoff + max-attempts) — verify on both branches that
  the logic matches. Not audited here.

---

## 13. Tests

Not audited line-by-line. Obvious coverage drops:

- Deployer has per-function tests but **no lifecycle test** covering
  teardown / reactivate / permanent-delete.
- `files-service.integration.test.ts` is a route-contract test (all
  mocks) — flagged in prior review.
- The new `/tenants/*` router has no route-level test yet.

---

## 14. Files service — open issues

These surfaced reviewing commits `9a1233a` (resumable upload) and
`0cd2e4a` (tests) against `docs/FILES_INTEGRATION.md`.

### Correctness / security

- **Resumable path doesn't actually reserve quota.** `create-upload-url`
  pre-checks `getTenantStorageUsage(tenantId) + expectedSizeBytes > limit`,
  but `getTenantStorageUsage` only sums `status='active'` rows — `pending`
  rows (reserved-but-not-finalized uploads) are invisible. Two concurrent
  `create-upload-url` calls both read usage=X, both insert pending rows of
  ~600 MiB against a 1 GiB cap, and a third call right after still sees
  usage=X and accepts another 600 MiB. Fix: include `'pending'` in the
  usage sum, or do an atomic reserve. Files: `packages/db/src/files.ts`
  (getTenantStorageUsage), `apps/api/src/routes/services/files.ts`
  (create-upload-url quota check).

- **Quota race on the inline path.** Same shape as above but on
  `/upload`: usage check + decision + GCS put + DB insert with no lock,
  so concurrent uploads that each fit can collectively overflow. Fix:
  atomic `INSERT … WHERE (SELECT SUM…) + new.size_bytes ≤ limit`, or
  `pg_advisory_xact_lock(tenantId)`.

- **No compensating GCS delete on DB-insert failure.** Inline path
  writes to GCS, then inserts the DB row. If the insert fails, the
  code logs `"object now orphaned"` and returns 500 — the GCS object
  stays forever (until a future orphan sweeper that doesn't exist for
  the inline path). Fix: best-effort `deleteObject(gcsObject)` in the
  catch.

- **`finalize-upload` trusts GCS-reported size blindly.** Handler
  reserves 10 MiB, PUTs 9 MiB of *different* content than intended —
  nothing checks. Worth either a code comment acknowledging this, or
  an MD5/sha verification against a handler-supplied hash.

- **`finalizeFile` race on double-finalize.** Two concurrent finalize
  calls both pass the SELECT, both run the UPDATE. Current outcome is
  harmless (same size) but if the GCS object were replaced between
  calls, the second update would clobber. Fix: advisory lock keyed on
  `fileId`.

### SDK / handler contract

- **`QuotaExceeded` reuses email-quota semantics on files path.** SDK
  does `throw new QuotaExceeded(e.limitBytes, e.usedBytes, null)` but
  the class constructor emits `"Monthly quota exceeded (${limit})"` and
  names its third field `resetsAt` — neither applies to a
  non-resetting storage quota. Logs will say "Monthly quota exceeded"
  for a permanent storage cap. Fix: a dedicated `StorageQuotaExceeded`
  class, or add `kind: "email" | "storage"` + a neutral message.

- **SDK resumable path: `PayloadTooLarge` fallback is a magic number.**
  The backend's Zod 400 for oversize returns `{ error:
  "invalid_request", details }` without `limitBytes`, so the SDK
  fallback (`25 MiB * 20 = 500 MiB-ish`) always fires. Fix either side.

- **SDK resumable path has no rollback on PUT / finalize failure.** If
  the PUT to GCS fails after `create-upload-url` succeeded, the
  `pending` row holds quota until orphan-GC sweeps it (up to 2 h
  later). Fix: add `/cancel-upload` backend route + SDK try/finally
  that calls it on PUT/finalize error.

- **Threshold boundary off-by-one.** SDK switches at `< 25 MiB`
  (resumable for exact-25 MiB); backend inline route rejects
  `> MAX_FILE_BYTES` (allows exact-25 MiB). Picks different paths for
  the same exact-boundary buffer. Pick one boundary and align.

### Orphan GC

- **GC runs on every replica with no locking.** `getStalePendingFiles`
  is `SELECT … ORDER BY created_at LIMIT 200` — every replica reads the
  same 200 rows and races on `deleteObject`. GCS's `ignoreNotFound`
  saves us from hard failure, but every replica still burns a round
  trip per row. Fix: `SELECT … FOR UPDATE SKIP LOCKED` or claim via
  `UPDATE … RETURNING`. Low severity at single-replica.

- **First GC sweep is delayed by a full interval (1 h).** The comment
  says "first sweep after a short delay" but the code only calls
  `setInterval` — which fires at T+1h, not at boot. Restart-heavy
  environments never sweep. Fix: kick an initial sweep on
  `startOrphanGc` after a ~60s delay.

### Billing / UX polish

- **`files_uploaded` usage counter never incremented.** `usage_records`
  has a `files_uploaded INTEGER` column but upload handlers never
  `incrementUsage(tenantId, 'files_uploaded')`. Billing dashboard will
  always show 0.

- **All downloads forced as `Content-Disposition: attachment`.**
  Signing hard-codes attachment for every MIME, including images.
  Admin UIs rendering images inline can't. Fix: take a `disposition:
  "attachment" | "inline"` hint in `signReadUrl`, or default images to
  `inline`.

### Minor

- **Fastify's own 413 doesn't match the spec shape.** Requests over the
  40 MiB route-level bodyLimit are rejected by Fastify's default error
  handler as `{ code, message }`, not `{ error: "payload_too_large",
  limitBytes }`. SDK constructs `new PayloadTooLarge(undefined)`. Fix:
  translate in `setErrorHandler`, or map `undefined → MAX_FILE_BYTES`
  in the SDK.

- **`Buffer.from(base64)` never throws — catch block is dead.** Node
  silently drops invalid chars, so malformed base64 produces wrong
  bytes rather than a 400. Either delete the catch, or validate with a
  regex up front.

- **Always-on handler prompt mentions `QuotaExceeded` without
  distinguishing email vs storage.** While capability docs for `files`
  are JIT-injected, the always-on SDK section lists `QuotaExceeded`
  generically — see the semantics mismatch above. Adjust prompt when
  the class is clarified.

---

## Recently closed

For change-log purposes, removed sections:

- §1 Dashboard API routes — closed by `250e124` (full /tenants/* port)
- §2 Frontend orphaned calls — closed by §1 above
- §3 Deployer lifecycle (teardown / reactivate / permanent-delete +
  unregister + deleteDockerImage) — closed by `64837cf`. Reactivate's
  cron-reschedule limitation closed by the follow-up that added
  `cron_schedule` to `deployed_functions` and threaded it through
  `getLatestDeployedVersionForApp` → `reactivateApp`.
- §4 GCS files cleanup — closed by `64837cf` (`deleteObjectsBatch` +
  wired into `permanentDeleteApp`).
- §6 Tenant-schema lifecycle — **closed by per-app schema pivot**. Each
  app now owns its own Postgres schema
  (`tenant_<tenantIdHex>_app_<first16OfAppIdHex>`), derived via
  deployer's `appSchemaName(tenantId, appId)`. Teardown is a single
  `DROP SCHEMA CASCADE` (`dropAppSchema`) — no prefix-walking, no
  `app_<hex>_` table-naming contract, no static-validator prefix rule.
  The generator keeps emitting plain `CREATE TABLE foo` and it lands
  at the correct per-app schema via `search_path`. Supersedes the
  earlier Path C (`appTablePrefix` + `dropAppTables` from `64837cf`),
  which has been removed.
- §7 DB helpers (every helper the lifecycle / routes needed) — closed
  by `7e8c3b2`.

---

## Suggested next moves

1. **Address §14 correctness items** before more handlers land — the
   quota races and SDK semantic mismatches will bite when concurrent
   traffic hits a real tenant.
2. **§13 lifecycle test** — exercise the new teardown / reactivate /
   permanent-delete sequence end-to-end against a stub Cloud Run + GCS.
3. **§5 / §8 stay deferred** unless go-to-market changes (public
   listing → §5 becomes a Shopify review blocker; charging merchants →
   §8 becomes Tier 1).
