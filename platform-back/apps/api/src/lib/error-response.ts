export interface ErrorBody {
  error: string;
  code: string;
  details?: unknown;
}

export function errorResponse(
  code: string,
  message: string,
  details?: unknown,
): ErrorBody {
  const body: ErrorBody = { error: message, code };
  if (details !== undefined) body.details = details;
  return body;
}

export const ErrorCode = {
  InvalidRequest: "invalid_request",
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  Conflict: "conflict",
  Internal: "internal_error",

  TokenMissing: "token_missing",
  TokenInvalid: "token_invalid",
  ShopMismatch: "shop_mismatch",

  BackendNotDeployed: "backend_not_deployed",
  BadGateway: "bad_gateway",
  UpstreamTimeout: "upstream_timeout",

  // Plan enforcement + integration preconditions.
  AppLimitReached: "app_limit_reached",
  PlanLimited: "plan_limited",
  ShopNotConnected: "shop_not_connected",

  HmacInvalid: "hmac_invalid",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
