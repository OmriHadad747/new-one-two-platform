# Platform-Wide Idempotency — Implementation Plan

## Goal

Eliminate the entire class of "client retry / double-click → duplicate
side effect" bugs by making request idempotency a **platform-owned**
concern. App authors and the LLM never think about it; the runtime SDKs
auto-supply idempotency keys, and platform middleware deduplicates
replays before the handler ever runs.

## Why now

Currently every generated app has to hand-roll its own idempotency
defenses:

- LLD writes `dedupKey` on `enqueue` steps (we just added a validator
  forcing this).
- LLD writes `ON CONFLICT DO NOTHING` on every `sql_insert`.
- LLD writes `sql_claim` (UPDATE…RETURNING) before every external side
  effect.
- Webhook handlers rely on the template's `processed_webhooks` table
  for envelope dedup.

This split is fragile: the LLM remembers most of it, forgets the rest,
each app reinvents the same patterns, and validators enforce them
case-by-case. Centralising idempotency in the platform makes the
guarantee structural, not a per-recipe discipline.

## Surface analysis — who calls whom today

```
┌──────────────────────┐    POST /widget/<path>     ┌─────────────────────┐
│ Storefront browser   │ ─────host.call()─────────▶ │  App handler        │
│ (widget-runtime.js)  │                            │  (Cloud Run, per-   │
└──────────────────────┘                            │   tenant)           │
                                                    │                     │
┌──────────────────────┐    POST /admin/<path>      │  Express:           │
│ Shopify admin iframe │ ─────bridge.call()───────▶ │  /widget/*          │
│ (platform-shopify-   │                            │  /admin/*           │
│  admin React app)    │                            │  /webhook/*         │
└──────────────────────┘                            │                     │
                                                    │                     │
┌──────────────────────┐    POST /webhook/<topic>   │                     │
│ Shopify (webhook-    │ ──platform-back gateway──▶ │                     │
│  gateway proxy)      │                            └─────────────────────┘
└──────────────────────┘
```

Three callers, each gets idempotency wired in at its own layer:

| Caller | Where the key originates | How it travels |
|---|---|---|
| Widget (storefront) | `host.call` SDK auto-mints UUID, caches in `sessionStorage` | `Idempotency-Key: <uuid>` header on every POST |
| Admin panel (iframe) | `bridge.call` SDK auto-mints UUID, caches in `sessionStorage` | `Idempotency-Key: <uuid>` header on every POST |
| Webhook (Shopify) | Shopify already includes `X-Shopify-Webhook-Id` per delivery | Webhook-gateway forwards `X-Shopify-Webhook-Id` as `Idempotency-Key` |

The handler middleware is **identical** for all three — it only ever
sees a normalised `Idempotency-Key` header.

## Specification

### Cache contract

```sql
CREATE TABLE request_idempotency (
  -- Composite key: tenant + route + caller-supplied key.
  -- Tenant is implicit via the per-tenant schema (search_path pinned),
  -- so it is NOT a column — search_path IS the tenancy scope.
  route_method  TEXT NOT NULL,        -- 'POST', 'PUT', 'DELETE'
  route_path    TEXT NOT NULL,        -- '/admin/runs/start'
  idempotency_key TEXT NOT NULL,      -- caller-supplied UUID or webhook id
  body_hash     TEXT NOT NULL,        -- sha256 of request body — see below
  status_code   INTEGER NOT NULL,
  response_body BYTEA NOT NULL,       -- raw JSON bytes the handler returned
  response_headers JSONB NOT NULL,    -- subset (Content-Type, custom keys)
  inserted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (route_method, route_path, idempotency_key)
);

CREATE INDEX request_idempotency_inserted_at_idx
  ON request_idempotency (inserted_at);
```

### Hit / miss semantics

```
Incoming POST /admin/runs/start with header Idempotency-Key: K, body B
                  │
                  ▼
        SELECT body_hash, status_code, response_body, response_headers
          FROM request_idempotency
         WHERE route_method='POST' AND route_path='/admin/runs/start'
           AND idempotency_key=K
                  │
        ┌─────────┴─────────┐
        │                   │
       MISS                HIT
        │                   │
        │            sha256(B) == body_hash?
        │            ┌──────┴──────┐
        │           yes            no
        │            │              │
        │       replay status +     422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY
        │       response_body       (signals client bug — same key, different intent)
        │       (handler does
        │        NOT run)
        │
   Run handler → on response, atomically:
     INSERT INTO request_idempotency (...)
     ON CONFLICT (route_method, route_path, idempotency_key) DO NOTHING
   (if a concurrent request already cached, our insert is a no-op
    and we still return our handler's response — both clients get
    a coherent answer; the cache is consistent for any future replay.)
```

### Scope and exclusions

**Methods:** middleware runs on `POST`, `PUT`, `DELETE`. `GET` and
`HEAD` are read-only and not cached here (they have their own caching
story).

**Routes:** middleware runs on `/admin/*`, `/widget/*`, `/webhook/*`.
Health checks and platform-internal routes opt out via a route attribute.

