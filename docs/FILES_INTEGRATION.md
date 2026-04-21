# Files Integration — Architecture

How handlers produce persisted artifacts (PDFs, CSVs, images, archives) and
hand time-bounded URLs back to merchants or customers.

## What it is

A shared object store (GCS) behind a thin platform-owned HTTP service.
Handlers never touch GCS directly. They call `platform.files.upload(...)`
to store bytes and `platform.files.signReadUrl(...)` to mint download
links. Everything tenant-scoped and quota-capped.

---

## Topology

```
handler ──POST /services/files/upload──► platform-back
                                            │  put bytes
                                            ▼
                                          GCS (bucket: $FILES_BUCKET)
                                          key: tenants/<tenantId>/apps/<appId>/<fileId>
                                            │
                             ◄── { fileId, url, expiresAt } ──

later:
handler ──POST /services/files/sign-read-url──► platform-back ──► signs URL via GCS
        ◄── { url, expiresAt } ──

consumer (browser, email recipient):
  GET <signed url> ──► GCS  (platform-back not in the path)
```

Bytes flow through platform-back on upload (MVP, inline only).
Downloads are GCS-direct via signed URLs — zero hop.

---

## The two endpoints

### `POST /services/files/upload`
Inline upload, up to 25 MB per file.

Request:
```
Authorization: Bearer <handler Cloud Run SA ID token>
Content-Type: application/json
{
  "name":     "invoice-12345.pdf",
  "mimeType": "application/pdf",
  "contents": "<base64>"
}
```

Response shapes (status code = contract):
- `200 { fileId, url, expiresAt, sizeBytes }` — stored. `url` is a signed read URL valid ~15 min.
- `413 { error: "payload_too_large", limitBytes: 26214400 }` — single-file cap hit.
- `429 { error: "quota_exceeded", usedBytes, limitBytes }` — tenant storage cap hit.
- `415 { error: "unsupported_mime_type", allowed: [...] }` — MIME not in allowlist.
- `400 { error: "invalid_request", details }` — malformed body.
- `5xx` — platform/GCS transient. Handler treats as soft failure.

### `POST /services/files/sign-read-url`
Get a fresh signed URL for an existing file.

Request:
```
Authorization: Bearer <handler SA ID token>
{ "fileId": "uuid", "expiresInSec": 604800 }   // optional; default 900, max 604800 (7 days)
```

Response:
- `200 { url, expiresAt }`
- `404 { error: "not_found" }` — fileId unknown or not owned by this (tenant, app).
- `400 { error: "invalid_expires_in" }` — out of range.

Both endpoints auth via the handler's Cloud Run service account ID token,
mapped to `(tenantId, appId)` via `apps.handler_sa_email`. Same pattern as
`/services/email/send`.

---

## Storage model

One shared GCS bucket (env: `FILES_BUCKET`). Object keys follow the pattern:

```
tenants/<tenantId>/apps/<appId>/<fileId>
```

No per-tenant buckets, no per-app buckets. The key prefix is the isolation
boundary; IAM on the bucket allows only platform-back's SA to read/write.
Handlers never get bucket-level credentials.

---

## Database contract

New table (`files`):

```sql
CREATE TABLE files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id       UUID NOT NULL REFERENCES apps(id)    ON DELETE CASCADE,
  name         TEXT NOT NULL,        -- for Content-Disposition on download
  mime_type    TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  gcs_object   TEXT NOT NULL UNIQUE, -- full object key
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'pending', 'failed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX files_tenant_app_idx ON files(tenant_id, app_id);
CREATE INDEX files_created_idx    ON files(created_at);
```

`tenants` gains one column:

```sql
ALTER TABLE tenants
  ADD COLUMN storage_limit_bytes BIGINT NOT NULL DEFAULT 1073741824;  -- 1 GiB
```

**Why `status` now.** Only `'active'` is used today (inline path). `'pending'` /
`'failed'` are reserved for the resumable-upload pattern (see Future work).
Landing the column from day one avoids a later migration on an existing
tenant's files table.

**Uninstall.** `ON DELETE CASCADE` drops rows when the tenant is deleted.
GCS objects must be deleted *eagerly* by the uninstall flow — the DB
cascade doesn't reach GCS. Platform's uninstall handler:

```
1. SELECT gcs_object FROM files WHERE tenant_id = $1
2. Batch-delete from GCS (capped concurrency, e.g. 50 at a time)
3. DELETE tenant → files rows cascade away
```

Eager deletion is required for GDPR compliance; don't lean on bucket
lifecycle rules.

---

## URL lifecycle

Two methods instead of one, because use cases span seconds to days.

| Use case | Pattern |
|---|---|
| Merchant clicks "download PDF now" | Use the 15-min URL returned from `upload()`. |
| Send a link in an email that opens in 3 days | `signReadUrl(fileId, { expiresInSec: 7 * 86400 })` at send time. |
| Merchant opens an archived file tomorrow from the app's admin | Store only `fileId`. Call `signReadUrl` on click. |

Max expiry: **7 days (604800 sec)**. Hardcoded cap in the route. No
permanently-signed URLs ever leave the platform. No CDN in the read path
for MVP — GCS signed URLs go direct to the browser.

