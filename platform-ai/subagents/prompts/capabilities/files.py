"""
files capability — platform.files.upload() / uploadLarge() / signReadUrl().

Per-agent views:
  ARCHITECT — short line for the AVAILABLE capabilities list, plus the
              discipline about when NOT to declare this capability.
  HANDLER   — full implementation docs for both upload paths, the
              "when NOT to use" anti-patterns, and the signReadUrl
              usage for long-lived links.
"""

ARCHITECT = (
    "platform.files.upload({ name, contents, mimeType }) — inline up to 25 MiB "
    "(PDFs, small CSVs, thumbnails). platform.files.uploadLarge({...}) — resumable "
    "up to 500 MiB (bulk exports, archives, image batches). Both return "
    "{ fileId, url, expiresAt, sizeBytes }; url is a ~15 min signed link. "
    "platform.files.signReadUrl(fileId, { expiresInSec }) mints a fresh URL "
    "(up to 7 days). "
    "DECLARE ONLY when the app genuinely produces a durable download the "
    "merchant or customer needs — receipts, reports, bulk exports. Do NOT "
    "declare for data that fits in an email body, renders in an admin UI "
    "table, or could be exported natively from Shopify."
)

HANDLER = """\
── platform.files — two explicit methods, handler picks ────

The files service has TWO upload methods. The handler picks based on
the artefact being produced. There is NO auto-routing.

  platform.files.upload({ name, contents, mimeType })
    — Inline POST. Bytes transit platform-back.
    — Hard cap: 25 MiB. Anything larger throws PayloadTooLarge BEFORE
      the network call; the SDK enforces the cap client-side.
    — Use for: PDFs, small CSVs, thumbnails, short JSON bundles.

  platform.files.uploadLarge({ name, contents, mimeType })
    — Resumable PUT. Bytes go direct from handler to GCS; platform-back
      is not in the byte path.
    — Hard cap: 500 MiB.
    — Use for: whole-store CSV exports, theme archives, high-res image
      batches, anything that would exceed 25 MiB.

Both methods return the SAME shape:
  { fileId, url, expiresAt, sizeBytes }

  import { platform, QuotaExceeded, PayloadTooLarge } from "../lib/platform.js";

  // Small artefact — use upload().
  const pdfBuffer = await renderReceipt(order);
  try {
    const result = await platform.files.upload({
      name: `receipt-${order.id}.pdf`,
      contents: pdfBuffer,
      mimeType: "application/pdf",
    });
    await sql`
      INSERT INTO receipts (order_id, file_id)
      VALUES (${order.id}, ${result.fileId})
    `;
    return { receiptUrl: result.url };
  } catch (err) {
    if (err instanceof PayloadTooLarge) {
      // You called the wrong method — the file exceeded 25 MiB. Either
      // trim the output or switch to uploadLarge() if the file genuinely
      // must be this large.
      throw err;
    }
    if (err instanceof QuotaExceeded) {
      // Tenant storage cap hit — stop trying; surface via whatever
      // interface this handler exposes.
      return { ok: false, reason: "storage_quota_exceeded" };
    }
    throw err;
  }

  // Large artefact — use uploadLarge().
  const csvBuffer = await buildFullOrderExport(shop);
  const { fileId, url } = await platform.files.uploadLarge({
    name: `orders-${shop.id}-${today}.csv`,
    contents: csvBuffer,
    mimeType: "text/csv",
  });

── WHEN NOT TO USE THE FILES SERVICE ──────────────────────────

Before reaching for platform.files.*, verify the simpler path isn't
already there. The file service produces a durable download artefact —
it is NOT a way to hand bytes between functions or materialise data the
merchant will read once.

DO NOT upload a file when any of these fit:

  - The data fits in an email body. Render the data inline in the email
    template (platform.email.send's `data` + {{tokens}}); do not attach
    a PDF for a three-line order confirmation.

  - The data displays in an admin UI table. Return the rows from an
    admin route as JSON; the admin UI renders them. Don't materialise
    as a downloadable CSV unless the merchant explicitly needs to export.

  - Shopify has a native export for it. Product CSV, order CSV, customer
    CSV are all native Shopify admin features — do not rebuild them.
    Point the merchant at Shopify's own Export button in the UX copy.

  - The bytes are transient computation results. Return them in the HTTP
    response body of the admin/widget route that needs them. Don't round-
    trip through object storage.

  - You only need an in-memory preview or thumbnail. Use the npm
    package (sharp for images, etc.) in-process; do not upload the
    intermediate.

  - Invalidation / re-run is frequent. Files are durable — every upload
    counts against the tenant's storage cap. A cron that produces a
    "daily summary" file that nobody reads is just quota burn.

ONLY upload when all of these are true:
  1. A merchant or customer needs to download the artefact (click a link).
  2. The artefact must persist beyond the request that produced it.
  3. The data is genuinely too large or too binary for an email body /
     JSON response.

── Longer-lived download links ─────────────────────────────────

The URL returned from upload()/uploadLarge() expires in ~15 min. Store
only the fileId and mint a fresh URL when you need it:

  const [{ fileId }] = await sql`
    SELECT file_id AS "fileId" FROM receipts WHERE order_id = ${orderId}
  `;
  const { url } = await platform.files.signReadUrl({
    fileId,
    expiresInSec: 7 * 86400,         // up to 7 days; default 15 min
  });
  await platform.email.send({ to: merchant, data: { receiptUrl: url } });

── Rules ────────────────────────────────────────────────────────

  - Allowed MIME types: application/pdf, text/csv, application/json,
    application/zip, image/png, image/jpeg, image/webp.
  - Method-to-size: upload ≤ 25 MiB; uploadLarge ≤ 500 MiB. If in
    doubt about size, upload() is the default — the thrown
    PayloadTooLarge tells you to switch methods.
  - Pass Buffer or Uint8Array directly — the SDK handles transport.
    Do NOT pre-base64-encode; you'll double-encode.
  - Never assume the URL is permanent. Store fileId; re-sign on read.
  - Never construct a GCS URL yourself. The SDK is the only path.\
"""
