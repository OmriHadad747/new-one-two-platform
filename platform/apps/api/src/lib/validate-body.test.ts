import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseBody, parseQuery } from "./validate-body.js";

// Minimal fake Fastify reply that records what was sent.
function fakeReply() {
  const state: { status?: number; body?: unknown } = {};
  const reply = {
    status(n: number) {
      state.status = n;
      return reply;
    },
    send(payload: unknown) {
      state.body = payload;
      return reply;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { reply: reply as any, state };
}

const UserSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().nonnegative(),
});

describe("parseBody", () => {
  it("returns the parsed body when the shape matches", () => {
    const { reply, state } = fakeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = { body: { name: "Omri", age: 30 } } as any;
    const out = parseBody(UserSchema, req, reply);
    expect(out).toEqual({ name: "Omri", age: 30 });
    expect(state.status).toBeUndefined(); // no reply sent
    expect(state.body).toBeUndefined();
  });

  it("replies 400 with the unified error envelope on a bad body", () => {
    const { reply, state } = fakeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = { body: { name: "", age: -1 } } as any;
    const out = parseBody(UserSchema, req, reply);
    expect(out).toBeNull();
    expect(state.status).toBe(400);
    expect(state.body).toMatchObject({
      error: "Request body failed validation",
      code: "invalid_request",
    });
    // details.issues should enumerate both failures with dotted paths.
    const issues = (state.body as { details: { issues: unknown[] } }).details.issues;
    expect(issues).toHaveLength(2);
    const paths = (issues as Array<{ path: string }>).map((i) => i.path).sort();
    expect(paths).toEqual(["age", "name"]);
  });

  it("replies 400 when the body is an unexpected type entirely", () => {
    const { reply, state } = fakeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = { body: "not an object" } as any;
    const out = parseBody(UserSchema, req, reply);
    expect(out).toBeNull();
    expect(state.status).toBe(400);
  });

  it("represents root-level issues as <root>", () => {
    const { reply, state } = fakeReply();
    const NumSchema = z.number();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = { body: "not a number" } as any;
    parseBody(NumSchema, req, reply);
    const issues = (state.body as { details: { issues: Array<{ path: string }> } }).details.issues;
    expect(issues[0]!.path).toBe("<root>");
  });
});

describe("parseQuery", () => {
  it("validates request.query the same way parseBody validates request.body", () => {
    const { reply, state } = fakeReply();
    const Q = z.object({ page: z.coerce.number().int().min(1) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = { query: { page: "3" } } as any;
    const out = parseQuery(Q, req, reply);
    expect(out).toEqual({ page: 3 });
    expect(state.status).toBeUndefined();
  });

  it("replies 400 with a 'Query parameters failed validation' message", () => {
    const { reply, state } = fakeReply();
    const Q = z.object({ page: z.coerce.number().int().min(1) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = { query: { page: "abc" } } as any;
    const out = parseQuery(Q, req, reply);
    expect(out).toBeNull();
    expect(state.status).toBe(400);
    expect(state.body).toMatchObject({
      code: "invalid_request",
      error: "Query parameters failed validation",
    });
  });
});

describe("handler contract", () => {
  it("the caller's early-return on null is how we avoid double-send", () => {
    // This test documents the contract: on failure, parseBody has ALREADY
    // called reply.status().send(). The handler must return without calling
    // reply again. Enforced at call sites by the `if (!body) return;` pattern.
    const { reply, state } = fakeReply();
    const sendSpy = vi.spyOn(reply, "send");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = { body: {} } as any;
    parseBody(UserSchema, req, reply);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(state.status).toBe(400);
  });
});
