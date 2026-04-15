/**
 * Zod-backed request body / params / query validation at API boundaries.
 *
 * Usage inside a route handler:
 *
 *   const body = parseBody(StartGenerationRequestSchema, req, reply);
 *   if (!body) return;  // 400 already sent with { error, code, details }
 *
 * On success, returns the parsed (and narrowed) value. On failure, sends a
 * 400 via the unified error envelope and returns null so the handler can
 * early-return without forgetting to stop processing.
 *
 * Why a helper instead of Fastify's native JSON-Schema validation: the rest
 * of the monorepo uses zod (pubsub-client/schemas.ts), route shapes are
 * easier to express in TS with zod, and we get exact issue paths for the
 * error envelope's `details` payload. Fastify's built-in Ajv validator would
 * have worked too — the decision is consistency with pubsub-client, not a
 * technical blocker.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { ErrorCode, errorResponse } from "./error-response.js";

interface ZodIssueDetail {
  path: string;
  message: string;
  code: string;
}

function formatIssues(error: z.ZodError): ZodIssueDetail[] {
  return error.issues.map((issue) => ({
    // Join the path into a dotted string: ["body", "prompt"] → "body.prompt"
    // Top-level issues have an empty path; represent as "<root>" so the
    // client sees something rather than an empty key.
    path: issue.path.length > 0 ? issue.path.join(".") : "<root>",
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Parse and validate the request body against a zod schema.
 *
 * Side effect on failure: sends `400 { error, code, details }` via `reply`
 * and returns null. Caller MUST early-return on null — the reply cannot be
 * sent twice, and Fastify will throw if the handler continues.
 */
export function parseBody<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  req: FastifyRequest,
  reply: FastifyReply
): z.infer<TSchema> | null {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    void reply.status(400).send(
      errorResponse(
        ErrorCode.InvalidRequest,
        "Request body failed validation",
        { issues: formatIssues(result.error) }
      )
    );
    return null;
  }
  return result.data;
}

/**
 * Same as parseBody but for `request.query`. Query strings come in as
 * `Record<string, string | string[] | undefined>`; the schema should mirror
 * that or use `z.coerce.*` for number/boolean-like params.
 */
export function parseQuery<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  req: FastifyRequest,
  reply: FastifyReply
): z.infer<TSchema> | null {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    void reply.status(400).send(
      errorResponse(
        ErrorCode.InvalidRequest,
        "Query parameters failed validation",
        { issues: formatIssues(result.error) }
      )
    );
    return null;
  }
  return result.data;
}
