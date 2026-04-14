/**
 * Unified error-response envelope for the platform API.
 *
 * Historical state: different routes returned different shapes —
 * `{ error: "msg" }`, `{ error: "...", message: "..." }`,
 * `{ error, code, upgradeHint }`, sometimes raw strings — so frontends had
 * to string-match free-form messages to branch behaviour and ops couldn't
 * filter logs by a stable key.
 *
 * All new error responses use this helper. The shape is:
 *
 *   {
 *     "error": "human message",   // back-compat: existing clients read this
 *     "code":  "slug",            // new: machine-readable branch key
 *     "details": { ... }           // new, optional: structured context (e.g. zod issues)
 *   }
 *
 * `error` stays as a top-level string so existing clients that only read
 * `res.error` keep working — this is an additive change, not a breaking
 * rename. `code` is intentionally a snake-case slug so `switch (err.code)`
 * in frontends is grep-friendly.
 */
export interface ErrorBody {
  error: string;
  code: string;
  details?: unknown;
}

export function errorResponse(
  code: string,
  message: string,
  details?: unknown
): ErrorBody {
  const body: ErrorBody = { error: message, code };
  if (details !== undefined) body.details = details;
  return body;
}

// ─── Canonical error codes ────────────────────────────────────────────────────
//
// Centralised so a grep for `ErrorCode.` finds every caller, and so a typo
// like "invalid_requst" can never accidentally create a phantom branch. Add
// new codes here; don't inline string literals at call sites.

export const ErrorCode = {
  InvalidRequest: "invalid_request",
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  Conflict: "conflict",
  UpstreamFailure: "upstream_failure",
  Internal: "internal_error",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
