import { Router } from "express";
import { sql } from "../lib/db.js";

// /admin/_platform/* — reserved namespace. Only platform-back's own
// teardown / lifecycle calls land here. The leading underscore is a
// convention so generated admin routes can never collide.
//
// Per locked decision 10: uninstall calls /admin/_platform/purge; the
// handler drops its own schema. Idempotent so the cron sweeper can
// safely retry.

export const platformAdminRouter = Router();

const TENANT_SCHEMA = process.env["TENANT_SCHEMA"]!;

platformAdminRouter.post("/purge", async (_req, res) => {
  // DROP SCHEMA … CASCADE is the destructive end-of-life. We allow the
  // schema to be missing already (cron sweeper retries) — both arms
  // return 200 so the platform's purge call is unconditionally
  // idempotent.
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${TENANT_SCHEMA} CASCADE`);
  res.json({ ok: true, schema: TENANT_SCHEMA });
});
