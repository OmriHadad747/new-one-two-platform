import { useEffect, useState, useCallback } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { NavMenu, TitleBar } from "@shopify/app-bridge-react";
import { Page, Spinner, EmptyState, Banner, BlockStack, InlineStack, Text } from "@shopify/polaris";
import type {
  AdminApp,
  AdminBridge,
  PickedResource,
  PickResourceOptions,
} from "../types.js";
import { ModuleFrame } from "./ModuleFrame.js";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

interface Props {
  shop: string;
}

export function AdminShell({ shop }: Props) {
  const shopify = useAppBridge();

  const [apps, setApps] = useState<AdminApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Shop metadata used by every module's bridge.context for currency /
  // locale-aware formatting. Lives at this level (not per-module) so a
  // single fetch services every module the merchant might open.
  // Defaults are USD / en-US so renders are non-blocking on first paint
  // and degrade gracefully if the metadata endpoint is unavailable.
  const [shopMeta, setShopMeta] = useState<{ currency: string; locale: string }>({
    currency: "USD",
    locale: "en-US",
  });

  // Active app driven by URL param so NavMenu links work correctly
  const [activeAppId, setActiveAppId] = useState<string>(() => {
    return new URLSearchParams(window.location.search).get("appId") ?? "";
  });

  // ── Load apps list ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!shop) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/admin/apps?shop=${encodeURIComponent(shop)}`);
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const data = (await res.json()) as AdminApp[];
        if (cancelled) return;
        setApps(data);
        // Auto-select first app if none is active or the active one is gone
        setActiveAppId((prev) => {
          if (prev && data.some((a) => a.id === prev)) return prev;
          return data[0]?.id ?? "";
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [shop]);

  // ── Shop metadata fetch (currency + locale) ───────────────────────────────
  // Drives `bridge.context.currency` / `bridge.context.locale` so admin
  // modules can format money / dates with `Intl.NumberFormat`.
  //
  // TODO(backend): implement `GET /api/admin/shop?shop=<domain>` returning
  // `{ currency: string, locale: string }`. The platform-back handler
  // should pull these from the cached Shopify shop record
  // (`shop { currencyCode primaryLocale }` GraphQL query, refreshed on
  // shop/update webhook). Until the endpoint exists, defaults (USD /
  // en-US) keep modules rendering — they format with the merchant's
  // domestic conventions on first launch and update on next reload.

  useEffect(() => {
    if (!shop) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/shop?shop=${encodeURIComponent(shop)}`);
        if (!res.ok) return; // endpoint may not exist yet — keep defaults
        const data = (await res.json()) as { currency?: string; locale?: string };
        if (cancelled) return;
        if (data.currency && data.locale) {
          setShopMeta({ currency: data.currency, locale: data.locale });
        }
      } catch {
        // Network error — keep defaults. No banner; module-level
        // formatting still works, merchant just sees USD instead of
        // their primary currency until the endpoint comes online.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shop]);

  // ── Bridge factory ────────────────────────────────────────────────────────
  // A new bridge is created per activeAppId so it's always bound to the correct app.

  const makeBridge = useCallback(
    (appId: string): AdminBridge => ({
      context: { shop, appId, currency: shopMeta.currency, locale: shopMeta.locale },

      call: async (path: string, args?: unknown) => {
        const token = await shopify.idToken();
        // Shop identity now travels inside the App Bridge session JWT —
        // the edge reads claims.shop server-side rather than trusting a
        // URL segment. `path` must start with "/" per the bridge contract.
        //
        // Method dispatch: the served panel bundle has
        // `window.__PLATFORM_CATALOG__ = [...]` prepended by platform-back's
        // bundle-storage saver. We look up the architect-declared method
        // per path and route GET-with-querystring or POST-with-body
        // accordingly. Default POST when the manifest is absent or the
        // path isn't listed (matches the pre-method-aware-SDK behaviour
        // and works for routes that bypass the catalog).
        const win = window as Window & {
          __PLATFORM_CATALOG__?: { path: string; method: "GET" | "POST" }[];
        };
        const catalog = win.__PLATFORM_CATALOG__ ?? [];
        const entry = catalog.find((e) => e?.path === path);
        const method = (entry?.method ?? "POST").toUpperCase();

        let url = `${API_BASE}/admin/${encodeURIComponent(appId)}${path}`;
        let body: string | undefined;

        if (method === "GET") {
          if (args && typeof args === "object") {
            const qs = new URLSearchParams();
            for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
              if (v === undefined || v === null) continue;
              qs.append(k, String(v));
            }
            const s = qs.toString();
            if (s) url += `?${s}`;
          }
        } else {
          body = JSON.stringify(args ?? {});
        }

        // Only set Content-Type when there's a body — sending it on GET is
        // harmless but non-pristine and triggers an unnecessary CORS preflight
        // in some browser configurations.
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
        };
        if (body !== undefined) {
          headers["Content-Type"] = "application/json";
        }
        const res = await fetch(url, { method, headers, body });
        if (!res.ok) {
          const detail = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(
            detail.error ?? `${method} ${path} failed with status ${res.status}`,
          );
        }
        return res.json();
      },

      notify: (message: string, variant?: "success" | "error") => {
        shopify.toast.show(message, { isError: variant === "error" });
      },

      // Native ResourcePicker — opens Shopify's own picker UI for
      // products / collections / customers / variants. Far better UX
      // (and zero Admin GraphQL spend) than a custom search field.
      // Returns the merchant's selection, or null if they cancelled.
      pickResource: async (options: PickResourceOptions) => {
        // `shopify.resourcePicker` returns the selection on confirm,
        // `undefined` on cancel. We normalise cancel → null so admin
        // modules can branch with a single `if (!selection)` check.
        const result = (await shopify.resourcePicker({
          type: options.type,
          multiple: options.multiple,
          selectionIds: options.selectionIds,
          query: options.query,
        })) as PickedResource[] | undefined;
        return result ?? null;
      },

      // Native Contextual Save Bar — Shopify's floating "You have
      // unsaved changes" affordance. The `id` parameter is forwarded
      // verbatim so admin modules that own multiple save bars (rare)
      // can address each one; omitting it uses the default save bar.
      saveBar: {
        show: (id?: string) => {
          if (id) shopify.saveBar.show(id);
          else shopify.saveBar.show("save-bar");
        },
        hide: (id?: string) => {
          if (id) shopify.saveBar.hide(id);
          else shopify.saveBar.hide("save-bar");
        },
      },
    }),
    [shop, shopify, shopMeta.currency, shopMeta.locale]
  );

  // ── Derived state ─────────────────────────────────────────────────────────

  const activeApp = apps.find((a) => a.id === activeAppId) ?? null;

  // ── Render ────────────────────────────────────────────────────────────────

  if (!shop) {
    return (
      <Page>
        <Banner tone="critical" title="Missing shop context">
          <Text as="p" variant="bodyMd">
            This app must be opened from within a Shopify Admin. The{" "}
            <code>shop</code> parameter was not present.
          </Text>
        </Banner>
      </Page>
    );
  }

  if (loading) {
    return (
      <Page>
        <BlockStack gap="400" inlineAlign="center">
          <InlineStack gap="300" align="center" blockAlign="center">
            <Spinner size="large" />
            <Text as="p" variant="bodyMd" tone="subdued">
              Loading your apps…
            </Text>
          </InlineStack>
        </BlockStack>
      </Page>
    );
  }

  if (error) {
    return (
      <Page>
        <Banner tone="critical" title="Failed to load apps">
          <Text as="p" variant="bodyMd">{error}</Text>
        </Banner>
      </Page>
    );
  }

  if (apps.length === 0) {
    return (
      <>
        <TitleBar title="New One Two" />
        <Page>
          <EmptyState
            heading="No apps with an Admin UI yet"
            image=""
          >
            <Text as="p" variant="bodyMd">
              Generate a Category B or D app in your{" "}
              <a href="https://app.new-one-two.com" target="_blank" rel="noreferrer">
                New One Two dashboard
              </a>{" "}
              and it will appear here automatically.
            </Text>
          </EmptyState>
        </Page>
      </>
    );
  }

  return (
    <>
      {/* Shopify Admin title bar — shows breadcrumb with current app name */}
      <TitleBar title={activeApp?.name ?? "New One Two"} />

      {/* Shopify Admin left-nav entries — one link per platform app */}
      <NavMenu>
        {apps.map((app) => (
          <a
            key={app.id}
            href={buildNavUrl(app.id)}
            rel="noopener noreferrer"
          >
            {app.name}
          </a>
        ))}
      </NavMenu>

      {/* Module container — fills the full page below Admin's title bar */}
      <Page fullWidth>
        {activeApp ? (
          <ModuleFrame
            key={activeApp.id}
            app={activeApp}
            bridge={makeBridge(activeApp.id)}
          />
        ) : null}
      </Page>
    </>
  );
}

/**
 * Build the href for a NavMenu item, preserving host/shop so App Bridge
 * stays initialised after navigation.
 */
function buildNavUrl(appId: string): string {
  const params = new URLSearchParams(window.location.search);
  params.set("appId", appId);
  return `/?${params.toString()}`;
}
