import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Shell } from "@/components/layout/Shell";
import { RequireAuth } from "@/components/layout/RequireAuth";
import { WelcomePage } from "@/pages/WelcomePage";
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
  // Post-OAuth redirect target — fetches tenant, saves session, goes to "/"
  { path: "merchants/:tenantId", element: <MerchantCallbackPage /> },

  {
    element: <Shell />,
    children: [
      { path: "welcome", element: <WelcomePage /> },
      // ─── Authenticated routes (require session) ───────────────────────────────
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
