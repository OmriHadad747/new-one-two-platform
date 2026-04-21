"""
files capability — platform.files.upload() / uploadLarge() / signReadUrl().

Per-agent views:
  ARCHITECT — short line for the AVAILABLE capabilities list, plus the
              discipline about when NOT to declare this capability.
              Declaration is the leverage point; by the time the handler
              sees its doc, the architect has already decided.
  HANDLER   — full implementation docs for both upload paths + signReadUrl.
              Assumes the architect already decided this capability is
              warranted; teaches how to use it, not whether.
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
