import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider as PolarisProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";
import App from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <PolarisProvider i18n={enTranslations}>
      <App />
    </PolarisProvider>
  </StrictMode>
);
