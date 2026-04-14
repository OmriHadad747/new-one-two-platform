import { describe, expect, it } from "vitest";
import { ErrorCode, errorResponse } from "./error-response.js";

describe("errorResponse", () => {
  it("returns a minimal envelope with error + code", () => {
    const body = errorResponse(ErrorCode.NotFound, "App not found");
    expect(body).toEqual({ error: "App not found", code: "not_found" });
  });

  it("includes details when provided", () => {
    const body = errorResponse(ErrorCode.InvalidRequest, "Body failed validation", {
      path: "prompt",
      reason: "required",
    });
    expect(body).toEqual({
      error: "Body failed validation",
      code: "invalid_request",
      details: { path: "prompt", reason: "required" },
    });
  });

  it("omits details when undefined (not serialised as 'details: undefined')", () => {
    const body = errorResponse(ErrorCode.Unauthorized, "Token invalid");
    expect(Object.keys(body)).toEqual(["error", "code"]);
  });

  it("keeps `error` as a top-level string for back-compat with existing clients", () => {
    // Existing platform-front and platform-shopify-admin code reads
    // `res.error` as a string. Any future change to nest under `error:{...}`
    // would break them without coordinated updates.
    const body = errorResponse(ErrorCode.Conflict, "App limit reached");
    expect(typeof body.error).toBe("string");
  });
});

describe("ErrorCode catalogue", () => {
  it("values are stable snake_case slugs", () => {
    // Frontends / log consumers grep for these verbatim. Changing a value is
    // a breaking change; adding a new one is additive.
    expect(ErrorCode.InvalidRequest).toBe("invalid_request");
    expect(ErrorCode.Unauthorized).toBe("unauthorized");
    expect(ErrorCode.Forbidden).toBe("forbidden");
    expect(ErrorCode.NotFound).toBe("not_found");
    expect(ErrorCode.Conflict).toBe("conflict");
    expect(ErrorCode.UpstreamFailure).toBe("upstream_failure");
    expect(ErrorCode.Internal).toBe("internal_error");
  });
});
