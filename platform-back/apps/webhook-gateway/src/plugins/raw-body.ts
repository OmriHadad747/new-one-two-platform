import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";

export const rawBodyPlugin = fp(async (app: FastifyInstance) => {
  app.addHook("preParsing", async (request, _reply, payload) => {
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
    }
    const raw = Buffer.concat(chunks);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (request as any).rawBody = raw;
    return Readable.from(raw);
  });
});
