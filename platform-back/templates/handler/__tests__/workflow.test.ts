import { describe, it, expect, vi, beforeEach } from "vitest";

// postgres.js' `sql` exposes call-shapes:
//   - sql`select ...`   → tagged-template (executes when awaited)
//   - sql(name)         → identifier helper (returns a fragment object)
// We mock both. Identifier helper returns a sentinel; tagged-template
// returns whatever the test queued (or [] by default).
//
// Fragment-style tagged-template calls (`sql\`\`` and similar with no
// SQL verb) consume a slot from the same queue as query calls — tests
// queue empty arrays for those. The `lastQueryCall` helper finds the
// last invocation that contains a SQL verb so assertions target the
// main statement, not the inline fragments.
const sqlMock = vi.fn();
const identMock = vi.fn((name: string) => ({ __ident: name }));

const sqlCallable = vi.fn((...args: unknown[]) => {
  if (Array.isArray(args[0]) && (args[0] as { raw?: unknown }).raw) {
    return sqlMock(...(args as [TemplateStringsArray, ...unknown[]]));
  }
  return identMock(args[0] as string);
}) as unknown as typeof sqlMock;

vi.mock("../src/lib/db.js", () => ({ sql: sqlCallable }));

const { workflow, WorkflowError } = await import("../src/lib/workflow.js");

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
  identMock.mockClear();
  (sqlCallable as unknown as ReturnType<typeof vi.fn>).mockClear();
});

const QUERY_VERB_RE = /\b(UPDATE|SELECT|INSERT|DELETE)\b/i;

function lastQueryCall(): { strings: string[]; values: unknown[] } {
  const calls = sqlMock.mock.calls as Array<[string[], ...unknown[]]>;
  for (let i = calls.length - 1; i >= 0; i--) {
    const callI = calls[i];
    if (!callI) continue;
    const [strings, ...values] = callI;
    if (QUERY_VERB_RE.test(strings.join(" "))) return { strings, values };
  }
  throw new Error("no query call observed");
}

/**
 * Queue a result for the main query call. Fragment-style sql`` calls
 * before it get the default [] from `mockResolvedValue`.
 *
 * postgres.js evaluates ${expr} interpolations BEFORE the outer tagged
 * template, so any inline `sql\`...\`` fragments fire first. We let
 * them consume default [] values, then queue the main call's result.
 */
function queueMainResult(value: unknown, fragmentsBefore: number): void {
  for (let i = 0; i < fragmentsBefore; i++) sqlMock.mockResolvedValueOnce([]);
  sqlMock.mockResolvedValueOnce(value);
}

// ────────────────────────────────────────────────────────────────────
// claim
// ────────────────────────────────────────────────────────────────────

describe("workflow.claim — happy path", () => {
  it("returns the claimed row when UPDATE affects one row", async () => {
    const row = { id: "abc", status: "running" };
    // claim has 2 inline fragments: setStarted, extra.
    queueMainResult([row], 2);
    const result = await workflow.claim("rule_runs", "abc", { from: "pending" });
    expect(result).toEqual(row);
  });

  it("issues UPDATE … RETURNING * with the right binds", async () => {
    queueMainResult([{ id: "1" }], 2);
    await workflow.claim("rule_runs", "1", { from: "pending" });
    const { strings, values } = lastQueryCall();
    const composed = strings.join("?");
    expect(composed).toMatch(/UPDATE/);
    expect(composed).toMatch(/RETURNING \*/);
    expect(values).toContain("running");
    expect(values).toContain("1");
    expect(values).toContainEqual(["pending"]);
  });
});

describe("workflow.claim — race / wrong state", () => {
  it("returns null when UPDATE matches zero rows", async () => {
    queueMainResult([], 2);
    const result = await workflow.claim("rule_runs", "abc", { from: "pending" });
    expect(result).toBeNull();
  });
});

describe("workflow.claim — array `from`", () => {
  it("passes the array as a bind value (status = ANY($))", async () => {
    queueMainResult([], 2);
    await workflow.claim("rule_runs", "1", { from: ["pending", "paused"] });
    const { values } = lastQueryCall();
    expect(values).toContainEqual(["pending", "paused"]);
  });

  it("rejects empty `from` array", async () => {
    await expect(workflow.claim("rule_runs", "1", { from: [] })).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });
});

