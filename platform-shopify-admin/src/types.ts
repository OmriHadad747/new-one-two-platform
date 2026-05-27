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
    /**
     * Shop currency in ISO 4217 form (e.g. "USD", "EUR", "JPY"). Used
     * by admin modules to format money fields with `Intl.NumberFormat`.
     * Required — every Shopify shop has a primary currency.
     */
    currency: string;
    /**
     * BCP-47 locale tag for the shop's primary language
     * (e.g. "en-US", "fr-CA", "ja-JP"). Drives `Intl.NumberFormat` /
     * `Intl.DateTimeFormat` / `Intl.RelativeTimeFormat` in admin
     * modules. Required — every Shopify shop has a primary locale.
     */
    locale: string;
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
  /**
   * Open Shopify Admin's native ResourcePicker so the merchant can
   * choose products / collections / customers / variants from their
   * live store. Wraps `shopify.resourcePicker()` from App Bridge.
   *
   * Returns the merchant's selection, or null if they cancelled.
   * Each selected resource is `{ id, title, ... }` — `id` is the
   * Shopify GraphQL gid (e.g. "gid://shopify/Product/123") and is
   * what the admin module persists. The full result shape passes
   * through App Bridge unchanged; cast it to the type that matches
   * the resource being picked.
   *
   * Prefer this over a custom search-and-pick UI for any Shopify
   * resource — it's the native experience merchants expect.
   */
  pickResource: (options: PickResourceOptions) => Promise<PickedResource[] | null>;
  /**
   * Native Shopify Admin Contextual Save Bar — the floating "You
   * have unsaved changes [Discard] [Save]" affordance. Wraps
   * `shopify.saveBar.*` from App Bridge.
   *
   * Pattern:
   *   - On any input change in a settings form, call show()
   *   - On Save click (the merchant's), wire your save handler via
   *     addEventListener("show"/"save"/"discard") on the saveBar
   *     event, or simply call hide() yourself after a successful
   *     bridge.call().
   *   - On successful save / discard, call hide()
   *
   * The save bar floats above the panel and survives merchant
   * navigation attempts — clicking another nav link prompts a
   * "leave with unsaved changes?" confirm.
   */
  saveBar: {
    show: (id?: string) => void;
    hide: (id?: string) => void;
  };
}

/**
 * Options accepted by `bridge.pickResource()`. Mirrors a useful
 * subset of `@shopify/app-bridge-react`'s ResourcePicker options —
 * what the admin agent will typically ask for.
 */
export interface PickResourceOptions {
  /**
   * Which kind of resource to pick. Maps 1:1 to Shopify's
   * ResourcePicker types.
   *
   * Note: `"customer"` is NOT supported by App Bridge's native
   * ResourcePicker — for customer selection, fall back to the
   * `resource_picker` shape with a /customers/search backend.
   */
  type: "product" | "collection" | "variant";
  /**
   * `true` for multi-select (no cap), a number for a multi-select
   * cap, `false`/omitted for single-select.
   */
  multiple?: boolean | number;
  /**
   * Optional pre-selected resources (re-opening the picker on an
   * already-edited record). Each id is a Shopify GraphQL gid.
   */
  selectionIds?: { id: string }[];
  /**
   * GraphQL filter query passed verbatim to Shopify (e.g.
   * `"status:active"`). Optional; absent means no filter.
   */
  query?: string;
}

/**
 * One resource entry from `bridge.pickResource()`.
 *
 * Intentionally tight (no catch-all index signature) so admin modules that
 * read a field the picker does not return — e.g. `p.product_id` on a picked
 * variant — fail type-checking at generation time instead of silently
 * writing a placeholder. When picking variants, Shopify returns the parent
 * PRODUCTS with the chosen variants nested under `variants`; a variant's own
 * gid is `variants[i].id`, and its product is the parent entry — there is no
 * `product_id` field. Need a field not listed here? Cast the entry to the
 * resource-specific shape at the call site rather than widening this type.
 */
export interface PickedResource {
  id: string;            // gid://shopify/<Type>/<numeric_id>
  title?: string;
  handle?: string;
  variants?: PickedResource[];
}

/**
 * Shape expected from a dynamically-loaded adminUiModule ES module.
 */
export interface AdminUiModule {
  mount: (container: HTMLElement, bridge: AdminBridge) => void;
  unmount?: (container: HTMLElement) => void;
}
