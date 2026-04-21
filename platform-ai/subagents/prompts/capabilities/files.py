"""
files capability — platform.files.upload() / signReadUrl().

Per-agent views:
  ARCHITECT — short line for the AVAILABLE capabilities list.
  HANDLER   — full implementation docs using the typed platform.* SDK.
"""

ARCHITECT = (
    "platform.files.upload({ name, contents, mimeType }) → { fileId, url, expiresAt, sizeBytes } "
    "— store a generated artefact (CSV / PDF / ZIP / image) in platform-owned "
    "object storage. Returns a short (~15 min) signed download URL; call "
    "platform.files.signReadUrl(fileId, ...) for longer-lived links "
    "(up to 7 days). Single-file cap: 25 MiB."
)

HANDLER = """\
── platform.files ────────────────────────────────────────────

Inline uploads up to 25 MiB. Bytes go through platform-back to GCS; the
handler never touches GCS directly. Returns a fileId (store in your DB
if you need to re-link later) plus a short signed URL (~15 min) suitable
for an immediate click / download.

  import { platform, QuotaExceeded, PayloadTooLarge } from "../lib/platform.js";

  // Typical flow — generate a PDF, upload, link it.
  const pdfBuffer = await renderPdf(order);
  try {
    const result = await platform.files.upload({
      name: `invoice-${order.id}.pdf`,
      contents: pdfBuffer,           // Buffer | Uint8Array
      mimeType: "application/pdf",
    });
    // result: { fileId, url, expiresAt, sizeBytes }
    await sql`
      INSERT INTO invoices (order_id, file_id)
      VALUES (${order.id}, ${result.fileId})
    `;
    return result;                   // or email result.url to the merchant
  } catch (err) {
    if (err instanceof PayloadTooLarge) {
      // Single file exceeded the cap. The handler should have checked size
      // BEFORE uploading; treat as a logic bug and surface loudly.
      ctx.logger.error({ err }, "file too large — splitting or trimming required");
      throw err;
    }
    if (err instanceof QuotaExceeded) {
      // Tenant storage cap hit — stop trying; notify the merchant through
      // whatever surface this handler exposes.
      return { ok: false, reason: "storage_quota_exceeded" };
    }
    throw err;
  }

── Longer-lived download links ─────────────────────────────────

The URL returned from upload() expires in ~15 min. When you need a link
that lasts longer (an email recipient opens it in 2 days, an admin page
renders an archive link), store only the fileId and mint a fresh URL
when you need it:

  const [{ fileId }] = await sql`
    SELECT file_id AS "fileId" FROM invoices WHERE order_id = ${orderId}
  `;
  const { url, expiresAt } = await platform.files.signReadUrl({
    fileId,
    expiresInSec: 7 * 86400,         // up to 7 days; default 15 min
  });

  await platform.email.send({
    to: merchant,
    data: { invoiceUrl: url },
  });

── Rules ────────────────────────────────────────────────────────

  - Allowed MIME types: application/pdf, text/csv, application/json,
    application/zip, image/png, image/jpeg, image/webp.
    The platform rejects anything else with a 4xx error.
  - Maximum single file: 25 MiB (after base64 decode). If your generation
    could exceed this — typically multi-MB CSV exports or high-res images —
    split the output or downsample before calling upload().
  - Pass Buffer or Uint8Array directly — the SDK handles base64 transport.
    Do NOT pre-base64-encode; you'll double-encode.
  - Never assume the URL is permanent. Store the fileId in your DB and
    re-sign when a link is about to be rendered.
  - Never try to construct a GCS URL yourself. The only way to produce a
    download link is through the SDK.\
"""
