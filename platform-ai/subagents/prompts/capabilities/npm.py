"""
NPM package capabilities — all pre-installed packages the handler may import.

Each package exposes per-agent views via the NPM dict below:
  architect  — short line for the AVAILABLE capabilities list.
  handler    — full implementation docs injected when declared.
  packages   — bare npm package names this capability authorizes.
  usage_rule — optional one-line discipline rule for the revision compact
               surface (omit or empty string when none).
"""

NPM: dict[str, dict[str, object]] = {
    "npm:qrcode": {
        "architect": "QR code generation as PNG buffer or SVG string (qrcode).",
        "handler": """\
── npm:qrcode ────────────────────────────────────────────────
  Declare: npmPackages: ['qrcode@1.5.3']
  Usage:
    import QRCode from "qrcode";
    const svgString = await QRCode.toString(text, { type: 'svg', width: 300 });
    const pngBuffer = await QRCode.toBuffer(text, { width: 300 });\
""",
        "packages": ("qrcode",),
        "usage_rule": "",
    },
    "npm:sharp": {
        "architect": "Image resize / convert / compose (sharp).",
        "handler": """\
── npm:sharp ─────────────────────────────────────────────────
  Declare: npmPackages: ['sharp@0.33.5']
  Formats: JPEG / PNG / WebP / AVIF in and out.
  Usage:
    import sharp from "sharp";
    const resizedBuffer = await sharp(inputBuffer)
      .resize(800, 600, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();
    const metadata = await sharp(inputBuffer).metadata();  // { width, height, format, size }
  Buffer only — .toFile() writes to a local path that does not persist
  on Cloud Run; use .toBuffer() and pass the result to the files
  service (base64-encoded).\
""",
        "packages": ("sharp",),
        "usage_rule": (
            "Use sharp(...).toBuffer() and hand the result (base64) to /services/files/upload — "
            "never .toFile() (Cloud Run FS is ephemeral)."
        ),
    },
    "npm:pdfkit": {
        "architect": "PDF generation (pdfkit).",
        "handler": """\
── npm:pdfkit ────────────────────────────────────────────────
  Declare: npmPackages: ['pdfkit@0.15.0']
  Pure JS, no native deps.
  Usage:
    import PDFDocument from "pdfkit";
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    await new Promise<void>((resolve) => { doc.on("end", () => resolve()); doc.text("<text>").end(); });
    const pdfBuffer = Buffer.concat(chunks);
  Buffer only — do NOT .pipe(fs.createWriteStream(...)) the document.
  Cloud Run's filesystem is ephemeral; hand the Buffer (base64) to
  /services/files/upload.\
""",
        "packages": ("pdfkit",),
        "usage_rule": (
            "Buffer pdfkit output via the data/end event pattern and hand the Buffer "
            "(base64) to /services/files/upload — "
            "never .pipe(fs.createWriteStream(...)) (Cloud Run FS is ephemeral)."
        ),
    },
    "npm:exceljs": {
        "architect": "Excel / XLSX workbook creation (exceljs).",
        "handler": """\
── npm:exceljs ───────────────────────────────────────────────
  Declare: npmPackages: ['exceljs@4.4.0']
  Usage:
    import ExcelJS from "exceljs";
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("<sheet_name>");
    ws.columns = [{ header: "<col_1>", key: "<key_1>" }, { header: "<col_2>", key: "<key_2>" }];
    rows.forEach((r) => ws.addRow(r));
    const xlsxBuffer = await wb.xlsx.writeBuffer();
  Buffer only — wb.xlsx.writeFile(path) writes to a local path that
  does not persist on Cloud Run; use wb.xlsx.writeBuffer() and pass
  the result (base64) to /services/files/upload.\
""",
        "packages": ("exceljs",),
        "usage_rule": (
            "Use wb.xlsx.writeBuffer() and hand the Buffer (base64) to /services/files/upload — "
            "never wb.xlsx.writeFile(path) (Cloud Run FS is ephemeral)."
        ),
    },
    "npm:csv": {
        "architect": "CSV parse and stringify (csv-parse, csv-stringify).",
        "handler": """\
── npm:csv ───────────────────────────────────────────────────
  Declare for parse:     npmPackages: ['csv-parse@5.5.6']
  Declare for stringify: npmPackages: ['csv-stringify@6.5.2']
  Declare both when the handler reads AND writes CSV.
  Usage — parse:
    import { parse } from "csv-parse/sync";
    const records = parse(csvString, { columns: true, skip_empty_lines: true });
  Usage — stringify:
    import { stringify } from "csv-stringify/sync";
    const csvString = stringify(rows, { header: true, columns: ['<col_1>', '<col_2>', '<col_3>'] });\
""",
        "packages": ("csv-parse", "csv-stringify"),
        "usage_rule": "",
    },
    "npm:xml": {
        "architect": "XML parse and build (fast-xml-parser).",
        "handler": """\
── npm:xml (fast-xml-parser) ─────────────────────────────────
  Declare: npmPackages: ['fast-xml-parser@4.3.6']
  Usage:
    import { XMLParser, XMLBuilder } from "fast-xml-parser";
    const parser = new XMLParser();
    const jsObj = parser.parse(xmlString);
    const builder = new XMLBuilder();
    const xmlOut = builder.build(jsObj);\
""",
        "packages": ("fast-xml-parser",),
        "usage_rule": "",
    },
    "npm:dayjs": {
        "architect": "Date parsing, formatting, arithmetic (dayjs).",
        "handler": """\
── npm:dayjs ─────────────────────────────────────────────────
  Declare: npmPackages: ['dayjs@1.11.13']
  Usage:
    import dayjs from "dayjs";
    const label = dayjs(<date_value>).format('YYYY-MM-DD');
    const sevenDaysAgo = dayjs().subtract(7, 'day').toISOString();\
""",
        "packages": ("dayjs",),
        "usage_rule": "",
    },
    "npm:jszip": {
        "architect": "In-memory ZIP archive creation (jszip).",
        "handler": """\
── npm:jszip ─────────────────────────────────────────────────
  Declare: npmPackages: ['jszip@3.10.1']
  Usage:
    import JSZip from "jszip";
    const zip = new JSZip();
    zip.file("<file_1>.csv", csvString);
    zip.file("<file_2>.pdf", pdfBuffer);
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });\
""",
        "packages": ("jszip",),
        "usage_rule": "",
    },
}

