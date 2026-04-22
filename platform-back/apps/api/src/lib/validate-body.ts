/**
 * Zod-backed request validation helpers. Ported from
 * platform/apps/api/src/lib/validate-body.ts. See REFACTOR_GAPS §1 — the
 * /tenants/* router and any future route that wants uniform 400 responses
 * with per-issue detail uses these.
 *
 * Usage:
 *   const body = parseBody(MySchema, req, reply);
 *   if (!body) return;                  // 400 already sent, caller must
 *                                       // NOT continue — reply is done.
 *   // …use the narrowed `body`…
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
    path: issue.path.length > 0 ? issue.path.join(".") : "<root>",
    message: issue.message,
    code: issue.code,
  }));
}

export function parseBody<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  req: FastifyRequest,
  reply: FastifyReply,
): z.infer<TSchema> | null {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    void reply
      .status(400)
      .send(
        errorResponse(
          ErrorCode.InvalidRequest,
          "Request body failed validation",
          { issues: formatIssues(result.error) },
        ),
      );
    return null;
  }
  return result.data;
}

export function parseQuery<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  req: FastifyRequest,
  reply: FastifyReply,
): z.infer<TSchema> | null {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    void reply
      .status(400)
      .send(
        errorResponse(
          ErrorCode.InvalidRequest,
          "Query parameters failed validation",
          { issues: formatIssues(result.error) },
        ),
      );
    return null;
  }
  return result.data;
}