describe("workflow.claim — column overrides", () => {
  it("uses overridden statusColumn / startedAtColumn", async () => {
    queueMainResult([], 2);
    await workflow.claim("approvals", "1", {
      from: "draft",
      to: "submitted",
      statusColumn: "phase",
      startedAtColumn: "submitted_at",
    });
    expect(identMock).toHaveBeenCalledWith("phase");
    expect(identMock).toHaveBeenCalledWith("submitted_at");
  });

  it("skips started_at write when startedAtColumn is null", async () => {
    queueMainResult([], 2);
    await workflow.claim("rule_runs", "1", { from: "pending", startedAtColumn: null });
    expect(identMock).not.toHaveBeenCalledWith("started_at");
  });
});

describe("workflow.claim — identifier validation", () => {
  it("rejects unsafe table name", async () => {
    await expect(
      workflow.claim("rule_runs; DROP TABLE x", "1", { from: "pending" }),
    ).rejects.toThrow(/safe SQL identifier/);
  });

  it("rejects unsafe statusColumn", async () => {
    await expect(
      workflow.claim("rule_runs", "1", { from: "pending", statusColumn: "x; --" }),
    ).rejects.toThrow(/safe SQL identifier/);
  });
});

// ────────────────────────────────────────────────────────────────────
// complete
// ────────────────────────────────────────────────────────────────────

describe("workflow.complete", () => {
  it("emits UPDATE … SET status, finished_at WHERE id", async () => {
    queueMainResult([], 1); // 1 fragment: setFinished
    await workflow.complete("rule_runs", "1");
    const { strings, values } = lastQueryCall();
    expect(strings.join("?")).toMatch(/UPDATE/);
    expect(values).toContain("completed");
    expect(values).toContain("1");
  });

  it("skips finished_at when finishedAtColumn is null", async () => {
    queueMainResult([], 1);
    await workflow.complete("rule_runs", "1", { finishedAtColumn: null });
    expect(identMock).not.toHaveBeenCalledWith("finished_at");
  });

  it("uses overridden `to` for non-canonical terminals", async () => {
    queueMainResult([], 1);
    await workflow.complete("approvals", "1", { to: "approved" });
    const { values } = lastQueryCall();
    expect(values).toContain("approved");
  });
});

// ────────────────────────────────────────────────────────────────────
// fail
// ────────────────────────────────────────────────────────────────────

describe("workflow.fail", () => {
  it("emits UPDATE … SET status, finished_at, failure_reason WHERE id", async () => {
    queueMainResult([], 2); // 2 fragments: setFinished, setReason
    await workflow.fail("rule_runs", "1", "boom");
    const { strings, values } = lastQueryCall();
    expect(strings.join("?")).toMatch(/UPDATE/);
    expect(values).toContain("failed");
    expect(values).toContain("1");
    // "boom" rides on the setReason fragment, not the main UPDATE.
    const calls = sqlMock.mock.calls as Array<[string[], ...unknown[]]>;
    const allValues = calls.flatMap(([, ...v]) => v);
    expect(allValues).toContain("boom");
  });

  it("truncates failure_reason to 4000 chars", async () => {
    queueMainResult([], 2);
    const big = "x".repeat(5_000);
    await workflow.fail("rule_runs", "1", big);
    // Truncated reason is bound to the setReason fragment, not the
    // main UPDATE — inspect the fragment call.
    const calls = sqlMock.mock.calls as Array<[string[], ...unknown[]]>;
    const fragmentValue = calls
      .flatMap(([, ...vals]) => vals)
      .find((v) => typeof v === "string" && v.startsWith("xxxx")) as string;
    expect(fragmentValue.length).toBe(4000);
  });

  it("skips failure_reason write when failureReasonColumn is null", async () => {
    queueMainResult([], 1); // 1 fragment: setFinished only
    await workflow.fail("rule_runs", "1", "boom", { failureReasonColumn: null });
    expect(identMock).not.toHaveBeenCalledWith("failure_reason");
  });
});

// ────────────────────────────────────────────────────────────────────
// attempt
// ────────────────────────────────────────────────────────────────────

describe("workflow.attempt — success", () => {
  it("claims, runs callback, marks complete, returns { row, value }", async () => {
    // claim: 2 fragments + main; complete: 1 fragment + main.
    queueMainResult([{ id: "1", status: "running" }], 2);
    queueMainResult([], 1);

    const cb = vi.fn(async (row: { id: string }) => `processed:${row.id}`);
    const result = await workflow.attempt("rule_runs", "1", { from: "pending" }, cb);

    expect(cb).toHaveBeenCalledOnce();
    expect(result).toEqual({ row: { id: "1", status: "running" }, value: "processed:1" });
  });
});

