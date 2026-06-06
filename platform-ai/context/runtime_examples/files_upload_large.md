# Helper: `files.uploadLarge`

Resumable variant of `files.upload` for big payloads (≤500 MiB) — exports,
archives, image batches. Bytes stream directly to GCS via a signed PUT, so
platform-back never buffers the payload. Same result shape as `upload`; reach
for it only when `upload` would throw `PayloadTooLarge`.

```ts
import { platform, PayloadTooLarge, QuotaExceeded } from "../lib/platform.js";

// Resumable upload (≤500 MiB) — exports, archives, image batches.
try {
  const f = await platform.files.uploadLarge({
    name: "export-2026-05.zip",
    contents: zipBuffer,
    mimeType: "application/zip",
  });
  // Same shape as upload(): { fileId, url, expiresAt, sizeBytes }
  console.log({ fileId: f.fileId, sizeBytes: f.sizeBytes }, "large file uploaded");
} catch (err) {
  if (err instanceof PayloadTooLarge) throw err; // exceeds 500 MiB cap
  if (err instanceof QuotaExceeded) return;      // storage cap exhausted
  throw err;
}

// Re-sign a fresh URL on demand (the upload `url` is only ~15 min):
const link = await platform.files.signReadUrl({ fileId, expiresInSec: 3600 });
// link = { url, expiresAt }
```

Rules:
- Use `uploadLarge` only above the `upload` cap (25 MiB); below it the simpler
  inline `upload` wins.
- The result shape is identical to `upload`: `{ fileId, url, expiresAt, sizeBytes }`.
- `signReadUrl`'s `expiresInSec` defaults to 900s (15 min) and maxes at 604800s
  (7 days) — persist `fileId` and re-sign on demand; never store the URL.
