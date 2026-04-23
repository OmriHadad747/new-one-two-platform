import { GoogleAuth } from "google-auth-library";

// Outbound auth to platform-back. We mint a Google-signed OIDC ID token
// using this handler's Cloud Run service account; platform-back's
// `/services/*` routes verify the token and derive (tenantId, appId)
// from the SA email — never from request body.
//
// Pattern shown long-form here so the generator can copy it verbatim
// into routes that call other /services/* endpoints. There is *no*
// platform SDK to learn — just `auth.getIdTokenClient(audience)`.

const PLATFORM_URL = process.env["PLATFORM_URL"];
if (!PLATFORM_URL) throw new Error("FATAL: PLATFORM_URL is not set");

const SKIP_AUTH = process.env["NODE_ENV"] === "development";

const auth = SKIP_AUTH ? null : new GoogleAuth();
let cachedAuthHeader: Promise<string> | null = null;

async function getAuthHeader(): Promise<string | null> {
  if (SKIP_AUTH) return null;
  if (cachedAuthHeader === null) {
    cachedAuthHeader = (async () => {
      const client = await auth!.getIdTokenClient(PLATFORM_URL!);
      const headers = await client.getRequestHeaders(PLATFORM_URL!);
      const v = headers["Authorization"] ?? headers["authorization"];
      if (typeof v !== "string") {
        cachedAuthHeader = null;
        throw new Error("google-auth-library returned no Authorization header");
      }
      return v;
    })().catch((err) => {
      cachedAuthHeader = null;
      throw err;
    });
  }
  return cachedAuthHeader;
}

export interface PlatformCallOptions {
  path: string; // e.g. "/services/email/send"
  body: unknown;
  signal?: AbortSignal;
}

export async function callPlatformService<T>(
  opts: PlatformCallOptions,
): Promise<{ status: number; body: T }> {
  const url = `${PLATFORM_URL}${opts.path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const authHeader = await getAuthHeader();
  if (authHeader) headers["Authorization"] = authHeader;

  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body),
  };
  if (opts.signal) init.signal = opts.signal;

  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: T;
  try {
    parsed = (text.length > 0 ? JSON.parse(text) : null) as T;
  } catch {
    parsed = text as unknown as T;
  }
  return { status: res.status, body: parsed };
}