**Header is required for `/admin/*` and `/widget/*`** — if absent, the
middleware returns 400 with `error: "missing_idempotency_key"`. This
forces the SDKs (and any third-party caller) into the idempotent path
by construction. The architecture promise depends on this: optional
keys = unreliable dedup.

**Header is auto-derived for `/webhook/*`** from `X-Shopify-Webhook-Id`
which Shopify always supplies. The middleware runs uniformly.

**TTL:** retain entries for 24 hours by default. Long enough to cover
client retries and short network outages; short enough to bound the
table. A platform-owned cron sweep (in the handler template, runs
hourly) deletes rows older than the TTL.

**Body hash:** `sha256(canonical_json(body))` for `application/json`
bodies. Webhook bodies are hashed raw (Shopify already provides HMAC
verification upstream). Hashing prevents the "client reused the same
key for a different request" bug from silently succeeding.

**Response cache size cap:** responses larger than 64 KiB are NOT
cached — the middleware runs the handler, returns the response, and
records a `body_hash`-only row (no replay possible). This bounds the
table; the rare large-response replay loses dedup but never causes
wrong behavior. Logged as a structured warn so operators can see if
it becomes common.

### Concurrency

Two concurrent requests with the same `(route, key)` may both reach
the handler before either inserts the cache row. The
`ON CONFLICT DO NOTHING` on insert means whichever finishes first wins
the cache slot; the other's response is also returned to its own
caller (correct, since both bodies are identical by construction —
same key + same hash precondition). Future replays see the cached row
and never run the handler. So the worst case is "both run once" not
"infinitely many run".

For routes where even a single double-execution is unacceptable (rare
— e.g. money charge), the handler still uses `sql_claim` as a final
defense. The middleware moves the bar from "every POST is at risk" to
"this one specific row needs an atomic claim" — a 95% reduction in
defensive surface.

## Implementation phases

### Phase 0 — Shape and contracts

**Files to author:** `docs/IDEMPOTENCY_CONTRACT.md`

Lock the wire shape (header name, error codes, body-hash algorithm,
TTL) before any code lands. Once Web SDKs and handlers are deployed
referring to this contract, changing it is a coordinated rollout. Get
this written and circulated first.

### Phase 1 — Handler template middleware

**Goal:** the handler-side enforcement and replay logic.

**Files to author:**
- `platform-back/templates/handler/src/lib/idempotency.ts` —
  the helper exporting `cacheLookup(...)`, `cacheStore(...)`,
  `hashBody(...)`, plus the constants (TTL, response size cap).
- `platform-back/templates/handler/src/middleware/idempotency.ts` —
  Express middleware. Wraps res.json / res.status to capture the
  outgoing response, inserts into the cache after the handler resolves.
- `platform-back/templates/handler/migrations/0002_request_idempotency.sql`
  — template-owned migration adding the table.
- `platform-back/templates/handler/src/lib/cron-runner.ts` (modify) —
  add a built-in `_idempotency_sweep` job that runs hourly and deletes
  expired rows.

**Files to modify:**
- `platform-back/templates/handler/src/server.ts` — wire the
  middleware into `/admin/*`, `/widget/*`, `/webhook/*` routers
  AFTER `verify-platform` (so the cache key is namespaced inside the
  authenticated tenant scope, never across tenants).
- Delete the existing `processed_webhooks` table and its handler
  code — the new middleware replaces it.

### Phase 2 — Webhook gateway

**Goal:** webhook deliveries automatically carry an idempotency key.

**Files to modify:**
- `platform-back/apps/webhook-gateway/src/routes/...` — find the
  outbound HTTP call to the tenant handler, copy
  `X-Shopify-Webhook-Id` into the `Idempotency-Key` header before
  forwarding.

### Phase 3 — Storefront widget runtime SDK

**Goal:** every `host.call(path, body)` from a widget POSTs with an
auto-supplied `Idempotency-Key`.

**Files to modify:**
- `platform-shopify-app/extensions/widget-runtime/assets/widget-runtime.js`
  — locate the `host.call` implementation; before each POST/PUT/DELETE
  fetch, mint a UUID v4 (or use a SHA hash of `body + Date.now()` for
  replay-distinguishing semantics), store keyed by call-site +
  body-hash in `sessionStorage` (TTL 5 min), and send as
  `Idempotency-Key`.

**Algorithm — what counts as "the same logical request":**
- Hash the request: `sha256(method + path + canonicalJson(body))`.
- Look up `idempotency:<hash>` in `sessionStorage`. If present and
  fresh (<5 min), reuse the stored UUID. Else mint a new UUID, store
  it, send.
- This makes duplicate clicks on the same button within 5 minutes
  collapse into one server execution; distinct intents (different
  button presses, different bodies) get different keys.

### Phase 4 — Admin iframe SDK (`bridge.call`)

**Goal:** every `bridge.call(path, body)` from the admin panel POSTs
with an auto-supplied `Idempotency-Key`.

**Files to modify:**
- `platform-shopify-admin/src/...` — find the `bridge.call`
  implementation. Same key-derivation algorithm as Phase 3.

