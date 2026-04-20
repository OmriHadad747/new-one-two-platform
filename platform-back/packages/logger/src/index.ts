import pino, { type Logger } from "pino";

const isProd = process.env["NODE_ENV"] === "production";
const level = process.env["LOG_LEVEL"] ?? (isProd ? "info" : "debug");

export const logger: Logger = pino({
  level,
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
        },
      }),
});

export function createRequestLogger(ctx: { requestId: string }): Logger {
  return logger.child({ requestId: ctx.requestId });
}

export type { Logger } from "pino";
