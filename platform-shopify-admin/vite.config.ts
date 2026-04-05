import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3003,
    // Allow ngrok and any other tunnel host — Vite blocks non-localhost hosts by default
    allowedHosts: true,
    // Shopify Admin loads the app in an iframe — allow cross-origin iframing
    headers: {
      "Content-Security-Policy": "",
    },
    proxy: {
      "/api": {
        target: "http://localhost:3002",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  preview: {
    port: 3003,
  },
  // Ensure consistent URL handling for App Bridge host param
  base: "/",
});
