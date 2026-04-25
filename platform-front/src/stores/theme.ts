import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "dark" | "light";

interface ThemeState {
  theme: Theme;
  toggle: () => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: "dark",
      toggle: () => {
        const next: Theme = get().theme === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        set({ theme: next });
      },
    }),
    {
      name: "new-one-two-theme",
      onRehydrateStorage: () => (state) => {
        // Apply the persisted theme to <html> immediately on load.
        if (state) {
          document.documentElement.setAttribute("data-theme", state.theme);
        }
      },
    },
  ),
);

/** Call once at app startup to sync the DOM with the persisted value. */
export function initTheme() {
  const raw = localStorage.getItem("new-one-two-theme");
  const theme: Theme = raw ? (JSON.parse(raw)?.state?.theme ?? "dark") : "dark";
  document.documentElement.setAttribute("data-theme", theme);
}
