import { useEffect, useState, useCallback } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { NavMenu, TitleBar } from "@shopify/app-bridge-react";
import { Page, Spinner, EmptyState, Banner, BlockStack, InlineStack, Text } from "@shopify/polaris";
import type { AdminApp, AdminBridge } from "../types.js";
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

  // ── Bridge factory ────────────────────────────────────────────────────────
  // A new bridge is created per activeAppId so it's always bound to the correct app.

  const makeBridge = useCallback(
    (appId: string): AdminBridge => ({
      context: { shop, appId },

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
    }),
    [shop, shopify]
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
