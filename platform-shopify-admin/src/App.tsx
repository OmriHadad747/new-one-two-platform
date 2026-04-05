import { AdminShell } from "./components/AdminShell.js";

/**
 * App Bridge v4 initializes automatically from the <meta name="shopify-api-key">
 * tag and the CDN script in index.html — no Provider component needed.
 *
 * Shopify injects `shop` and `host` as URL query params when loading the
 * embedded app inside the Admin iframe.
 */
export default function App() {
  const shop = new URLSearchParams(window.location.search).get("shop") ?? "";
  return <AdminShell shop={shop} />;
}
