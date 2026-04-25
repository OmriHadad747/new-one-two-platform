import { createHmac, timingSafeEqual } from "node:crypto";

// Token format: base64url(`${tenantId}.${emailLower}`).`${hmac}`
// HMAC over the base64-encoded payload with EMAIL_UNSUBSCRIBE_SECRET.
// Tokens never expire — a 6-month-old email's unsubscribe link still
// works. Rotation is intentionally deferred (rotating breaks every
// in-flight email link).

const UNSUBSCRIBE_SECRET = process.env["EMAIL_UNSUBSCRIBE_SECRET"] ?? "dev-secret-change-me";

if (process.env["NODE_ENV"] !== "development" && UNSUBSCRIBE_SECRET === "dev-secret-change-me") {
  throw new Error("FATAL: EMAIL_UNSUBSCRIBE_SECRET must be set to a real secret outside local dev");
}

export function signUnsubscribeToken(tenantId: string, email: string): string {
  const payload = `${tenantId}.${email.toLowerCase()}`;
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const hmac = createHmac("sha256", UNSUBSCRIBE_SECRET).update(payloadB64).digest("base64url");
  return `${payloadB64}.${hmac}`;
}

export function verifyUnsubscribeToken(token: string): { tenantId: string; email: string } | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts as [string, string];

  const expected = createHmac("sha256", UNSUBSCRIBE_SECRET).update(payloadB64).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  try {
    const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
    const dotIdx = payload.indexOf(".");
    if (dotIdx <= 0) return null;
    const tenantId = payload.slice(0, dotIdx);
    const email = payload.slice(dotIdx + 1);
    if (!tenantId || !email) return null;
    return { tenantId, email };
  } catch {
    return null;
  }
}
