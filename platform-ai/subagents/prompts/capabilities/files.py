"""
files capability — /services/files/upload for generated downloadable artefacts.

Per-agent views:
  ARCHITECT — short line for the AVAILABLE capabilities list.
  HANDLER   — full implementation docs (uses callPlatformService directly
              until a platform.files typed wrapper exists).
"""

ARCHITECT = (
    "callPlatformService({path: '/services/files/upload', body: { name, contents, mimeType? }}) "
    "→ signed URL — generate a downloadable artefact (CSV / PDF / XLSX / ZIP / image). "
    "No platform.files wrapper yet — use callPlatformService directly."
)

HANDLER = """\
── /services/files/upload ────────────────────────────────────

NOTE: files has no platform.* typed wrapper yet — use callPlatformService
directly (the only /services/* endpoint that still requires it).

  import { callPlatformService } from "../lib/platform-call.js";

  const { status, body } = await callPlatformService<{ url: string }>({
    path: "/services/files/upload",
    body: {
      name: <filename>,            // e.g. "<report_name>.csv"
      contents: <base64_string>,   // the file bytes, base64-encoded
      mimeType: <mime>,            // e.g. "text/csv", "application/pdf"
    },
  });
  if (status === 429) { /* quota */ return ...; }
  if (status >= 400) { /* platform error */ return ...; }
  const downloadUrl = body!.url;   // signed URL valid for 1 hour

  Pass Buffers as base64:
    const b64 = buffer.toString("base64");

  Common mimeTypes:
    "text/csv"
    "application/pdf"
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    "application/zip"
    "image/png", "image/jpeg", "image/webp"\
"""
