/**
 * Metadata returned by GET /admin/apps?shop=…
 * Only what the shell needs — no JS code, no sensitive fields.
 */
export interface AdminApp {
  id: string;
  name: string;
  slug: string;
}

/**
 * The bridge object passed to every adminUiModule.
 * Contract: module exports `mount(container: HTMLElement, bridge: AdminBridge) => void`
 * and optionally `unmount(container: HTMLElement) => void`.
 */
export interface AdminBridge {
  context: {
    shop: string;
    appId: string;
  };
  /**
   * Call the app's admin handler.
   *
   * path — must start with "/" (e.g. "/fetch-orders").
   * args — JSON-serialisable payload (object, or omit for empty calls).
   *
   * The HTTP method is selected automatically per path from the
   * `__PLATFORM_CATALOG__` manifest the served bundle ships with:
   *   - GET routes encode `args` as a query string.
   *   - POST routes encode `args` as a JSON body.
   * Defaults to POST when the path is not in the manifest.
   *
   * The architect's adminApiCatalog is the source of truth for method
   * per path. Codegen never needs to specify the method explicitly.
   */
  call: (path: string, args?: unknown) => Promise<unknown>;
  /**
   * Show a toast notification in Shopify Admin.
   * variant defaults to "success".
   */
  notify: (message: string, variant?: "success" | "error") => void;
}

/**
 * Shape expected from a dynamically-loaded adminUiModule ES module.
 */
export interface AdminUiModule {
  mount: (container: HTMLElement, bridge: AdminBridge) => void;
  unmount?: (container: HTMLElement) => void;
}
