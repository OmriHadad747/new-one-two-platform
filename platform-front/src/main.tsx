import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/globals.css";
import { initTheme } from "@/stores/theme";
import { captureTokenFromUrl } from "@/lib/auth";
import { App } from "./App";

initTheme();
captureTokenFromUrl();

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
