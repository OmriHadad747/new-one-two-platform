import type { FastifyInstance } from "fastify";
import { sql } from "@new-one-two/db";
import { webhookQueue } from "../queue/webhook-queue.js";

export async function healthRoutes(app: FastifyInstance) {
  // Liveness — always 200 if the process is alive
  app.get("/live", async (_, reply) => {
    return reply.code(200).send({ status: "ok" });
  });

  // Readiness — checks DB + Redis connectivity
  app.get("/ready", async (_, reply) => {
    const checks: Record<string, "ok" | "fail"> = {};

    // DB check
    try {
      await sql`SELECT 1`;
      checks["db"] = "ok";
    } catch {
      checks["db"] = "fail";
    }

    // Redis / BullMQ check
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
