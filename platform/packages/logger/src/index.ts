import pino from "pino";

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: {
    service: process.env["SERVICE_NAME"] ?? "new-one-two",
    env: process.env["NODE_ENV"] ?? "development",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(process.env["NODE_ENV"] !== "production" && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss" },
    },
  }),
});

// Child logger factory — attach per-request context
export function createRequestLogger(ctx: {
  tenantId?: string;
  appId?: string;
  requestId?: string;
  topic?: string;
}) {
  return logger.child(ctx);
}

export type Logger = pino.Logger;
