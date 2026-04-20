import postgres from "postgres";
import { logger } from "@platform-back/logger";

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  throw new Error("FATAL: DATABASE_URL is not set");
}

// One pooled client per process. `postgres` opens lazily on first query.
// Cloud Run instances are short-lived; small pool keeps Postgres connection
// count bounded as the service scales horizontally.
export const sql = postgres(DATABASE_URL, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
  onnotice: () => {},
});

export async function closeDb(): Promise<void> {
  try {
    await sql.end({ timeout: 5 });
  } catch (err) {
    logger.warn({ err }, "Error closing Postgres pool");
  }
}
