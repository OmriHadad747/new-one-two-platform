/**
 * Error envelope for harness-runtime responses — intentionally mirrors the
 * platform API's `apps/api/src/lib/error-response.ts` shape so dashboards
 * and log consumers can filter on a single `code` convention across all
 * services.
 *
 * harness-runtime is esbuild-bundled into a single CJS file per tenant
 * container, so we keep it dep-free and inline the helper rather than
 * importing from the api package (which would flip the dependency arrow
 * the wrong way and bloat the bundle with api routes).
 *
 * When the API extends its ErrorCode catalogue, add the matching entries
 * here by hand — drift is the point of the duplication. Only the codes
 * the harness actually emits are listed below.
 */
import type { ZodError } from "zod";

export interface ErrorBody {
  error: string;
  code: string;
  details?: unknown;
}

export const ErrorCode = {
  InvalidRequest: "invalid_request",
  Internal: "internal_error",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export function errorResponse(
  code: string,
  message: string,
  details?: unknown
): ErrorBody {
  const body: ErrorBody = { error: message, code };
  if (details !== undefined) body.details = details;
  return body;
}

/**
 * Flattens a ZodError into the same `{ path, message, code }[]` shape the
 * api's `parseBody` produces (`apps/api/src/lib/validate-body.ts`). Keeping
 * the shape identical means a merchant handler that bubbles a 400 from the
 * harness to the browser looks the same as a 400 from the api.
 */
export function formatZodIssues(
  err: ZodError
): Array<{ path: string; message: string; code: string }> {
  return err.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "<root>",
    message: issue.message,
    code: issue.code,
  }));
}