describe("workflow.attempt — claim returns null", () => {
  it("does NOT invoke the callback and returns null", async () => {
    queueMainResult([], 2); // claim returns no row
    const cb = vi.fn();
    const result = await workflow.attempt("rule_runs", "1", { from: "pending" }, cb);
    expect(cb).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe("workflow.attempt — callback throws", () => {
  it("persists fail with err.message and re-throws", async () => {
    queueMainResult([{ id: "1", status: "running" }], 2); // claim
    queueMainResult([], 2); // fail (2 fragments: setFinished, setReason)

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      workflow.attempt("rule_runs", "1", { from: "pending" }, async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow(/kaboom/);

    const { strings } = lastQueryCall();
    expect(strings.join("?")).toMatch(/UPDATE/);
    // Reason was bound into the setReason fragment.
    const calls = sqlMock.mock.calls as Array<[string[], ...unknown[]]>;
    const allValues = calls.flatMap(([, ...v]) => v);
    expect(allValues).toContain("failed");
    expect(allValues).toContain("kaboom");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("re-throws the original error even if fail() persistence itself fails", async () => {
    queueMainResult([{ id: "1", status: "running" }], 2); // claim
    // fail's 2 fragments succeed, then the main UPDATE rejects.
    sqlMock.mockResolvedValueOnce([]); // fragment 1
    sqlMock.mockResolvedValueOnce([]); // fragment 2
    sqlMock.mockRejectedValueOnce(new Error("db down")); // main UPDATE

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      workflow.attempt("rule_runs", "1", { from: "pending" }, async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow(/kaboom/);
    expect(errSpy).toHaveBeenCalledTimes(2); // attempt_failed + fail_persistence_error
    errSpy.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────────────
// sweepStale
// ────────────────────────────────────────────────────────────────────

describe("workflow.sweepStale", () => {
  it("flips rows past the TTL and returns ids", async () => {
    queueMainResult([{ id: "a" }, { id: "b" }, { id: "c" }], 1); // 1 fragment: setReason
    const result = await workflow.sweepStale("rule_runs", { ttlMinutes: 30 });
    expect(result).toEqual({ count: 3, ids: ["a", "b", "c"] });
  });

  it("emits UPDATE … WHERE running AND started_at < now() - interval RETURNING id", async () => {
    queueMainResult([], 1);
    await workflow.sweepStale("rule_runs", { ttlMinutes: 30 });
    const { strings, values } = lastQueryCall();
    const composed = strings.join("?");
    expect(composed).toMatch(/UPDATE/);
    expect(composed).toMatch(/RETURNING id/);
    expect(values).toContain("running");
    expect(values).toContain("failed");
    expect(values).toContain("30 minutes");
  });

  it("returns count=0 when no rows are stale", async () => {
    queueMainResult([], 1);
    const result = await workflow.sweepStale("rule_runs");
    expect(result).toEqual({ count: 0, ids: [] });
  });

  it("rejects non-positive ttlMinutes", async () => {
    await expect(workflow.sweepStale("rule_runs", { ttlMinutes: 0 })).rejects.toThrow(
      /positive finite number/,
    );
    await expect(workflow.sweepStale("rule_runs", { ttlMinutes: -5 })).rejects.toThrow(
      /positive finite number/,
    );
    await expect(workflow.sweepStale("rule_runs", { ttlMinutes: NaN })).rejects.toThrow(
      /positive finite number/,
    );
  });

  it("uses overridden runningState / timedOutState for non-canonical lifecycles", async () => {
    queueMainResult([], 1);
    await workflow.sweepStale("approvals", {
      runningState: "submitted",
      timedOutState: "expired",
      failureReasonValue: "review_window_closed",
    });
    const calls = sqlMock.mock.calls as Array<[string[], ...unknown[]]>;
    const allValues = calls.flatMap(([, ...v]) => v);
    expect(allValues).toContain("submitted");
    expect(allValues).toContain("expired");
    expect(allValues).toContain("review_window_closed");
  });

  it("skips failure_reason when failureReasonColumn is null", async () => {
    queueMainResult([], 0); // no fragments
    await workflow.sweepStale("rule_runs", { failureReasonColumn: null });
    const { strings } = lastQueryCall();
    expect(strings.join("?")).not.toMatch(/failure_reason/);
  });
});
