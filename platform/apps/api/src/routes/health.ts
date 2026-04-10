import type { FastifyPluginAsync } from "fastify";
import { sql } from "@new-one-two/db";

export const healthRoute: FastifyPluginAsync = async (app) => {
  // Liveness — always 200 if the process is alive
  app.get("/", async (_req, reply) => {
    await reply.status(200).send({ status: "ok", service: "api" });
  });

  // Readiness — checks DB connectivity
  app.get("/ready", async (_req, reply) => {
    const checks: Record<string, "ok" | "fail"> = {};

    try {
      await sql`SELECT 1`;
      checks["db"] = "ok";
    } catch {
      checks["db"] = "fail";
    }

    const allOk = Object.values(checks).every((v) => v === "ok");
    return reply
      .code(allOk ? 200 : 503)
      .send({ status: allOk ? "ready" : "degraded", checks });
  });
};
