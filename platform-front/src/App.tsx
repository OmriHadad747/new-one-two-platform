import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Shell } from "@/components/layout/Shell";
import { RequireAuth } from "@/components/layout/RequireAuth";
import { LandingPage } from "@/pages/LandingPage";
import { InstallPage } from "@/pages/InstallPage";
import { MerchantCallbackPage } from "@/pages/MerchantCallbackPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { NewAppPage } from "@/pages/NewAppPage";
import { AppsPage } from "@/pages/AppsPage";
import { SettingsPage } from "@/pages/SettingsPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const router = createBrowserRouter([
  // ─── Public standalone pages (no sidebar shell) ──────────────────────────
  { path: "/", element: <LandingPage /> },
  { path: "/install", element: <InstallPage /> },

  // ─── Post-OAuth redirect — fetches tenant, saves session, goes to /app ───
  { path: "/merchants/:tenantId", element: <MerchantCallbackPage /> },

  // ─── Authenticated app shell ─────────────────────────────────────────────
  {
    path: "/app",
    element: <Shell />,
    children: [
      {
        element: <RequireAuth />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: "new", element: <NewAppPage /> },
          { path: "apps", element: <AppsPage /> },
          { path: "apps/:appId", element: <AppsPage /> },
          { path: "settings", element: <SettingsPage /> },
        ],
      },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