---

## Constraints

| Limit | Value | Enforced at |
|---|---|---|
| Single-file upload size | **25 MB** | Fastify `bodyLimit` + explicit size check |
| Tenant storage total | per-plan (see `BILLING.md`) | pre-insert quota check |
| Max `expiresInSec` for signed URLs | **7 days** | `sign-read-url` route |
| MIME allowlist (initial) | `application/pdf`, `text/csv`, `application/json`, `application/zip`, `image/png`, `image/jpeg`, `image/webp` | upload route |

The 25 MB cap and MIME allowlist are configurable via env for future
tuning; the 7-day expiry cap is hard-coded (a longer TTL is a
deliberate-design-decision moment, not a config knob).

---

## Auth

- Handler → platform-back: Google Cloud Run SA ID token, same as other `/services/*`.
- Platform-back → GCS: platform-back's own SA with `roles/storage.objectAdmin` on `$FILES_BUCKET`.
- Handler → GCS: never. Always signed-URL-only.
- Signed URL → GCS: signature is the boundary; GCS checks it.

No shared secrets anywhere. No handler holds bucket credentials.

---

## What the platform does *not* do

- **No list API.** Handlers that need file visibility store `fileId` in
  their own tenant schema (e.g. `invoices (id, file_id, order_id, ...)`)
  and render their own views. No `GET /services/files/list` exists.
- **No admin UI in platform-front.** Files are an implementation detail
  of each app; platform's dashboard stays out.
- **No CDN in front of signed URLs.** MVP ships GCS-direct. Revisit when
  download volume actually warrants it.
- **No thumbnail generation, image transforms, MIME sniffing.** Handler's
  responsibility if it needs them (e.g. `sharp` npm package).
- **No webhook on delivery / download.** If a handler needs to know "did
  the customer click the link," it builds its own instrumentation (e.g.
  a `GET /admin/download/:fileId` proxy in its own admin route that
  redirects to the signed URL after logging).

---

## Error taxonomy (what handlers must handle)

Mirrors `/services/email`:

- **2xx** → continue; the file is stored, use the returned URL or the `fileId`.
- **413 PayloadTooLarge** → thrown as `PayloadTooLarge` by the SDK. Handler should have caught this earlier (e.g. by declining to generate a PDF that would exceed the cap). Treat as a programming error.
- **429 QuotaExceeded** → thrown as `QuotaExceeded`. Tenant has hit their storage cap. Stop trying, surface a user-facing message.
- **415 UnsupportedMimeType** → throw (generic Error). Generator shouldn't be requesting exotic MIME types; caller bug.
- **4xx other** → programming errors, throw.
- **5xx** → transient; SDK returns a result with `delivered: false, reason: "platform_error"` (same soft-fail pattern as email). Handler logs and continues without the file.

---

## Generator contract

The *only* way the generator authors file operations is via the typed SDK:

```ts
import { platform, QuotaExceeded, PayloadTooLarge } from "../lib/platform.js";

const { fileId, url } = await platform.files.upload({
  name: "invoice.pdf",
  contents: buffer,
  mimeType: "application/pdf",
});
```

```ts
const { url } = await platform.files.signReadUrl({
  fileId,
  expiresInSec: 7 * 86400,
});
```

`callPlatformService` is never taught for files. If `platform.files` is
missing a method, that's a platform-side issue — not something the
generator routes around.

---

## Future work

Deliberately deferred to keep MVP tight.

### Resumable upload (>25 MB)

For use cases like full-store CSV exports, theme archives, high-res
product images. Pattern:

```
handler → createUploadUrl({ name, mimeType, expectedSizeBytes })
        ← { fileId, uploadUrl, expiresAt }    // PUT URL, 1h TTL, row status='pending'

handler → PUT uploadUrl (bytes)               // direct to GCS
        ← 200 OK

handler → finalizeUpload({ fileId })
        ← { fileId, url, expiresAt, sizeBytes }   // row flipped to 'active'
```

Additive work when a real use case lands:
- `@platform-back/files`: one method — `createResumableUploadUrl`.
- Two new routes (create-upload-url, finalize-upload).
- Orphan GC: pg_cron job every hour sweeping rows in `status='pending'`
  older than 2 hours (generous grace over the 1h PUT URL TTL). Deletes
  GCS object (if any) + row.
- SDK: keep one method — `platform.files.upload(...)` auto-picks inline
  vs resumable based on buffer size. Generator doesn't pick.

Schema is already compatible (`status` column exists). No DB migration
needed at that point.

### CDN fronting

Once signed-URL traffic becomes meaningful, front GCS with Cloud CDN
and have `sign-read-url` return CDN URLs instead of direct GCS URLs.
No SDK change; purely an infrastructure flip.

### Per-plan MIME extensions

A higher-tier plan could unlock additional MIME types (e.g. video for
some archetype we haven't designed yet). Wire the allowlist through
the tenant's billing plan instead of env-wide.

### Orphan GC without resumable

Even in the inline-only world, a crash between GCS put and DB insert
could leave an orphan object. Rare but possible. Low priority — if it
shows up in monitoring, add a sweeper that reconciles GCS prefix against
DB rows.
