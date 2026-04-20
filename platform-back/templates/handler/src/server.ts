import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { closeDb } from "./lib/db.js";
import { verifyPlatform } from "./middleware/verify-platform.js";
import { adminRouter } from "./routes/admin.js";
import { platformAdminRouter } from "./routes/admin-platform.js";
import { webhookRouter } from "./routes/webhook.js";

const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";

const app = express();
app.disable("x-powered-by");

// JSON only — handlers don't accept multipart or url-encoded payloads from
// the platform. 1 MiB cap mirrors platform-back's bodyLimit.
app.use(express.json({ limit: "1mb" }));

// Health check — Cloud Run probes this; never auth-gated.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Every other route requires a verified platform call.
app.use(verifyPlatform);

// Reserved /_platform namespace mounted before the merchant admin router
// so a generated route at `/admin/_platform/anything` can never shadow it.
app.use("/admin/_platform", platformAdminRouter);
app.use("/admin", adminRouter);
app.use("/webhook", webhookRouter);

// 404 — anything that fell through.
const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "not_found" });
};
app.use(notFound);

// Error trap — Express needs all four args to detect the error handler.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error("[handler] unhandled", err);
  res.status(500).json({ error: "internal_error" });
};
app.use(errorHandler);

const server = app.listen(PORT, HOST, () => {
  console.log(`[handler] listening on ${HOST}:${PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[handler] ${signal} received, shutting down`);
  server.close();
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
