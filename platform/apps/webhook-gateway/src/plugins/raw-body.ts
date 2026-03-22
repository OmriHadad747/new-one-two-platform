import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";

// Captures the raw request body before Fastify's JSON parser consumes the
// stream. Stores it on `request.rawBody` (Buffer) so routes that need the
// original bytes (e.g. HMAC signature validation) can read them.
//
// Must be registered before any route or content-type parser that reads the
// body — register it first in server.ts.

export const rawBodyPlugin = fp(async (app: FastifyInstance) => {
  app.addHook("preParsing", async (request, _reply, payload) => {
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
    }
    const raw = Buffer.concat(chunks);
    (request as any).rawBody = raw;
    // Return a new readable so Fastify's body parser still gets the bytes.
    return Readable.from(raw);
  });
});
