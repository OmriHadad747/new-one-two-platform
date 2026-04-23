# Optional Platform Templates

Scaffolding the AI currently regenerates from scratch on every app that the platform could pre-bake as a slot-based template. Benefits fall into two buckets:

- **Token savings** — the AI only fills in business-logic slots instead of regenerating boilerplate.
- **Generation reliability** — boilerplate that's error-prone (auth headers, CORS, idempotency, rate limits, a11y) becomes impossible to get wrong because the AI never touches it.

---

## Admin UI

| Template | What the platform pre-bakes | What the AI fills in | Reliability win |
|---|---|---|---|
| **App shell** | `AppProvider`, `Frame`, `Navigation`, `Toast`, `Loading` setup; Polaris CSS import; App Bridge init; session token header injection | Page title, nav items, which routes exist | AI can't forget session token header or misconfigure App Bridge |
| **List page** | `IndexTable` + pagination + `EmptyState` + skeleton loading state | Column definitions, row shape, fetch endpoint | Consistent empty/loading/error states across all apps |
| **Settings / config form** | `Page` + `Layout.AnnotatedSection` + `Form` + `useField` + `ContextualSaveBar` + success toast | Fields, validation rules, submit handler | Save/discard flow is always correct; dirty-state tracking not hand-rolled |
| **Detail / show page** | `Page` with back action, `Card`, `SkeletonPage` loading | Sections and data | Back action routing always works |
| **Confirmation modal** | `Modal` with primary/destructive action + loading state + focus trap | Copy, the action to confirm | A11y (focus, escape to close) guaranteed |
| **Bulk action table** | `IndexTable` with `BulkActions`, selection state, progress `Banner` | Actions, row shape | Selection state bugs eliminated |
| **Error boundary** | Root `ErrorBoundary` with fallback UI + error reporting | — | Unhandled render errors don't white-screen the admin |

---

## Storefront Widget

| Template | What the platform pre-bakes | What the AI fills in | Reliability win |
|---|---|---|---|
| **Widget loader** | Script tag pattern, `DOMContentLoaded` guard, config via `data-` attributes, scoped CSS reset, duplicate-mount guard | Visual markup + styles + behaviour | Widget never mounts twice; styles can't leak onto the theme |
| **Widget ↔ handler fetch** | `fetch` wrapper with retry, timeout, error fallback, `X-Shop-Domain` header | Endpoint path, body shape, response handling | CORS never breaks silently; shop header always correct |
| **Customer identity** | Reading Shopify `__st` / customer object from storefront context | Whether/how to use customer in business logic | Never leaks PII into logs; consistent anonymised shape |
| **Cart integration** | AJAX cart subscription / observer pattern, debounced updates | What to do on cart change | Theme-specific cart quirks handled once |
| **Consent gating** | Check `window.Shopify.customerPrivacy` before tracking / persisting | Which events require consent | GDPR tracking compliance by default |

---

## Backend Handler

| Template | What the platform pre-bakes | What the AI fills in | Reliability win |
|---|---|---|---|
| **Webhook handler skeleton** | Try/catch, structured log on entry/exit, duration tracking, idempotency key check, ack semantics | The event processing logic | Duplicate webhook deliveries safe by default; ack always sent |
| **Cron handler skeleton** | Lock acquisition, log start/end, error reporting, graceful exit, timeout guard | The scheduled task logic | Two replicas never double-execute; long jobs never orphan |
| **Admin API pagination loop** | GraphQL cursor loop, rate-limit backoff, result accumulation, cost tracking | Query + per-page handler | Never hits `THROTTLED` without retry; cost always within budget |
| **Admin API mutation with retry** | `userErrors` check, idempotency, retry-on-throttle, transient error classification | Mutation + variables | `userErrors` never silently ignored |
| **Outbound email** | HTML wrapper (header, footer, unsubscribe link, plain-text fallback), send via `ctx.services.email` | Subject, body, recipient logic | CAN-SPAM/GDPR-compliant unsubscribe always present |
| **Background job dispatch** | BullMQ enqueue with retry config, job name convention, correlation ID propagation | Payload, worker handler | Jobs traceable end-to-end; retry policy uniform |
| **Outbound HTTP (`ctx.http`)** | Retries, timeout, user-agent, response-size cap | URL + body | No unbounded reads; no infinite hangs |

