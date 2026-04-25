import type { FastifyInstance } from "fastify";
import { sql } from "@platform-back/db";
import { webhookQueue } from "../queue/webhook-queue.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/live", async (_, reply) => reply.code(200).send({ status: "ok" }));

  app.get("/ready", async (_, reply) => {
    const checks: Record<string, "ok" | "fail"> = {};
    try {
      await sql`SELECT 1`;
      checks["db"] = "ok";
    } catch {
      checks["db"] = "fail";
    }
    try {
      await webhookQueue.getJobCounts();
      checks["redis"] = "ok";
    } catch {
      checks["redis"] = "fail";
    }
    const allOk = Object.values(checks).every((v) => v === "ok");
    return reply.code(allOk ? 200 : 503).send({ status: allOk ? "ready" : "degraded", checks });
  });
}
