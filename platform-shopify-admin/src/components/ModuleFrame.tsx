import { useEffect, useRef, useState } from "react";
import { BlockStack, InlineStack, Spinner, Banner, Text } from "@shopify/polaris";
import type { AdminApp, AdminBridge, AdminUiModule } from "../types.js";
import { ADMIN_SHELL_CSS } from "../adminShellStyles.js";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

interface Props {
  app: AdminApp;
  bridge: AdminBridge;
}

type FrameState =
  | { phase: "loading" }
  | { phase: "mounted" }
  | { phase: "error"; message: string };

/**
 * Fetches and mounts an adminUiModule ES module into a DOM container.
 *
 * Lifecycle:
 * 1. GET /admin/:appId/panel.js  — fetch the module source
 * 2. Create a Blob URL and dynamically import() the ES module
 * 3. Call module.mount(container, bridge)
 * 4. On unmount / app switch: call module.unmount(container) if provided
 */
export function ModuleFrame({ app, bridge }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const moduleRef = useRef<AdminUiModule | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [state, setState] = useState<FrameState>({ phase: "loading" });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    async function load(container: HTMLDivElement) {
      setState({ phase: "loading" });

      // ── 1. Fetch the module source ──────────────────────────────────────
      let moduleSource: string;
      try {
        // The bundle is the same bytes for every shop that has this app
        // installed, so `shop` is no longer part of the URL — `appId` is
        // the primary key in the new standalone-app-backends model.
        const res = await fetch(
          `${API_BASE}/admin/${encodeURIComponent(app.id)}/panel.js`
        );
        if (!res.ok) {
          const msg = res.status === 404
            ? "Admin UI module not found — the app may still be deploying."
            : `Failed to fetch admin UI module (HTTP ${res.status}).`;
          if (!cancelled) setState({ phase: "error", message: msg });
          return;
        }
        moduleSource = await res.text();
      } catch (err) {
        if (!cancelled) {
          setState({
            phase: "error",
            message: `Network error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }

      if (cancelled) return;

      // ── 2. Create Blob URL and import the ES module ─────────────────────
      // Blob import is the only way to dynamically import an arbitrary JS string
      // as a proper ES module (eval/Function can't handle import/export).
      let mod: AdminUiModule;
      let blobUrl: string | null = null;
      try {
        blobUrl = URL.createObjectURL(
          new Blob([moduleSource], { type: "application/javascript" })
        );
        blobUrlRef.current = blobUrl;
        const imported = (await import(/* @vite-ignore */ blobUrl)) as AdminUiModule;
        if (typeof imported.mount !== "function") {
          throw new Error("Module does not export a `mount` function.");
        }
        mod = imported;
      } catch (err) {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        blobUrlRef.current = null;
        if (!cancelled) {
          setState({
            phase: "error",
            message: `Failed to load admin UI module: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }

      if (cancelled) {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        blobUrlRef.current = null;
        return;
      }

      // ── 3. Inject shared base styles into <head> (not container) then mount ─
      // Styles must live in <head> so that generated mount() functions that
      // call `container.innerHTML = '…'` don't wipe them.
      try {
        if (!document.head.querySelector("[data-admin-shell='base']")) {
          const sharedStyle = document.createElement("style");
          sharedStyle.setAttribute("data-admin-shell", "base");
          sharedStyle.textContent = ADMIN_SHELL_CSS;
          document.head.appendChild(sharedStyle);
        }
        mod.mount(container, bridge);
        moduleRef.current = mod;
        setState({ phase: "mounted" });
      } catch (err) {
        if (!cancelled) {
          setState({
            phase: "error",
            message: `Module mount() threw: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    void load(container);

    return () => {
      cancelled = true;
      // Unmount the active module and release the Blob URL
      const mod = moduleRef.current;
      if (mod?.unmount && container) {
        try {
          mod.unmount(container);
        } catch {
          // Best-effort cleanup; swallow errors on unmount
        }
      }
      moduleRef.current = null;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [app.id, bridge]);

  return (
    <div style={{ minHeight: "100%" }}>
      {state.phase === "loading" && (
        <div style={{ padding: "2rem" }}>
          <BlockStack gap="400" inlineAlign="center">
            <InlineStack gap="300" align="center" blockAlign="center">
              <Spinner size="large" />
              <Text as="p" variant="bodyMd" tone="subdued">
                Loading {app.name}…
              </Text>
            </InlineStack>
          </BlockStack>
        </div>
      )}

      {state.phase === "error" && (
        <div style={{ padding: "2rem" }}>
          <Banner tone="critical" title={`Could not load ${app.name}`}>
            <Text as="p" variant="bodyMd">{state.message}</Text>
          </Banner>
        </div>
      )}

      {/* The module renders into this div regardless of phase so it exists
          in the DOM before mount() is called. Hidden until mounted. */}
      <div
        ref={containerRef}
        style={{ display: state.phase === "mounted" ? "block" : "none" }}
      />
    </div>
  );
}
