import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";
import { closeDb } from "./lib/db.js";
import { verifyPlatform } from "./middleware/verify-platform.js";
import { adminRouter } from "./routes/admin.js";
import { webhookRouter } from "./routes/webhook.js";
import { widgetRouter } from "./routes/widget.js";
import {
  startCronRunner,
  type CronRunnerHandle,
  type JobsMap,
} from "./lib/cron-runner.js";

const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";

const app = express();
app.disable("x-powered-by");

// JSON only — handlers don't accept multipart or url-encoded payloads from
// the platform. 1 MiB cap mirrors platform-back's bodyLimit.
app.use(express.json({ limit: "1mb" }));

// Per-request timeout — self-eject before Cloud Run's hard 30s cap so
// the handler returns a clean 504 rather than a mid-stream disconnect.
// Mirrors the 25s budget platform-back uses when forwarding to us.
const REQUEST_TIMEOUT_MS = 25_000;
app.use((_req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: "handler_timeout" });
    }
  }, REQUEST_TIMEOUT_MS);
  res.once("finish", () => clearTimeout(timer));
  res.once("close", () => clearTimeout(timer));
  next();
});

// Health check — Cloud Run probes this; never auth-gated.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Every other route requires a verified platform call.
app.use(verifyPlatform);

app.use("/admin", adminRouter);
app.use("/webhook", webhookRouter);
app.use("/widget", widgetRouter);

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

// Cron runner — only booted when the deployer set ENABLE_CRON_RUNNER=true
// (happens when the architect declared `cronSchedule` at generation time).
// src/routes/cron.ts is generator-authored; import it dynamically so apps
// without cron don't need the file to exist.
let cronHandle: CronRunnerHandle | null = null;
if (process.env["ENABLE_CRON_RUNNER"] === "true") {
  void (async () => {
    try {
      const mod = (await import("./routes/cron.js")) as { jobs?: JobsMap };
      if (!mod.jobs || typeof mod.jobs !== "object") {
        console.error(
          "[handler] ENABLE_CRON_RUNNER=true but ./routes/cron.js did not export a jobs map; cron disabled",
        );
        return;
      }
      cronHandle = startCronRunner(mod.jobs);
    } catch (err) {
      console.error(
        { err: String(err) },
        "[handler] failed to load ./routes/cron.js; cron disabled",
      );
    }
  })();
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[handler] ${signal} received, shutting down`);
  server.close();
  if (cronHandle) {
    await cronHandle.stop().catch(() => {
      // Best-effort — drainage deadline is internal to the runner.
    });
  }
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
