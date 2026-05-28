/**
 * Storefront widget SDK contract.
 *
 * This is the GENERATION-TIME type surface used to type-check
 * `scaffold/widget/widget.ts` (see w_coding_agent/tsc_runner.py — UI pass).
 * It mirrors `platform-ai/context/component_rules/storefront.md`, which is
 * the prose spec the coding agent follows.
 *
 * Single source of truth caveat: the real storefront host runtime (the App
 * Block code that calls `mount(container, host)`) is not yet typed in the
 * repo. When that runtime lands or changes, this file MUST be updated to
 * match it, or the type-check gives false confidence. Admin has its own
 * canonical type at platform-shopify-admin/src/types.ts; this is the
 * storefront equivalent until the runtime owns one.
 */

export interface HostContext {
  /** Shop domain, e.g. "example.myshopify.com". */
  shop: string;
  /** Logged-in customer's id, or null for guests. */
  customerId: string | null;
}

export interface Host {
  context: HostContext;

  /**
   * POST to the app's platform backend.
   * `path` MUST be one of `httpRoutes.widget` in app.json; `body` MUST
   * match that route's requestShape from contracts.ts. The result is the
   * route's responseShape — cast it to the contracts.ts response type
   * (the SDK cannot know it, so it is typed `unknown`).
   */
  call: (path: string, body?: unknown) => Promise<unknown>;

  /** Read named inputs from a <form> into a plain object (use on submit). */
  getFormData: (form: HTMLFormElement) => Record<string, unknown>;

  /**
   * Public Shopify Ajax API (same-origin, no auth). Read endpoints take
   * just the path; write endpoints (e.g. "/cart/add.js") take a JSON body.
   * The result shape comes from the Ajax catalog — cast it; the SDK types
   * it `unknown`.
   */
  storefront: (relativePath: string, body?: unknown) => Promise<unknown>;
}

/** Shape expected from a dynamically-loaded widget module. */
export interface WidgetModule {
  mount: (container: HTMLElement, host: Host) => void;
  unmount?: (container: HTMLElement) => void;
}
