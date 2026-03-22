import type { AppModule } from "@new-one-two/types";

const HANDLER_PATH = process.env["HANDLER_PATH"] ?? "/app/handler.js";

let cached: AppModule | null = null;

export function loadModule(): AppModule {
  if (cached) return cached;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(HANDLER_PATH) as unknown;

  if (
    typeof mod !== "object" ||
    mod === null ||
    typeof (mod as Record<string, unknown>)["handler"] !== "function" ||
    !Array.isArray((mod as Record<string, unknown>)["webhookTopics"])
  ) {
    throw new Error(
      `Handler module at ${HANDLER_PATH} must export { webhookTopics, cronSchedule, handler }`
    );
  }

  cached = mod as AppModule;
  return cached;
}
