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

## 14. Files service — open issues

These surfaced reviewing commits `9a1233a` (resumable upload) and
`0cd2e4a` (tests) against `docs/FILES_INTEGRATION.md`.

### Correctness / security

### SDK / handler contract

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