import pino, { type Logger } from "pino";

const isDev = process.env["NODE_ENV"] === "development";
const level = process.env["LOG_LEVEL"] ?? (isDev ? "debug" : "info");

export const logger: Logger = pino({
  level,
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
        },
      }
    : {}),
});

export function createRequestLogger(ctx: { requestId: string }): Logger {
  return logger.child({ requestId: ctx.requestId });
}

export type { Logger } from "pino";
