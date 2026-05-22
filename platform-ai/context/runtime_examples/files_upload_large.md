# Runtime example: `files_upload_large`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

```ts
import { platform, PayloadTooLarge, QuotaExceeded } from "../lib/platform.js";

// Resumable upload (≤500 MiB) — exports, archives, image batches.
// Bytes go directly to GCS via signed PUT; platform-back never sees the payload.
try {
  const f = await platform.files.uploadLarge({
    name: "export-2026-05.zip",
    contents: zipBuffer,
    mimeType: "application/zip",
  });
  // Same shape as upload(): { fileId, url, expiresAt, sizeBytes }
} catch (err) {
  if (err instanceof PayloadTooLarge) throw err; // exceeds 500 MiB cap
  if (err instanceof QuotaExceeded) return;      // storage cap exhausted
  throw err;
}

// Re-sign a fresh URL when the original expires:
const link = await platform.files.signReadUrl({ fileId: f.fileId, expiresInSec: 3600 });
// link = { url, expiresAt }
```