---

## Data & Storage

| Template | What the platform pre-bakes | What the AI fills in | Reliability win |
|---|---|---|---|
| **Migration file** | `up`/`down` structure, transaction wrapper, `tenant_id` FK, `created_at`/`updated_at` defaults, standard indexes | Table name, columns, extra indexes | No migration ever forgets tenant scoping |
| **Repository / DAO skeleton** | Tenant-scoped `findById`, `list`, `insert`, `update`, `softDelete`; parameterised queries only | Entity-specific queries | SQL injection impossible; tenant leaks impossible |
| **File upload flow** | Resumable upload negotiation, quota check, orphan cleanup hook, content-type allowlist | Accepted MIME types, post-upload processing | Orphaned GCS objects prevented; quota bypass impossible |
| **Search / filter** | Query param parsing, safe `ORDER BY` allowlist, offset/limit clamping | Searchable fields, ranking | No `ORDER BY` injection; no unbounded `LIMIT` |

---

## Shared UI Patterns (cross-cutting)

| Template | What the platform pre-bakes | What the AI fills in | Reliability win |
|---|---|---|---|
| **Async data hook** | `useState` + fetch pattern, loading/error/data states, abort on unmount, retry | Endpoint, response type | No memory leaks from stale requests |
| **Optimistic mutation** | Send request, update state immediately, rollback on error, toast | The mutation + what state to update | Rollback path always exists |
| **Date / money formatting** | Locale-aware formatters using shop currency and timezone from `ctx.shop` | Where to render | Never shows USD to an EUR store |
| **Form validation** | Polaris `useField` bindings + common rules (email, url, required, maxLength) | Which fields + which rules | Validation messages consistent and a11y-correct |
| **Pagination component** | Cursor-based pagination UI + URL sync | Page size, where to render | Back/forward browser nav works |

---

## Cross-Cutting Reliability Templates

| Template | What the platform pre-bakes | Reliability win |
|---|---|---|
| **Feature flag gate** | Wrap any handler / UI with a gate checked against a central flag store | Safe rollout / kill-switch without code change |
| **Audit log writer** | Append-only log of mutating admin actions with actor, timestamp, diff | Compliance + debugging without per-app effort |
| **Idempotency key middleware** | Reject duplicate `POST` with same key within TTL | Retry-safe mutations for free |
| **PII redaction in logs** | Centralised field allowlist; everything else auto-redacted | Logs never leak customer data even if AI mis-tags a field |
| **Localised strings bundle** | Per-app `messages.json` loaded into both widget and admin | Easy i18n + no hardcoded copy in handler logic |
| **Test-fixture generator** | Sample tenant, sample shop, sample products/orders wired into `ctx` mocks | AI-generated code testable by default |

---

## Top 5 Big-Win Templates

Ranked by combined impact on reliability + token savings + how many app types benefit.

1. **Admin UI app shell** (Polaris + App Bridge + session token wiring)
   Every Category B and D app needs it and it's the single largest chunk of boilerplate the AI regenerates. High risk if wrong (broken auth, broken iframe embedding), zero app-specific variation.

2. **Webhook handler skeleton** (idempotency + ack + structured logging)
   Any Category A, B, C, or D app that uses webhooks — every archetype has a backend, so every archetype is eligible (a `backend_admin` app that reacts to `orders/create` is a perfectly normal shape). Currently the AI hand-rolls idempotency and duplicate-delivery handling differently each time — a known source of bugs. Pre-baking eliminates a whole class of correctness issues.

3. **Admin API pagination + rate-limit loop**
   Used by the majority of backend apps (Category C and D). Getting cursor pagination and `THROTTLED` backoff right is fiddly; the AI frequently under-handles edge cases. One correct implementation benefits every app.

4. **Tenant-scoped repository / DAO skeleton**
   Every app touches the DB. Forgetting `WHERE tenant_id = ?` is a cross-tenant data leak — the single highest-severity bug the AI could introduce. Making it structurally impossible is worth the investment.

5. **Settings / config form template** (Polaris `Form` + `useField` + `ContextualSaveBar`)
   Almost every Category B and D app has a merchant settings page. Dirty-state tracking, save/discard flow, and validation are repetitive and easy to get subtly wrong. High token savings + high UX consistency win.
