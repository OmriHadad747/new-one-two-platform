# Supported Apps Catalog

This catalog details the specific Shopify app types supported by the platform during the MVP phase. It outlines how each app functions under the platform's architectural constraints (Widget ES module, TypeScript handler, Admin UI) and specifies the required services and Shopify infrastructure.

---

## Category A — Storefront + Backend
*Widgets on the storefront. Backend stores configuration or processes webhook events into the DB. No Admin UI required (configuration happens via the platform's dashboard or storefront theme editor).*

### 1. Announcement Bar
*   **Similar Real App:** Hextom: Free Shipping Bar / Quick Announcement Bar
*   **Flow:** The storefront widget queries the backend handler (via App Proxy) or uses App Block settings to fetch the current announcement text, link, and styling. The widget renders the bar at the top of the page.
*   **Services Needed:** `ctx.db` (to store configuration).
*   **Shopify Infra:** Storefront Widget (Theme App Extension), Backend Config API.

### 2. Trust & Payment Badges
*   **Similar Real App:** Trust Badge Master
*   **Flow:** The widget fetches the merchant's configured trust badges from the backend and renders them below the 'Add to Cart' button or on the checkout page to increase conversion rates.
*   **Services Needed:** `ctx.db`.
*   **Shopify Infra:** Storefront Widget.

### 3. Cookie Consent Banner
*   **Similar Real App:** GDPR Cookie Compiler
*   **Flow:** Widget displays a consent banner on the first visit. Consent state is stored in the browser's `localStorage` or a Shopify Customer Metafield (if logged in). Backend handles the configuration of the banner text and styling.
*   **Services Needed:** `ctx.db`.
*   **Shopify Infra:** Storefront Widget, LocalStorage / Customer Privacy API.

### 4. Flash Sale Countdown Timer
*   **Similar Real App:** Hurrify - Countdown Timer
*   **Flow:** Merchant configures an end date and target products in the backend. The widget polls the backend for the deadline, calculates the remaining time, and renders a live countdown timer on the product page.
*   **Services Needed:** `ctx.db`.
*   **Shopify Infra:** Storefront Widget.

### 5. Free Shipping Progress Bar
*   **Similar Real App:** Essential Free Shipping Bar
*   **Flow:** Widget listens to cart updates via the Storefront Cart API. It compares the current cart total against a threshold fetched from the backend, rendering a progress bar indicating how much more the customer needs to spend to unlock free shipping.
*   **Services Needed:** `ctx.db`.
*   **Shopify Infra:** Storefront Widget, Storefront Cart API (AJAX).

### 6. Recently Viewed Products
*   **Similar Real App:** Vitals: All-in-One Marketing
*   **Flow:** Widget tracks product page views in the browser's `localStorage`. When rendering the 'Recently Viewed' section, it queries the Storefront API for product details matching the stored IDs and displays a carousel.
*   **Services Needed:** `ctx.db` (for widget styling/config).
*   **Shopify Infra:** Storefront Widget, LocalStorage, Storefront API.

### 7. Social Proof Sales Pop
*   **Similar Real App:** Sales Pop up - Conversion Pro
*   **Flow:** The backend listens to Shopify `orders/create` webhooks and stores anonymized purchase data (e.g., "Someone in NY bought a T-Shirt"). The widget polls the backend periodically and displays toast notifications to live visitors.
*   **Services Needed:** `ctx.db`.
*   **Shopify Infra:** Storefront Widget, `orders/create` webhook.

### 8. Low Stock Urgency Badge
*   **Similar Real App:** Stock Sync / Urgency Bear
*   **Flow:** Backend listens to `inventory_levels/update` webhooks to keep an updated local cache of low-stock items. The widget on a product page fetches the stock level from the backend and displays a "Only X left in stock!" badge to drive urgency.
*   **Services Needed:** `ctx.db`.
*   **Shopify Infra:** Storefront Widget, `inventory_levels/update` webhook.

### 9. Wishlists
*   **Similar Real App:** Wishlist Plus
*   **Flow:** Customer clicks a "heart" icon (Storefront Widget). The widget sends an authenticated request to the backend handler (via App Proxy) containing the customer ID and product ID. The backend saves the relation in the database.
*   **Services Needed:** `ctx.db`.
*   **Shopify Infra:** Storefront Widget, App Proxy (for secure customer identification).

---

## Category B — Storefront + Backend + Admin UI
*Widgets on the storefront for customer interaction, plus a merchant-facing dashboard embedded in the Shopify Admin to manage data.*

### 10. Price Drop Alert
*   **Similar Real App:** Price Drop Alert
*   **Flow:** Customers use a Storefront Widget on a product page to subscribe to price drops for a specific variant. The backend stores the subscription. The backend listens to `products/update` webhooks; if a price decreases, it queries the DB and uses `ctx.services.email` to notify subscribers. The Admin UI allows merchants to view active subscriptions and tweak email templates.
*   **Services Needed:** `ctx.db`, `ctx.services.email`.
*   **Shopify Infra:** Storefront Widget, `products/update` webhook, Admin UI (React).

### 11. Back In Stock Notify Me (Category Ceiling)
*   **Similar Real App:** Back in Stock: Customer Alerts
*   **Flow:** Customers use a Storefront Widget to subscribe to out-of-stock variants. The backend stores the subscription. It listens to `inventory_levels/update` webhooks. When stock becomes positive, the handler retrieves all subscribers for that variant and fires off notifications via `ctx.services.email`. The Admin UI provides a dashboard of all subscribers, conversion rates, and manual trigger controls.
*   **Services Needed:** `ctx.db`, `ctx.services.email`.
*   **Shopify Infra:** Storefront Widget, `inventory_levels/update` webhook, Admin UI (React).

---

## Category C — Backend Only
*No storefront widget. Apps are either fully automatic (webhook or cron triggered) or admin-triggered via a Polaris UI.*

### 12. Order Thank You Email
*   **Similar Real App:** Klaviyo / Omnisend (for transactional emails)
*   **Flow:** Backend listens to `orders/create`. Upon receiving the webhook, the handler extracts the customer's email and order details, renders a template, and sends a customized thank-you message via `ctx.services.email`.
*   **Services Needed:** `ctx.db`, `ctx.services.email`.
*   **Shopify Infra:** `orders/create` webhook.

### 13. Abandoned Cart Recovery Email
*   **Similar Real App:** Privy
*   **Flow:** Backend listens to `checkouts/create` and `checkouts/update` webhooks. It schedules a delayed job (using `ctx.queue` or by storing a timestamp polled by cron). If no corresponding `orders/create` is received within the delay window, the handler sends a recovery email via `ctx.services.email`.
*   **Services Needed:** `ctx.db`, `ctx.services.email`, (Future: `ctx.queue`).
*   **Shopify Infra:** `checkouts/create` & `update` webhooks.

### 14. Post-Purchase Review Request
*   **Similar Real App:** Loox / Judge.me
*   **Flow:** Backend listens to `orders/fulfilled` webhooks. It stores a scheduled task in the DB for X days in the future. A daily cron job polls the DB and sends review request emails for mature orders via `ctx.services.email`.
*   **Services Needed:** `ctx.db`, `ctx.services.email`.
*   **Shopify Infra:** `orders/fulfilled` webhook, Cron scheduler.

### 15. Abandoned Cart Recovery SMS
*   **Similar Real App:** SMSBump
*   **Flow:** Similar to the Email recovery flow, but sends an SMS via `ctx.services.sms` to the customer's provided phone number.
*   **Services Needed:** `ctx.db`, `ctx.services.sms`.
*   **Shopify Infra:** `checkouts/update` webhook.

### 16. Low Inventory Email Digest
*   **Similar Real App:** Low Stock Alert
*   **Flow:** A daily cron job triggers the handler. The handler queries the Shopify Admin GraphQL API for inventory levels across all locations. It compiles a list of variants below a configured threshold and sends a digest to the merchant via `ctx.services.email`.
*   **Services Needed:** `ctx.db`, `ctx.services.email`.
*   **Shopify Infra:** Cron (daily), Admin API (`inventoryLevels`).

### 17. Bulk Order Tagger
*   **Similar Real App:** Auto Tags
*   **Flow:** The Admin UI allows the merchant to define rules (e.g., "If order > $100, tag 'VIP'"). The merchant clicks a "Run Now" button in the Admin UI, which triggers the handler (`trigger: "admin"`). The handler queries recent orders and applies the tag via the Admin API (`tagsAdd` mutation).
*   **Services Needed:** `ctx.db`.
*   **Shopify Infra:** Admin UI (React), Admin API (`tagsAdd` mutation).

### 18. Custom Order CSV Exporter
*   **Similar Real App:** EZ Exporter
*   **Flow:** The Admin UI provides a dashboard to select date ranges and fields. The merchant triggers an export. The handler queries the orders via the Admin API, formats the data using `ctx.services.csv`, and returns a download link or emails the CSV file.
*   **Services Needed:** `ctx.db`, `ctx.services.csv`.
*   **Shopify Infra:** Admin UI (React), Admin API (query orders).

### 19. Custom Packing Slip Printer
*   **Similar Real App:** Order Printer Pro
*   **Flow:** The merchant selects orders in the Admin UI and clicks "Print". The handler queries the order data, injects it into an HTML template, converts it to a PDF using `ctx.services.pdf`, and returns the file buffer to the frontend for printing/download.
*   **Services Needed:** `ctx.db`, `ctx.services.pdf`.
*   **Shopify Infra:** Admin UI (React), Admin API (query orders).

### 20. Image Alt Text Generator
*   **Similar Real App:** SEO Image Optimizer
*   **Flow:** Backend listens to `products/create` and `products/update` webhooks. It identifies images without alt text, sends the image URL to an AI service via `ctx.services.ai` (or `ctx.http`) to generate a descriptive alt text, and updates the Shopify product media via the Admin API.
*   **Services Needed:** `ctx.db`, `ctx.http` (or `ctx.services.ai`).
*   **Shopify Infra:** `products/create` & `update` webhooks, Admin API (`productUpdate`).

### 21. Image Size Optimizer (Category Ceiling)
*   **Similar Real App:** Crush.pics
*   **Flow:** Backend listens to `products/update` webhooks to detect new media. It downloads the image, sends it to an external compression API via `ctx.http`, temporarily stores the optimized image via `ctx.services.files`, and re-uploads it to replace the original image using the Shopify Admin API.
*   **Services Needed:** `ctx.db`, `ctx.http`, `ctx.services.files`.
*   **Shopify Infra:** `products/update` webhook, external HTTP API, Admin API (update media).