/**
 * Metadata returned by GET /admin-ui/apps/:shop
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
   * path  — must start with "/" (e.g. "/fetch-orders")
   * body  — JSON-serialisable payload, or omit for reads
   */
  call: (path: string, body?: unknown) => Promise<unknown>;
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