### Phase 5 — Deployer hooks

**Goal:** every newly-deployed handler picks up the new middleware
and migration automatically.

**Files to modify:**
- `platform-back/packages/deployer/src/...` — verify the deployer
  copies the entire `templates/handler/migrations/` directory into
  each new app's deploy.
- Verify `templates/handler/src/server.ts` change ships with every
  deploy.

### Phase 6 — LLD prompt + schema simplification

**Goal:** the LLM stops carrying defensive idempotency burden the
platform now handles.

**Files to modify:**
- `platform-ai/subagents/lld_agent/schema.py`:
  - Remove `EnqueueStep.dedupKey` field entirely.
  - Remove `_enqueue_after_sql_insert_requires_dedup_key` validator.
  - Soften `sql_claim` requirement (R1) — middleware already
    dedupes the request envelope. R1 retains its role for transitions
    INSIDE a recipe (e.g. workflow `pending`→`running` claim) but no
    longer needs to defend against double-execution of the request
    itself. Update the prompt wording to reflect this.
  - Soften R3 (replay-safe `INSERT`s `ON CONFLICT`) — for
    request-driven inserts that the middleware now dedupes upstream,
    `ON CONFLICT` is no longer strictly required. Webhook handlers
    still need it (Shopify can replay across long windows beyond the
    24h cache TTL).
- `platform-ai/subagents/lld_agent/prompt.py`:
  - Add a short section near the top: "Request idempotency is
    handled by the platform — the route layer dedupes replays of
    the same `(method, path, key)` within 24h. You do NOT need
    `ON CONFLICT` on request-driven `sql_insert` steps; you do NOT
    need `dedupKey` on `enqueue` steps; you do NOT need `sql_claim`
    just to defend against retried POSTs. `sql_claim` is still
    required when (a) the same row is touched by multiple concurrent
    paths (cron + webhook) or (b) you're transitioning a workflow
    state machine row."
- `platform-ai/subagents/prompts/topics/template_tables.py` — add
  `request_idempotency` to the template-owned table list so the LLD
  doesn't try to redeclare it.

### Phase 7 — Documentation + observability

**Files to author:**
- Update `docs/IDEMPOTENCY_CONTRACT.md` with a "How to call the API
  from a third party" section (for partners integrating directly).
- Add metrics: cache hit rate, oversize-skip rate, body-hash mismatch
  rate. Wire to existing Cloud Logging / Grafana dashboards.

## Sequencing

```
Phase 0 (contract) ────┐
                       ▼
                    Phase 1 (handler template middleware,
                             enforcement on day one)
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
     Phase 2        Phase 3        Phase 4
     (gateway)      (widget SDK)   (bridge SDK)
        │              │              │
        └──────────────┼──────────────┘
                       ▼
                    Phase 5 (deployer)
                       │
                       ▼
                    Phase 6 (LLD prompt + schema)
                       │
                       ▼
                    Phase 7 (docs + dashboards)
```

Land in one PR series. No staged rollout, no feature flags.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Webhook gateway fails to forward `X-Shopify-Webhook-Id` for a topic | Runtime assertion that fails loudly if the header is missing on a webhook delivery |
| `request_idempotency` table grows unbounded if sweep cron stops | Sweep is itself a cron job that dedupes via `enqueueJob` (single in-flight); add an alert on table size > 100k rows per tenant |
| Body-hash collision (sha256 — vanishingly improbable but still) | The 422 response on body-hash mismatch is the safe failure mode; client-visible, never silent corruption |
| Third-party API consumers can't easily integrate (no SDK) | Phase 7 docs include the contract; force everyone through dedup, no bypass |

## Success metrics (Phase 7)

- Handler dedup hit rate >0 within 1 day of Phase 1 (confirms the SDKs
  are sending headers).
- Generated LLD output token count drops by ~5% on average (Phase 6
  effect — fewer `ON CONFLICT` clauses).
- Zero "duplicate run" support tickets attributable to client retry
  (today this is a recurring class).
- `request_idempotency` table size per tenant stays under ~10k rows
  steady-state (validates TTL + sweep are working).

## Open questions to resolve before Phase 0 lands

1. **Per-route TTL overrides** — should some routes have a longer
   cache (e.g. `/admin/runs/start` keeps a key for 7 days because
   merchants might re-trigger from email)? Default 24h covers most
   cases; per-route override is a future extension.
2. **Cache bytes cost** — at 64KiB cap × 10k rows × N tenants, the
   table size could become non-trivial. Prove out with a load test
   before committing to the cap.

## Estimated scope

| Phase | Effort |
|---|---|
| 0. Contract doc | 0.5 day |
| 1. Handler middleware | 1 day |
| 2. Webhook gateway header forward | 0.5 day |
| 3. Widget SDK key derivation | 0.5 day |
| 4. Bridge SDK key derivation | 0.5 day |
| 5. Deployer validation | 0.5 day |
| 6. LLD prompt + schema simplification | 0.5 day |
| 7. Docs + dashboards | 0.5 day |
| **Total** | **~4.5 working days** |
