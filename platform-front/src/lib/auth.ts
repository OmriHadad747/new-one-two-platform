/**
 * Platform authentication token management.
 *
 * After Shopify OAuth, the API redirects to the dashboard with a `token` query
 * parameter containing a signed JWT. This module extracts, stores, and provides
 * that token for subsequent API requests.
 *
 * Storage: sessionStorage (cleared when the tab closes — merchant must re-auth
 * via Shopify to get a new token, which is the correct security posture).
 */

const TOKEN_KEY = "platform_auth_token";

/** Extract token from URL search params and persist it. Call on app init. */
export function captureTokenFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    // Remove token from URL to avoid leaking it in logs / copy-paste
    params.delete("token");
    const cleaned =
      params.toString()
        ? `${window.location.pathname}?${params.toString()}`
        : window.location.pathname;
    window.history.replaceState({}, "", cleaned);
  }
}

/** Get the current auth token, or null if not authenticated. */
export function getAuthToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

/** Clear the stored token (logout). */
export function clearAuthToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}
