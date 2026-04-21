import type { Request } from "express";

export type WebhookHandler = (payload: unknown, req: Request) => Promise<void>;

// Generator REPLACES this file. The stub keeps the build green for handlers
// that declare no webhook topics.
export const webhookHandlers: Record<string, WebhookHandler> = {};
