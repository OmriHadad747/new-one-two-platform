# Runtime example: `files_upload_small`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

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
