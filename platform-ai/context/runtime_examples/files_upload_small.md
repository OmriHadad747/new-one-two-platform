# Helper: `files`

Use the `files` helper (`platform.files.upload`) to store and serve any file —
receipts, small CSVs, thumbnails. Storage (GCS), signed URLs, the size cap, and
the storage quota are platform-owned; you never touch a bucket or credentials.
`upload` is the inline path for typical artefacts (≤25 MiB); reach for
`uploadLarge` (see `files_upload_large.md`) only when you'd exceed it.

```ts
import { platform, PayloadTooLarge, QuotaExceeded } from "../lib/platform.js";

// Inline upload (≤25 MiB) — receipts, small CSVs, thumbnails.
try {
  const f = await platform.files.upload({
    name: "receipt.pdf",
    contents: pdfBuffer,         // Buffer or Uint8Array
    mimeType: "application/pdf",
  });
  // f = { fileId, url, expiresAt, sizeBytes }
  // url is a signed link valid ~15 min — call platform.files.signReadUrl for longer.
  console.log({ fileId: f.fileId, sizeBytes: f.sizeBytes }, "file uploaded");
} catch (err) {
  if (err instanceof PayloadTooLarge) {
    // err.limitBytes — switch to platform.files.uploadLarge
    throw err;
  }
  if (err instanceof QuotaExceeded) {
    // err.kind === "storage"; err.resetsAt is null (permanent cap)
    return;
  }
  throw err;
}
```

Rules:
- `upload` is for ≤25 MiB inline payloads; on `PayloadTooLarge` switch to
  `uploadLarge` (resumable, ≤500 MiB) — don't retry `upload` with the same bytes.
- The returned `url` is short-lived (~15 min) — persist `fileId`, not the URL,
  and mint a fresh link with `platform.files.signReadUrl` when serving it later.
- `QuotaExceeded` (`kind: "storage"`) is a permanent cap (`resetsAt` is `null`) —
  it won't clear on its own; stop writing rather than looping.
