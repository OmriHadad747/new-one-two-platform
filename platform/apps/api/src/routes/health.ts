import type { FastifyPluginAsync } from "fastify";

export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    await reply.status(200).send({ status: "ok", service: "api" });
  });
};
