import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import type { WebhookHandler } from "../src/routes/webhook-handlers.js";

const sqlMock = vi.fn();
vi.mock("../src/lib/db.js", () => ({ sql: sqlMock }));
vi.mock("../src/routes/webhook-handlers.js", () => ({ webhookHandlers: {} }));

const { webhookHandlers } = await import("../src/routes/webhook-handlers.js");
const { webhookRouter } = await import("../src/routes/webhook.js");

const app = express();
app.use(express.json());
app.use("/", webhookRouter);

const handlers = webhookHandlers as Record<string, WebhookHandler>;

beforeEach(() => {
  sqlMock.mockReset();
  for (const key of Object.keys(handlers)) delete handlers[key];
});

describe("webhookRouter", () => {
  it("returns 400 when webhook_id is missing", async () => {
    const res = await supertest(app).post("/orders/create").send({ payload: {} });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "missing_webhook_id" });
  });

  it("returns 200 duplicate:true on idempotency conflict", async () => {
    sqlMock.mockResolvedValueOnce([]);
    const res = await supertest(app)
      .post("/orders/create")
      .send({ webhook_id: "wh_1", payload: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, duplicate: true });
  });

  it("returns 200 ignored:true for unknown topic", async () => {
    sqlMock.mockResolvedValueOnce([{ webhook_id: "wh_1" }]);
    const res = await supertest(app)
      .post("/orders/create")
      .send({ webhook_id: "wh_1", payload: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ignored: true });
  });

  it("dispatches to registered handler and returns 200", async () => {
    sqlMock.mockResolvedValueOnce([{ webhook_id: "wh_1" }]);
    const handler = vi.fn().mockResolvedValue(undefined);
    handlers["orders/create"] = handler;

    const res = await supertest(app)
      .post("/orders/create")
      .send({ webhook_id: "wh_1", payload: { id: 42 } });

    expect(handler).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 500 when registered handler throws", async () => {
    sqlMock.mockResolvedValueOnce([{ webhook_id: "wh_1" }]);
    handlers["orders/create"] = async () => {
      throw new Error("oops");
    };

    const res = await supertest(app)
      .post("/orders/create")
      .send({ webhook_id: "wh_1", payload: {} });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "handler_failed" });
  });
});
