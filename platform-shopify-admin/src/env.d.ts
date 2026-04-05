/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SHOPIFY_CLIENT_ID: string;
  /** Optional — if empty, API calls go through the /api proxy (dev default). */
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
