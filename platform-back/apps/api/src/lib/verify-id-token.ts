import { createRemoteJWKSet, jwtVerify } from "jose";

// Verifies a Google-signed OIDC ID token from the inbound Authorization
// header on /services/* calls. Returns the verified `email` claim — that
// claim is what `apps WHERE handler_sa_email = ?` is keyed on.
//
// SKIP_AUTH bypasses verification in local dev (no Cloud Run, no metadata
// server). The caller email is "" which matches apps.handler_sa_email = ""
// written by the local deployer (SA provisioning is skipped locally).

const SKIP_AUTH = process.env["NODE_ENV"] === "development";
const EXPECTED_AUDIENCE = process.env["EXPECTED_AUDIENCE"] ?? "";

if (!SKIP_AUTH && !EXPECTED_AUDIENCE) {
  throw new Error("FATAL: EXPECTED_AUDIENCE must be set in production");
}

const GOOGLE_JWKS = SKIP_AUTH
  ? null
  : createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export interface VerifiedCaller {
  /** SA email of the calling handler (e.g. h-acmestore-1@project.iam.gserviceaccount.com). */
  email: string;
}

export type VerifyResult =
  | { ok: true; caller: VerifiedCaller }
  | { ok: false; reason: "missing_token" | "invalid_token" | "untrusted_caller" };

export async function verifyCallerIdToken(
  authorizationHeader: string | undefined,
): Promise<VerifyResult> {
  if (SKIP_AUTH) {
    return { ok: true, caller: { email: "" } };
  }

  if (!authorizationHeader?.startsWith("Bearer ")) {
    return { ok: false, reason: "missing_token" };
  }
  const token = authorizationHeader.slice(7);

  try {
    const { payload } = await jwtVerify(token, GOOGLE_JWKS!, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: EXPECTED_AUDIENCE,
    });

    if (payload["email_verified"] !== true) {
      return { ok: false, reason: "untrusted_caller" };
    }
    const email = payload["email"];
    if (typeof email !== "string" || email.length === 0) {
      return { ok: false, reason: "untrusted_caller" };
    }

    return { ok: true, caller: { email } };
  } catch {
    return { ok: false, reason: "invalid_token" };
  }
}
